import { EventEmitter } from 'node:events'
import { Room } from './room.js'
import { parseRoom, sanitize } from './protocol.js'
import { notify as defaultNotify } from './launcher.js'
import { loadConfig as readConfig } from './config.js'
import { adapter, triggerFor, focusSession } from './harness/index.js'
import { SessionMap, sessionKey, fromHookMessage, byTrigger, modesOf } from './harness/event.js'
import { pidAlive } from './harness/util.js'

const MAX_MESSAGES = 400
const RUNNING = new Set(['running', 'needed'])
// sessions[].harness, when the hook said which harness (hooks from before adapters don't).
const harnessOf = (s) => s.harness ? { harness: s.harness } : {}
// How long an agent that ended its turn may stay quiet before it's done (`idle`).
export const IDLE_MS = 45000
// The attention queue: urgent first, and bounded (finished items stay until handled).
const ATTENTION_ORDER = ['blocked', 'failed', 'finished']
const MAX_ATTENTION = 50
const harnessName = (id) => adapter(id || 'copilot')?.name ?? id
const ANSI16 = ['000000', '800000', '008000', '808000', '000080', '800080', '008080', 'c0c0c0', '808080', 'ff0000', '00ff00', 'ffff00', '0000ff', 'ff00ff', '00ffff', 'ffffff']

// xterm 256-color index (what the TUI uses) → "#rrggbb" for GUI clients.
export function hexColor (n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null
  if (n < 16) return '#' + ANSI16[n]
  const hex = (v) => v.toString(16).padStart(2, '0')
  if (n >= 232) return '#' + hex(8 + (n - 232) * 10).repeat(3)
  const level = (v) => v ? 55 + v * 40 : 0
  const i = n - 16
  return '#' + hex(level(Math.floor(i / 36))) + hex(level(Math.floor(i / 6) % 6)) + hex(level(i % 6))
}

/**
 * Brain of the UI process (the daemon, or the terminal UI). It does two separate things:
 *
 * - The lounge: from start() to shutdown() you're in the configured room, unless `lounge` is
 *   `off`. reload() and the `lounge` command switch rooms, or join or leave, right away.
 * - Your agents: it tracks the sessions that work on their own (SessionEvents from hooks, plus
 *   each adapter's session log and fallback observer), keyed `${harness}:${sid}`. Each one that's
 *   blocked on you, finished or failed gets an item in the attention queue, which stays until
 *   handled or dismissed, and when the last of them stops, a notification says so.
 *
 * phase: room (in the lounge's room) | lounge (not in a room: `lounge` is off)
 */
export class Controller extends EventEmitter {
  constructor ({
    identity, config, daemon = false, bootstrap, roomOpts = {},
    focus = focusSession, notify = defaultNotify, watchLogs = true, requestLingerMs = 20000,
    loadConfig = null, saveConfig = null, idleMs = IDLE_MS,
    pidCheckMs = 5000
  }) {
    super()
    this.idleMs = idleMs
    this.pidCheckMs = pidCheckMs
    this.requestLingerMs = requestLingerMs
    this.identity = identity
    this.config = config
    // config.json, read again on reload() and written by the `lounge` command. Without them
    // (tests), `config` is all there is.
    this.loadConfig = loadConfig
    this.saveConfig = saveConfig
    this.daemon = daemon
    this.bootstrap = bootstrap
    this.roomOpts = roomOpts
    this.focus = focus
    this.notifyFn = notify
    this.watchLogs = watchLogs
    this.roomInfo = parseRoom(config.room)
    this.sessions = new SessionMap()
    this.finished = new Map()
    // Per session key, when its newest event with an `at` happened.
    this.lastAt = new Map()
    this.messages = []
    this.msgSeq = 0
    this.room = null
    // Rooms on their way out: the next room joins once they've left.
    this.leaving = Promise.resolve()
    this.lastFinished = null
    // At most one item per session (its latest), keyed like sessions.
    this.attention = new Map()
    this.attentionSeq = 0
    // The most agents at work at once since none were: more than one, and the notification when
    // they've all stopped counts what's waiting.
    this.agentPeak = 0
  }

  get phase () {
    return this.room ? 'room' : 'lounge'
  }

  get lounge () {
    return this.config.lounge === 'off' ? 'off' : 'on'
  }

  // --- inputs ----------------------------------------------------------------

  handle (msg) {
    if (!msg || typeof msg !== 'object') return { ok: false }
    if (msg.type === 'reload') return this.reload()
    if (msg.type === 'ping') return { pong: true, phase: this.phase, daemon: this.daemon, pid: process.pid }
    if (msg.type === 'status') return { phase: this.phase, lounge: this.lounge, room: this.roomInfo.display, sessions: [...this.sessions.values()].map(s => ({ sid: s.sid, state: s.state, cwd: s.cwd, ...harnessOf(s) })) }
    if (msg.type === 'hook') return { tracked: this._onHook(msg) }
    return { ok: false }
  }

  // Does a session in these modes work on its own, under the trigger config right now?
  // (Hooks read config.json on every call; so does this.)
  _autonomy (harness, modes) {
    return byTrigger(modes, triggerFor((this.loadConfig || readConfig)(), harness || 'copilot'))
  }

  _onHook (msg) {
    const ev = fromHookMessage(msg)
    if (!ev) return false
    // Hook messages from before adapters carry only Copilot's mode.
    if (!ev.autonomy) ev.autonomy = this._autonomy(ev.harness, modesOf(ev))
    const key = sessionKey(ev.harness, ev.sid)
    // Events that can overtake each other on the way here (opencode's plugin runs a hook per
    // event) say when they happened: one from before the last one seen for its session, finished
    // or not, is stale.
    if (ev.at) {
      const last = this.lastAt.get(key)
      if (last && ev.at < last) return this.sessions.has(key)
      this.lastAt.delete(key)
      this.lastAt.set(key, ev.at)
      if (this.lastAt.size > 500) this.lastAt.delete(this.lastAt.keys().next().value)
    }
    // At work again, or you're chatting with it: its question or its last result is handled.
    if (ev.kind === 'activity') this._resumeAttention(key)
    let s = this.sessions.get(key)
    if (!s) {
      if (!(ev.autonomy === 'autonomous' && (ev.kind === 'activity' || ev.kind === 'request'))) return false
      s = this._track(ev)
    }
    if (ev.harness) s.harness = ev.harness
    if (ev.via === 'scan') s.adopted = true
    else s.hooked = true
    if (ev.cwd) s.cwd = ev.cwd
    if (ev.origin && (ev.origin.tmuxPane || ev.origin.bundleId || ev.origin.termProgram)) s.origin = ev.origin
    if (ev.pid && ev.pid !== s.pid) this._watchPid(s, ev.pid)
    const leftAutopilot = ev.autonomy === 'interactive'
    switch (ev.kind) {
      case 'activity':
        if (leftAutopilot) this._finish(s, 'mode')
        else this._run(s, 'running', null)
        break
      case 'request': {
        if (leftAutopilot) { this._finish(s, 'mode'); break }
        // preToolUse(ask_user) and the elicitation notification describe the same question;
        // keep whichever text is richer (the former includes the choices). A request with no
        // text (Claude's "needs your permission", seconds after the PermissionRequest) keeps
        // the open one's.
        let req = ev.request || { title: 'Copilot needs you', message: '' }
        const prev = s.request
        if (prev && (Date.now() - prev.at < 5000 || (!req.message && !prev.resolved)) && (prev.message || '').startsWith(req.message || '')) req = { ...req, message: prev.message }
        this._attend(s, 'blocked', req.title || `${harnessName(s.harness)} needs you`, req.message)
        this._run(s, 'needed', req)
        break
      }
      case 'complete':
        this._finish(s, 'complete', ev.summary)
        break
      case 'failed':
        if (leftAutopilot || ev.stopped) { this._finish(s, leftAutopilot ? 'mode' : 'failed', ev.summary); break }
        // It works past the error (a refused tool call): the item stays until you dismiss it.
        this._attend(s, 'failed', `${harnessName(s.harness)} ran into a problem`, ev.summary, { sticky: true })
        this._run(s, 'running', null)
        break
      case 'idle':
        if (leftAutopilot) this._finish(s, 'mode')
        else {
          if (ev.summary) s.summary = sanitize(ev.summary, 2000)
          this._armIdle(s)
        }
        break
      case 'waiting':
        // Done with its turn and waiting at its prompt: the agent no longer works on its own.
        this._finish(s, leftAutopilot ? 'mode' : 'idle', ev.summary)
        break
      case 'end':
        this._finish(s, 'end', ev.summary)
        break
    }
    // Start tailing only now, replaying lifecycle events logged since this hook fired
    // (e.g. a task_complete logged before this hook reached the core).
    if (s.log && !s.log.timer && this.sessions.get(s.key) === s) s.log.start({ since: ev.ts })
    return true
  }

  _track (ev) {
    const key = sessionKey(ev.harness, ev.sid)
    const s = { key, sid: ev.sid, harness: ev.harness || null, cwd: ev.cwd, origin: ev.origin, state: 'idle', request: null, idleTimer: null, summary: '', doneAt: 0, log: null }
    this.sessions.set(key, s)
    // The adapter's session log (Copilot's events.jsonl) reports what no hook does.
    const a = adapter(s.harness || 'copilot')
    if (this.watchLogs && a?.follow) {
      s.log = a.follow(s.sid)
      s.log.on('task-complete', ({ summary }) => this._finish(s, 'complete', summary))
      s.log.on('abort', () => this._finish(s, 'abort'))
      s.log.on('shutdown', () => this._finish(s, 'end'))
      s.log.on('mode', (m) => { if (this._autonomy(s.harness, [m]) !== 'autonomous') this._finish(s, 'mode') })
      s.log.on('activity', () => { if (RUNNING.has(s.state)) this._clearIdle(s) })
    }
    return s
  }

  // Some harnesses' processes die without a word (opencode on Ctrl+C): their events say which
  // process the session lives in, and the session ends once that's gone.
  _watchPid (s, pid) {
    clearInterval(s.pidTimer)
    s.pid = pid
    s.pidTimer = setInterval(() => {
      if (this.sessions.get(s.key) !== s) clearInterval(s.pidTimer)
      else if (!pidAlive(s.pid)) this._finish(s, 'end')
    }, this.pidCheckMs)
    s.pidTimer.unref?.()
  }

  _run (s, state, request) {
    this._clearIdle(s)
    s.state = state
    if (request) {
      clearTimeout(s.reqTimer)
      s.request = { ...request, at: Date.now(), resolved: false }
      // Autopilot answers questions on its own within milliseconds; keep the modal up
      // long enough to read, then let it go once the agent has moved on.
      const linger = () => {
        s.reqTimer = setTimeout(() => {
          if (!s.request) return
          if (s.request.resolved) { s.request = null; this._changed() } else linger()
        }, this.requestLingerMs)
        s.reqTimer.unref?.()
      }
      linger()
    } else if (s.request) {
      if (Date.now() - s.request.at >= this.requestLingerMs) s.request = null
      else s.request.resolved = true
    }
    this._update()
  }

  _clearIdle (s) {
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = null
  }

  // agentStop without task_complete: the agent may be waiting on the user, or autopilot
  // may continue. Wait a bit; the adapter can keep it (Copilot: an active objective).
  _armIdle (s) {
    this._clearIdle(s)
    if (!RUNNING.has(s.state)) return
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null
      if (!RUNNING.has(s.state)) return
      if (adapter(s.harness || 'copilot')?.continues?.(s)) return this._armIdle(s)
      this._finish(s, 'idle')
    }, this.idleMs)
    s.idleTimer.unref?.()
  }

  // Finished sessions are retired; if the same session works on its own again, hooks re-track it.
  _finish (s, reason, summary) {
    if (summary) s.summary = sanitize(summary, 2000)
    this._clearIdle(s)
    clearTimeout(s.reqTimer)
    clearInterval(s.pidTimer)
    s.log?.stop()
    if (this.sessions.get(s.key) === s) this.sessions.delete(s.key)
    this.finished.set(s.key, Date.now())
    if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value)
    if (s.state === 'done' || s.state === 'idle') { s.state = 'done'; return }
    s.state = 'done'
    s.request = null
    s.reason = reason
    s.doneAt = Date.now()
    this.lastFinished = s
    this._attendEnd(s, reason)
    this._update()
  }

  /**
   * Pick up autopilot sessions that never call our hooks (say, their Copilot process started
   * before `autochat setup`), from an adapter's fallback observer: `live` is everything it sees
   * of `harness` right now (Copilot: liveSessions()). Hooks stay authoritative for sessions
   * that have them; adopted ones are released when they go idle or exit.
   */
  adopt (live, harness = 'copilot') {
    const seen = new Set()
    for (const l of live) {
      const key = sessionKey(harness, l.sid)
      seen.add(key)
      const s = this.sessions.get(key)
      if (s) {
        if (s.adopted && !s.hooked && RUNNING.has(s.state) && !l.running) {
          // Let the log report *why* it stopped (task_complete + summary, abort, mode) first.
          s.log?.poll()
          if (RUNNING.has(s.state)) this._finish(s, this._autonomy(harness, l.mode ? [l.mode] : []) === 'autonomous' ? 'idle' : 'mode')
        }
        continue
      }
      if (!l.running) continue
      const done = this.finished.get(key)
      if (done && l.lastStart <= done) continue
      this.handle({ type: 'hook', via: 'scan', event: 'scan', harness, kind: 'activity', autonomy: 'autonomous', mode: l.mode, sessionId: l.sid, cwd: l.cwd, ts: l.scannedAt })
    }
    for (const s of this.sessions.values()) {
      if (s.adopted && !s.hooked && RUNNING.has(s.state) && (s.harness || 'copilot') === harness && !seen.has(s.key)) this._finish(s, 'end')
    }
  }

  // --- the attention queue -------------------------------------------------------

  /** Puts a session's latest item in the queue, in place of what it had there. */
  _attend (s, kind, title, summary, { sticky = false } = {}) {
    const prev = this.attention.get(s.key)
    const same = prev?.kind === kind
    if (!same) this.attention.delete(s.key)
    this.attention.set(s.key, {
      id: same ? prev.id : String(++this.attentionSeq),
      key: s.key,
      harness: s.harness || 'copilot',
      sid: s.sid,
      cwd: sanitize(s.cwd, 300) || null,
      origin: s.origin,
      kind,
      title: sanitize(title, 120),
      summary: sanitize(summary, 600) || null,
      at: same ? prev.at : Date.now(),
      sticky
    })
    for (const [key, a] of this.attention) {
      if (this.attention.size <= MAX_ATTENTION) break
      if (a.kind !== 'blocked') this.attention.delete(key)
    }
    this._changed()
  }

  // The run ended: what's left for you is its result or its error. Switching it out of autopilot
  // means you took over, so there's nothing to come back to.
  _attendEnd (s, reason) {
    const name = harnessName(s.harness)
    if (reason === 'mode') this._dropAttention(s.key)
    else if (reason === 'abort') this._attend(s, 'failed', `${name} was interrupted`, s.summary)
    else if (reason === 'failed') this._attend(s, 'failed', `${name} stopped on an error`, s.summary)
    else this._attend(s, 'finished', reason === 'idle' ? `${name} is waiting for you` : reason === 'end' ? `${name} session ended` : `${name} finished`, s.summary)
  }

  _dropAttention (key) {
    if (this.attention.delete(key)) this._changed()
  }

  // A failure it worked past stays until you dismiss it; everything else is handled once it's at it again.
  _resumeAttention (key) {
    const a = this.attention.get(key)
    if (a && !a.sticky) this._dropAttention(key)
  }

  /** The queue, urgent first (blocked, failed, finished), oldest first within each. */
  attentionItems () {
    return [...this.attention.values()].sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind) || a.at - b.at)
  }

  _attentionItem (id) {
    for (const a of this.attention.values()) if (a.id === String(id)) return a
    return null
  }

  // Focuses the agent behind an item. Going to look handles a result or an error; a blocked agent
  // stays in the queue until it carries on.
  jumpTo (id) {
    const a = this._attentionItem(id)
    if (!a) return false
    this.focus(this.sessions.get(a.key)?.origin ?? a.origin, a.harness)
    if (a.kind !== 'blocked') this._dropAttention(a.key)
    return true
  }

  dismissAttention (id) {
    const a = this._attentionItem(id)
    if (a) this._dropAttention(a.key)
    return !!a
  }

  // --- your agents -------------------------------------------------------------

  runningSessions () {
    return [...this.sessions.values()].filter(s => RUNNING.has(s.state))
  }

  currentRequest () {
    const s = this.runningSessions().find(x => x.state === 'needed' && x.request) || this.runningSessions().find(x => x.request)
    return s ? { ...s.request, cwd: s.cwd, sid: s.sid, key: s.key } : null
  }

  dismissRequest () {
    for (const s of this.sessions.values()) { s.request = null; clearTimeout(s.reqTimer) }
    this._changed()
  }

  _update () {
    const running = this.runningSessions().length
    if (running) this.agentPeak = Math.max(this.agentPeak, running)
    else if (this.agentPeak) this._allStopped()
    this._changed()
  }

  // The last agent at work stopped: say so, and how many of them need you if several were at it.
  _allStopped () {
    const s = this.lastFinished
    const waiting = this.attention.size
    this.notifyFn('autochat', this.agentPeak > 1 && waiting
      ? `${waiting === 1 ? 'One of your agents needs' : `${waiting} of your agents need`} you.`
      : 'Your copilot ' + (s?.reason === 'complete' ? 'finished.' : 'needs you.'))
    this.agentPeak = 0
  }

  jumpToCopilot () {
    const req = this.currentRequest()
    const s = (req && this.sessions.get(req.key)) || this.runningSessions()[0] || this.lastFinished
    if (s) this.focus(s.origin, s.harness)
  }

  // --- the lounge --------------------------------------------------------------

  /** Joins the configured room, unless `lounge` is off. */
  start () {
    this._apply()
  }

  // `autochat config`, `join`, `host` and `leave` changed config.json: switch rooms, or join or
  // leave, right away.
  reload () {
    if (this.loadConfig) this.config = this.loadConfig()
    this._apply()
    return { reloaded: true, room: this.roomInfo.display }
  }

  /** In or out of the lounge (`autochat config lounge`), saved to config.json. */
  setLounge (on) {
    const lounge = on ? 'on' : 'off'
    this.config = this.saveConfig ? this.saveConfig({ lounge }) : { ...this.config, lounge }
    this._apply()
  }

  // Be in the configured room, or in none when the lounge is off.
  _apply () {
    try { this.roomInfo = parseRoom(this.config.room) } catch {}
    if (this.room && (this.lounge === 'off' || this.room.room.code !== this.roomInfo.code)) this._leaveRoom()
    if (this.lounge === 'on' && !this.room) this._enterRoom()
    this._changed()
  }

  _enterRoom () {
    this.messages = []
    const room = new Room({ room: this.roomInfo, identity: this.identity, bootstrap: this.bootstrap, announce: this.config.announce, ...this.roomOpts })
    this.room = room
    // A room that's on its way out says nothing more.
    const on = (event, fn) => room.on(event, (...args) => { if (room === this.room) fn(...args) })
    on('change', () => this._changed())
    on('peers', () => this._changed())
    on('chat', (m) => this._push({ kind: 'chat', ...m }))
    on('inst', (inst, { created, wasHost }) => {
      if (created) this.sys("you're the host. this room lives while anyone is in it")
      else if (wasHost) this.sys(`found an older room, merging. ${room.hostHandle} is the host`)
      else this.sys(`joined a live room hosted by ${room.hostHandle}`)
    })
    on('host', (h) => this.sys(h.text, h))
    on('member-join', (m) => this.sys(`${m.handle} joined`, m))
    on('member-leave', (m, reason) => this.sys(`${m.handle} ${reason === 'timeout' ? 'faded away' : 'left'}`, m))
    this.sys(`entering ${this.roomInfo.display}, looking for others…`)
    // Leave the old room cleanly before joining the next one.
    this.leaving.then(() => { if (room === this.room) return room.join() }).catch((err) => this.sys('network error: ' + err.message))
  }

  _leaveRoom () {
    const room = this.room
    this.room = null
    this.leaving = Promise.all([this.leaving, room.leave('left').catch(() => {})])
  }

  say (text) {
    return this.room ? this.room.say(text) : false
  }

  sys (text, member) {
    this._push({ kind: 'sys', text, ts: Date.now(), color: member?.color })
  }

  _push (m) {
    m.id = ++this.msgSeq
    this.messages.push(m)
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES)
    this._changed()
  }

  _changed () {
    this.emit('change')
  }

  // --- GUI clients (docs/protocol.md) ----------------------------------------------

  // Commands from subscribed clients. Throws to reply {ok:false, error}.
  async command (msg) {
    switch (msg.cmd) {
      case 'say': {
        if (typeof msg.text !== 'string' || !msg.text.trim()) throw new Error('empty message')
        if (!this.room) throw new Error('not in a room')
        if (!this.say(msg.text)) throw new Error('message not sent')
        return
      }
      case 'lounge':
        if (typeof msg.on !== 'boolean') throw new Error('on must be true or false')
        return this.setLounge(msg.on)
      case 'leaveRoom':
        return this.setLounge(false)
      case 'jumpToCopilot':
        return this.jumpToCopilot()
      case 'dismissRequest':
        return this.dismissRequest()
      case 'jumpTo':
        if (!this.jumpTo(msg.item)) throw new Error('unknown item')
        return
      case 'dismissAttention':
        this.dismissAttention(msg.item)
        return
      default:
        throw new Error('unknown command')
    }
  }

  // Full state for subscribed clients. Field names are a contract: add, never rename.
  snapshot () {
    const r = this.room
    const req = this.currentRequest()
    return {
      type: 'state',
      v: 1,
      now: Date.now(),
      phase: this.phase,
      lounge: this.lounge,
      room: { display: this.roomInfo.display, isHost: !!r?.isHost, activeCount: r ? r.activeCount() : 0, hostHandle: r?.hostHandle ?? null, peers: r ? r.mateCount() : 0 },
      me: { handle: this.identity.handle, color: hexColor(this.identity.color) },
      members: r
        ? r.memberList().map(m => ({ handle: m.handle, color: hexColor(m.color), status: m.status === 'away' ? 'away' : 'active', isHost: !!m.host, you: !!m.self, needed: m.status === 'needed' }))
        : [],
      messages: this.messages.map(m => ({ id: m.id, kind: m.kind, from: m.kind === 'chat' ? m.handle : null, text: m.text, ts: m.ts, color: hexColor(m.color), you: !!m.self })),
      request: req ? { sid: req.sid, cwd: req.cwd ?? null, title: req.title || '', message: req.message || '', resolved: !!req.resolved } : null,
      sessions: [...this.sessions.values()].map(s => ({ sid: s.sid, state: s.state, cwd: s.cwd ?? null, ...harnessOf(s) })),
      attention: this.attentionItems().map(a => ({ id: a.id, harness: a.harness, sid: a.sid, cwd: a.cwd, kind: a.kind, title: a.title, summary: a.summary, at: a.at })),
      // There's no exit countdown or banner any more: always null, for older clients.
      countdown: null,
      banner: null
    }
  }

  async shutdown () {
    for (const s of this.sessions.values()) { this._clearIdle(s); clearTimeout(s.reqTimer); clearInterval(s.pidTimer); s.log?.stop() }
    if (this.room) this._leaveRoom()
    await this.leaving
  }
}

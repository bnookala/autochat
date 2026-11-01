import { EventEmitter } from 'node:events'
import { Room } from './room.js'
import { parseRoom, sanitize } from './protocol.js'
import { setOptout } from './hook.js'
import { notify as defaultNotify } from './launcher.js'
import { envVar } from './env.js'
import { loadConfig } from './config.js'
import { adapter, triggerFor, focusSession } from './harness/index.js'
import { SessionMap, sessionKey, fromHookMessage, byTrigger, modesOf } from './harness/event.js'

const MAX_MESSAGES = 400
const RUNNING = new Set(['running', 'needed'])
// sessions[].harness, when the hook said which harness (hooks from before adapters don't).
const harnessOf = (s) => s.harness ? { harness: s.harness } : {}
export const DEFAULT_COUNTDOWN_SECONDS = 30
// The attention queue: urgent first, and bounded (finished items stay until handled).
const ATTENTION_ORDER = ['blocked', 'failed', 'finished']
const MAX_ATTENTION = 50
const harnessName = (id) => adapter(id || 'copilot')?.name ?? id

// AUTOCHAT_COUNTDOWN_MS (tests) beats config.countdownSeconds; 0 pulls you back immediately.
function countdownMsFor (config, env = process.env) {
  const fromEnv = envVar('COUNTDOWN_MS', env)
  if (fromEnv !== undefined && fromEnv !== '' && Number(fromEnv) >= 0) return Number(fromEnv)
  const secs = config.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : DEFAULT_COUNTDOWN_SECONDS * 1000
}
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
 * Brain of the UI process: tracks agent sessions (SessionEvents from hooks, plus each adapter's
 * session log and fallback observer), keyed `${harness}:${sid}`, enters the room while any of
 * them works autonomously (autopilot), and pulls the user back out (after a non-blocking exit
 * countdown, during which they can keep chatting).
 *
 * Presence and attention are separate: each agent that's blocked on you, finished or failed
 * also gets an item in the attention queue, which stays until handled or dismissed.
 *
 * phase: lounge | room | spectating | reality | dead | left
 */
export class Controller extends EventEmitter {
  constructor ({
    identity, config, auto = false, daemon = false, bootstrap, roomOpts = {},
    focus = focusSession, notify = defaultNotify, bannerMs = 6000, watchLogs = true, requestLingerMs = 20000,
    countdownMs = countdownMsFor(config)
  }) {
    super()
    this.countdownMs = countdownMs
    this.countdown = null
    this.countdownTimer = null
    this.countdownTick = null
    this.requestLingerMs = requestLingerMs
    this.identity = identity
    this.config = config
    this.auto = auto
    this.daemon = daemon
    this.bootstrap = bootstrap
    this.roomOpts = roomOpts
    this.focus = focus
    this.notifyFn = notify
    this.bannerMs = bannerMs
    this.watchLogs = watchLogs
    this.roomInfo = parseRoom(config.room)
    this.sessions = new SessionMap()
    this.finished = new Map()
    this.messages = []
    this.msgSeq = 0
    this.phase = 'lounge'
    this.room = null
    this.banner = null
    this.lastFinished = null
    this.bannerTimer = null
    // At most one item per session (its latest), keyed like sessions.
    this.attention = new Map()
    this.attentionSeq = 0
    // The most agents at work at once since you entered the room: one means focus can go back to it.
    this.agentPeak = 0
  }

  // --- inputs ----------------------------------------------------------------

  handle (msg) {
    if (!msg || typeof msg !== 'object') return { ok: false }
    if (msg.type === 'ping') return { pong: true, phase: this.phase, daemon: this.daemon, pid: process.pid }
    if (msg.type === 'status') return { phase: this.phase, room: this.roomInfo.display, sessions: [...this.sessions.values()].map(s => ({ sid: s.sid, state: s.state, cwd: s.cwd, ...harnessOf(s) })) }
    if (msg.type === 'hook') return { tracked: this._onHook(msg) }
    return { ok: false }
  }

  // Lounge presence: does a session in these modes count, under the trigger config right now?
  _autonomy (harness, modes) {
    return byTrigger(modes, triggerFor(loadConfig(), harness || 'copilot'))
  }

  _onHook (msg) {
    const ev = fromHookMessage(msg)
    if (!ev) return false
    // Hook messages from before adapters carry only Copilot's mode.
    if (!ev.autonomy) ev.autonomy = this._autonomy(ev.harness, modesOf(ev))
    // At work again, or you're chatting with it: its question or its last result is handled.
    if (ev.kind === 'activity') this._resumeAttention(sessionKey(ev.harness, ev.sid))
    let s = this.sessions.get(sessionKey(ev.harness, ev.sid))
    if (!s) {
      if (!(ev.autonomy === 'autonomous' && (ev.kind === 'activity' || ev.kind === 'request'))) return false
      s = this._track(ev)
    }
    if (ev.harness) s.harness = ev.harness
    if (ev.via === 'scan') s.adopted = true
    else s.hooked = true
    if (ev.cwd) s.cwd = ev.cwd
    if (ev.origin && (ev.origin.tmuxPane || ev.origin.bundleId || ev.origin.termProgram)) s.origin = ev.origin
    if (s.optout && ev.kind !== 'complete' && ev.kind !== 'end') return true
    const leftAutopilot = ev.autonomy === 'interactive'
    switch (ev.kind) {
      case 'activity':
        if (leftAutopilot) this._finish(s, 'mode')
        else this._run(s, 'running', null)
        break
      case 'request': {
        if (leftAutopilot) { this._finish(s, 'mode'); break }
        // preToolUse(ask_user) and the elicitation notification describe the same question;
        // keep whichever text is richer (the former includes the choices).
        let req = ev.request || { title: 'Copilot needs you', message: '' }
        const prev = s.request
        if (prev && Date.now() - prev.at < 5000 && (prev.message || '').startsWith(req.message || '')) req = { ...req, message: prev.message }
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
        this._finish(s, 'end')
        break
    }
    // Start tailing only now, replaying lifecycle events logged since this hook fired
    // (e.g. a task_complete that landed while the UI was still launching).
    if (s.log && !s.log.timer && this.sessions.get(s.key) === s) s.log.start({ since: ev.ts })
    return true
  }

  _track (ev) {
    const key = sessionKey(ev.harness, ev.sid)
    const s = { key, sid: ev.sid, harness: ev.harness || null, cwd: ev.cwd, origin: ev.origin, state: 'idle', request: null, idleTimer: null, summary: '', doneAt: 0, optout: false, log: null }
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
    }, this.config.idleMs)
    s.idleTimer.unref?.()
  }

  // Finished sessions are retired; if the same session goes autopilot again, hooks re-track it.
  _finish (s, reason, summary) {
    if (summary) s.summary = sanitize(summary, 2000)
    this._clearIdle(s)
    clearTimeout(s.reqTimer)
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
      if (s.adopted && !s.hooked && !s.manual && RUNNING.has(s.state) && (s.harness || 'copilot') === harness && !seen.has(s.key)) this._finish(s, 'end')
    }
  }

  // --- the attention queue -------------------------------------------------------

  /** Puts a session's latest item in the queue, in place of what it had there. */
  _attend (s, kind, title, summary, { sticky = false } = {}) {
    if (s.manual) return
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

  // `autochat config focus` (read live, like the trigger): auto puts focus back on the agent at the
  // pull-back only when one was at work at a time. With more, the attention queue takes over.
  _focusesBack () {
    const mode = loadConfig().focus
    if (mode === 'always') return true
    if (mode === 'never') return false
    return this.agentPeak <= 1
  }

  // --- room lifecycle ----------------------------------------------------------

  runningSessions () {
    return [...this.sessions.values()].filter(s => RUNNING.has(s.state) && !s.optout)
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
    const running = this.runningSessions()
    const status = running.some(s => s.state === 'needed') ? 'needed' : 'active'
    if (running.length) {
      if (this.countdown) {
        this._clearCountdown()
        this.sys("you're back on autopilot, staying in the room")
      }
      if (this.phase === 'room' && this.room) this.room.setStatus(status)
      else { this.agentPeak = 0; this._enterRoom(status) }
      this.agentPeak = Math.max(this.agentPeak, running.filter(s => !s.manual).length)
    } else if (this.phase === 'room' && !this.countdown) {
      if (this.countdownMs > 0) this._startCountdown()
      else this._pulledBack()
    }
    this._changed()
  }

  // The last autopilot run finished: stay in the room (still counted as active, so it
  // doesn't die under the others) and keep chatting until the countdown runs out.
  _startCountdown () {
    const s = this.lastFinished
    this.countdown = { endsAt: Date.now() + this.countdownMs, total: this.countdownMs / 1000, reason: s?.reason ?? null, summary: s?.summary || null, cwd: s?.cwd ?? null }
    this.room?.setStatus('active')
    this.countdownTimer = setTimeout(() => this.returnNow(), this.countdownMs)
    this.countdownTick = setInterval(() => this._changed(), 1000)
  }

  _clearCountdown () {
    clearTimeout(this.countdownTimer)
    clearInterval(this.countdownTick)
    this.countdownTimer = this.countdownTick = null
    this.countdown = null
  }

  countdownRemaining () {
    return this.countdown ? Math.max(0, Math.ceil((this.countdown.endsAt - Date.now()) / 1000)) : null
  }

  _enterRoom (status) {
    clearTimeout(this.bannerTimer)
    this.banner = null
    if (this.phase === 'spectating' && this.room && !this.room.left) {
      this.phase = 'room'
      this.room.setStatus(status)
      this.sys("you're back on autopilot")
      return
    }
    this.phase = 'room'
    this.messages = []
    const room = new Room({ room: this.roomInfo, identity: this.identity, status, bootstrap: this.bootstrap, announce: this.config.announce, ...this.roomOpts })
    this.room = room
    room.on('change', () => this._changed())
    room.on('peers', () => this._changed())
    room.on('chat', (m) => this._push({ kind: 'chat', ...m }))
    room.on('inst', (inst, { created, wasHost }) => {
      if (room !== this.room) return
      if (created) this.sys("you're the host. this room lives while anyone in it is on autopilot")
      else if (wasHost) this.sys(`found an older room, merging. ${room.hostHandle} is the host`)
      else this.sys(`joined a live room hosted by ${room.hostHandle}`)
    })
    room.on('member-join', (m) => this.sys(`${m.handle} ${m.status === 'away' ? 'is here (spectating)' : 'joined (their copilot is on autopilot)'}`, m))
    room.on('member-status', (m) => {
      if (m.status === 'needed') this.sys(`${m.handle}'s copilot is asking them something`, m)
      else if (m.status === 'away') this.sys(`${m.handle} got pulled back to reality (host, still watching)`, m)
      else this.sys(`${m.handle} is back on autopilot`, m)
    })
    room.on('member-leave', (m, reason) => {
      const why = reason === 'pulled-back' ? 'got pulled back to reality'
        : reason === 'timeout' ? 'faded away'
          : reason === 'dead' ? 'left the dying room' : 'left'
      this.sys(`${m.handle} ${why}`, m)
    })
    room.on('dead', () => this._roomDied(room))
    this.sys(`entering ${this.roomInfo.display}, looking for other autopiloters…`)
    room.join().catch((err) => this.sys('network error: ' + err.message))
  }

  _pulledBack () {
    const room = this.room
    const s = this.lastFinished
    if (s && this._focusesBack()) {
      this.focus(s.origin, s.harness)
      // You're back with it: its result is handled.
      if (this.attention.get(s.key)?.kind !== 'blocked') this._dropAttention(s.key)
    }
    const waiting = this.attention.size
    this.notifyFn('autochat', this.agentPeak > 1 && waiting
      ? `Back to reality: ${waiting === 1 ? 'one of your agents needs' : `${waiting} of your agents need`} you.`
      : 'Back to reality: your copilot ' + (s?.reason === 'complete' ? 'finished.' : 'needs you.'))
    const othersActive = room ? room.activeCount() - (room.status === 'away' ? 0 : 1) : 0
    if (room && room.isHost && othersActive > 0) {
      this.phase = 'spectating'
      room.setStatus('away')
      this.sys('you got pulled back to reality. as host you can keep watching until the room dies')
      return
    }
    this.phase = 'reality'
    this.banner = { kind: 'reality', reason: s?.reason, summary: s?.summary, cwd: s?.cwd }
    this.room = null
    if (room) room.leave('pulled-back').catch(() => {})
    this._afterBanner()
  }

  _roomDied (room) {
    if (room !== this.room) return
    this._clearCountdown()
    this.phase = 'dead'
    this.banner = { kind: 'dead' }
    this.room = null
    room.leave('dead').catch(() => {})
    this._afterBanner()
  }

  _afterBanner () {
    clearTimeout(this.bannerTimer)
    this.bannerTimer = setTimeout(() => {
      if (this.phase !== 'reality' && this.phase !== 'dead' && this.phase !== 'left') return
      if (this.auto) this.emit('exit')
      else { this.phase = 'lounge'; this.banner = null; this._changed() }
    }, this.bannerMs)
    this._changed()
  }

  // --- user actions --------------------------------------------------------------

  // Skip the rest of the exit countdown (also what happens when it reaches zero).
  returnNow () {
    if (!this.countdown) return false
    this._clearCountdown()
    if (this.phase === 'room') this._pulledBack()
    this._changed()
    return true
  }

  say (text) {
    if (this.phase !== 'room' || !this.room) return false
    return this.room.say(text)
  }

  jumpToCopilot () {
    const req = this.currentRequest()
    const s = (req && this.sessions.get(req.key)) || this.runningSessions()[0] || this.lastFinished
    if (s) this.focus(s.origin, s.harness)
  }

  // ctrl-c: leave the room for good (for the sessions currently running).
  async leaveRoom () {
    this._clearCountdown()
    for (const s of this.runningSessions()) { s.optout = true; setOptout(s.sid, s.harness) }
    const room = this.room
    this.room = null
    this.phase = 'left'
    this.banner = { kind: 'left' }
    if (room) await room.leave('left').catch(() => {})
    this._afterBanner()
  }

  // Manual "I'm here" mode (autochat ui --now): a pseudo-session that counts as autopilot.
  joinNow () {
    const s = this._track({ sid: 'manual-' + process.pid })
    s.log?.stop()
    s.manual = true
    this._run(s, 'running', null)
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
        if (this.phase !== 'room' || !this.room) throw new Error('not in a room')
        if (!this.say(msg.text)) throw new Error('message not sent')
        return
      }
      case 'returnNow':
        if (!this.returnNow()) throw new Error('no countdown running')
        return
      case 'leaveRoom':
        if (this.phase !== 'room' && this.phase !== 'spectating') throw new Error('not in a room')
        return this.leaveRoom()
      case 'jumpToCopilot':
        return this.jumpToCopilot()
      case 'dismissRequest':
        return this.dismissRequest()
      case 'joinNow':
        return this.joinNow()
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
    const b = this.banner
    return {
      type: 'state',
      v: 1,
      now: Date.now(),
      phase: this.phase,
      room: { display: this.roomInfo.display, isHost: !!r?.isHost, activeCount: r ? r.activeCount() : 0, hostHandle: r?.hostHandle ?? null, peers: r ? r.mateCount() : 0 },
      me: { handle: this.identity.handle, color: hexColor(this.identity.color) },
      members: r
        ? r.memberList().map(m => ({ handle: m.handle, color: hexColor(m.color), status: m.status === 'away' ? 'away' : 'active', isHost: !!m.host, you: !!m.self, needed: m.status === 'needed' }))
        : [],
      messages: this.messages.map(m => ({ id: m.id, kind: m.kind, from: m.kind === 'chat' ? m.handle : null, text: m.text, ts: m.ts, color: hexColor(m.color), you: !!m.self })),
      request: req ? { sid: req.sid, cwd: req.cwd ?? null, title: req.title || '', message: req.message || '', resolved: !!req.resolved } : null,
      sessions: [...this.sessions.values()].map(s => ({ sid: s.sid, state: s.state, cwd: s.cwd ?? null, ...harnessOf(s) })),
      attention: this.attentionItems().map(a => ({ id: a.id, harness: a.harness, sid: a.sid, cwd: a.cwd, kind: a.kind, title: a.title, summary: a.summary, at: a.at })),
      countdown: this.countdown ? { ...this.countdown, remaining: this.countdownRemaining() } : null,
      banner: b ? { kind: b.kind, reason: b.reason ?? null, summary: b.summary || null, cwd: b.cwd ?? null } : null
    }
  }

  async shutdown () {
    clearTimeout(this.bannerTimer)
    this._clearCountdown()
    for (const s of this.sessions.values()) { this._clearIdle(s); clearTimeout(s.reqTimer); s.log?.stop() }
    if (this.room) { const r = this.room; this.room = null; await r.leave('left').catch(() => {}) }
  }
}

import { EventEmitter } from 'node:events'
import { Room } from './room.js'
import { SessionLog, objectiveStatus } from './session.js'
import { parseRoom, sanitize } from './protocol.js'
import { setOptout } from './hook.js'
import { focusOrigin as defaultFocus, notify as defaultNotify } from './launcher.js'
import { envVar } from './env.js'

const MAX_MESSAGES = 400
const RUNNING = new Set(['running', 'needed'])
export const DEFAULT_COUNTDOWN_SECONDS = 30

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
 * Brain of the UI process: tracks Copilot sessions (via hook messages + session logs),
 * enters the room while any of them is on autopilot, and pulls the user back out
 * (after a non-blocking exit countdown, during which they can keep chatting).
 *
 * phase: lounge | room | spectating | reality | dead | left
 */
export class Controller extends EventEmitter {
  constructor ({
    identity, config, auto = false, daemon = false, bootstrap, roomOpts = {},
    focus = defaultFocus, notify = defaultNotify, bannerMs = 6000, watchLogs = true, requestLingerMs = 20000,
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
    this.sessions = new Map()
    this.finished = new Map()
    this.messages = []
    this.msgSeq = 0
    this.phase = 'lounge'
    this.room = null
    this.banner = null
    this.lastFinished = null
    this.bannerTimer = null
  }

  // --- inputs ----------------------------------------------------------------

  handle (msg) {
    if (!msg || typeof msg !== 'object') return { ok: false }
    if (msg.type === 'ping') return { pong: true, phase: this.phase, daemon: this.daemon, pid: process.pid }
    if (msg.type === 'status') return { phase: this.phase, room: this.roomInfo.display, sessions: [...this.sessions.values()].map(s => ({ sid: s.sid, state: s.state, cwd: s.cwd })) }
    if (msg.type === 'hook') return { tracked: this._onHook(msg) }
    return { ok: false }
  }

  _onHook (msg) {
    let s = this.sessions.get(msg.sessionId)
    if (!s) {
      if (!(msg.mode === 'autopilot' && (msg.kind === 'activity' || msg.kind === 'request'))) return false
      s = this._track(msg)
    }
    if (msg.via === 'scan') s.adopted = true
    else s.hooked = true
    if (msg.cwd) s.cwd = msg.cwd
    if (msg.origin && (msg.origin.tmuxPane || msg.origin.bundleId || msg.origin.termProgram)) s.origin = msg.origin
    if (s.optout && msg.kind !== 'complete' && msg.kind !== 'end') return true
    const leftAutopilot = typeof msg.mode === 'string' && msg.mode !== 'autopilot'
    switch (msg.kind) {
      case 'activity':
        if (leftAutopilot) this._finish(s, 'mode')
        else this._run(s, 'running', null)
        break
      case 'request': {
        if (leftAutopilot) { this._finish(s, 'mode'); break }
        // preToolUse(ask_user) and the elicitation notification describe the same question;
        // keep whichever text is richer (the former includes the choices).
        let req = msg.request || { title: 'Copilot needs you', message: '' }
        const prev = s.request
        if (prev && Date.now() - prev.at < 5000 && (prev.message || '').startsWith(req.message || '')) req = { ...req, message: prev.message }
        this._run(s, 'needed', req)
        break
      }
      case 'complete':
        this._finish(s, 'complete', msg.summary)
        break
      case 'stop':
        if (leftAutopilot) this._finish(s, 'mode')
        else this._armIdle(s)
        break
      case 'end':
        this._finish(s, 'end')
        break
    }
    // Start tailing only now, replaying lifecycle events logged since this hook fired
    // (e.g. a task_complete that landed while the UI was still launching).
    if (s.log && !s.log.timer && this.sessions.get(s.sid) === s) s.log.start({ since: msg.ts })
    return true
  }

  _track (msg) {
    const s = { sid: msg.sessionId, cwd: msg.cwd, origin: msg.origin, state: 'idle', request: null, idleTimer: null, summary: '', doneAt: 0, optout: false, log: null }
    this.sessions.set(s.sid, s)
    if (this.watchLogs) {
      s.log = new SessionLog(s.sid)
      s.log.on('task-complete', ({ summary }) => this._finish(s, 'complete', summary))
      s.log.on('abort', () => this._finish(s, 'abort'))
      s.log.on('shutdown', () => this._finish(s, 'end'))
      s.log.on('mode', (m) => { if (m !== 'autopilot') this._finish(s, 'mode') })
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
  // may continue. Wait a bit; an active objective keeps the session in the room.
  _armIdle (s) {
    this._clearIdle(s)
    if (!RUNNING.has(s.state)) return
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null
      if (!RUNNING.has(s.state)) return
      if (objectiveStatus(s.sid) === 'active') return this._armIdle(s)
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
    if (this.sessions.get(s.sid) === s) this.sessions.delete(s.sid)
    this.finished.set(s.sid, Date.now())
    if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value)
    if (s.state === 'done' || s.state === 'idle') { s.state = 'done'; return }
    s.state = 'done'
    s.request = null
    s.reason = reason
    s.doneAt = Date.now()
    this.lastFinished = s
    this._update()
  }

  /**
   * Pick up autopilot sessions that never call our hooks (their Copilot process started
   * before `autochat setup`), using liveSessions() from scan.js. Hooks stay authoritative
   * for sessions that have them; adopted ones are released when they go idle or exit.
   */
  adopt (live) {
    const seen = new Set()
    for (const l of live) {
      seen.add(l.sid)
      const s = this.sessions.get(l.sid)
      if (s) {
        if (s.adopted && !s.hooked && RUNNING.has(s.state) && !l.running) {
          // Let the log report *why* it stopped (task_complete + summary, abort, mode) first.
          s.log?.poll()
          if (RUNNING.has(s.state)) this._finish(s, l.mode === 'autopilot' ? 'idle' : 'mode')
        }
        continue
      }
      if (!l.running) continue
      const done = this.finished.get(l.sid)
      if (done && l.lastStart <= done) continue
      this.handle({ type: 'hook', via: 'scan', event: 'scan', kind: 'activity', mode: 'autopilot', sessionId: l.sid, cwd: l.cwd, ts: l.scannedAt })
    }
    for (const s of this.sessions.values()) {
      if (s.adopted && !s.hooked && !s.manual && RUNNING.has(s.state) && !seen.has(s.sid)) this._finish(s, 'end')
    }
  }

  // --- room lifecycle ----------------------------------------------------------

  runningSessions () {
    return [...this.sessions.values()].filter(s => RUNNING.has(s.state) && !s.optout)
  }

  currentRequest () {
    const s = this.runningSessions().find(x => x.state === 'needed' && x.request) || this.runningSessions().find(x => x.request)
    return s ? { ...s.request, cwd: s.cwd, sid: s.sid } : null
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
      else this._enterRoom(status)
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
    room.on('host', (h) => { if (room === this.room) this.sys(h.text, h) })
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
    if (s) this.focus(s.origin)
    this.notifyFn('autochat', 'Back to reality: your copilot ' + (s?.reason === 'complete' ? 'finished.' : 'needs you.'))
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
    const s = (req && this.sessions.get(req.sid)) || this.runningSessions()[0] || this.lastFinished
    if (s) this.focus(s.origin)
  }

  // ctrl-c: leave the room for good (for the sessions currently running).
  async leaveRoom () {
    this._clearCountdown()
    for (const s of this.runningSessions()) { s.optout = true; setOptout(s.sid) }
    const room = this.room
    this.room = null
    this.phase = 'left'
    this.banner = { kind: 'left' }
    if (room) await room.leave('left').catch(() => {})
    this._afterBanner()
  }

  // Manual "I'm here" mode (autochat ui --now): a pseudo-session that counts as autopilot.
  joinNow () {
    const s = this._track({ sessionId: 'manual-' + process.pid, mode: 'autopilot' })
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
      sessions: [...this.sessions.values()].map(s => ({ sid: s.sid, state: s.state, cwd: s.cwd ?? null })),
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

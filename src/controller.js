import { EventEmitter } from 'node:events'
import { Room } from './room.js'
import { SessionLog, objectiveStatus } from './session.js'
import { parseRoom, sanitize } from './protocol.js'
import { setOptout } from './hook.js'
import { focusOrigin as defaultFocus, notify as defaultNotify } from './launcher.js'

const MAX_MESSAGES = 400
const RUNNING = new Set(['running', 'needed'])

/**
 * Brain of the UI process: tracks Copilot sessions (via hook messages + session logs),
 * enters the room while any of them is on autopilot, and pulls the user back out.
 *
 * phase: lounge | room | spectating | reality | dead | left
 */
export class Controller extends EventEmitter {
  constructor ({
    identity, config, auto = false, bootstrap, roomOpts = {},
    focus = defaultFocus, notify = defaultNotify, bannerMs = 6000, watchLogs = true, requestLingerMs = 20000
  }) {
    super()
    this.requestLingerMs = requestLingerMs
    this.identity = identity
    this.config = config
    this.auto = auto
    this.bootstrap = bootstrap
    this.roomOpts = roomOpts
    this.focus = focus
    this.notifyFn = notify
    this.bannerMs = bannerMs
    this.watchLogs = watchLogs
    this.roomInfo = parseRoom(config.room)
    this.sessions = new Map()
    this.messages = []
    this.phase = 'lounge'
    this.room = null
    this.banner = null
    this.lastFinished = null
    this.bannerTimer = null
  }

  // --- inputs ----------------------------------------------------------------

  handle (msg) {
    if (!msg || typeof msg !== 'object') return { ok: false }
    if (msg.type === 'ping') return { pong: true, phase: this.phase }
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
    if (s.state === 'done' || s.state === 'idle') { s.state = 'done'; return }
    s.state = 'done'
    s.request = null
    s.reason = reason
    s.doneAt = Date.now()
    this.lastFinished = s
    this._update()
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
      if (this.phase === 'room' && this.room) this.room.setStatus(status)
      else this._enterRoom(status)
    } else if (this.phase === 'room') {
      this._pulledBack()
    }
    this._changed()
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
    if (s) this.focus(s.origin)
    this.notifyFn('lolchat', 'Back to reality: your copilot ' + (s?.reason === 'complete' ? 'finished.' : 'needs you.'))
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
    for (const s of this.runningSessions()) { s.optout = true; setOptout(s.sid) }
    const room = this.room
    this.room = null
    this.phase = 'left'
    this.banner = { kind: 'left' }
    if (room) await room.leave('left').catch(() => {})
    this._afterBanner()
  }

  // Manual "I'm here" mode (lolchat ui --now): a pseudo-session that counts as autopilot.
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
    this.messages.push(m)
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES)
    this._changed()
  }

  _changed () {
    this.emit('change')
  }

  async shutdown () {
    clearTimeout(this.bannerTimer)
    for (const s of this.sessions.values()) { this._clearIdle(s); clearTimeout(s.reqTimer); s.log?.stop() }
    if (this.room) { const r = this.room; this.room = null; await r.leave('left').catch(() => {}) }
  }
}

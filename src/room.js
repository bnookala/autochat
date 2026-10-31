import { EventEmitter } from 'node:events'
import Hyperswarm from 'hyperswarm'
import {
  PROTOCOL_VERSION, MAX_LINE, DIRECTORY_TOPIC,
  topicFor, roomKeyFor, roomTagFor, proofFor, seal, open, randomId, sanitize, signInst, verifyInst
} from './protocol.js'
import { handleFor, colorFor } from './identity.js'

const ACTIVE = new Set(['active', 'needed'])
const STATUSES = new Set(['active', 'needed', 'away'])
const TYPES = new Set(['state', 'chat', 'bye'])
const MAX_SKEW = 5 * 60 * 1000
const MAX_INST_AGE = 7 * 24 * 60 * 60 * 1000
const MAX_MEMBERS = 256
const MAX_SEEN = 5000
const MAX_TOMBS = 512
const BUDGET_WINDOW_MS = 10000
const CONN_LINES_PER_SEC = 200

const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s)

// Older instance wins so peers that discover each other late converge on one room.
export function olderInst (a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt
  return a.iid < b.iid
}

function capMap (map, max) {
  while (map.size > max) map.delete(map.keys().next().value)
}

/**
 * One user's presence in one ephemeral room.
 * Events: change, chat, member-join, member-status, member-leave, inst, dead, peers
 */
export class Room extends EventEmitter {
  constructor ({
    room, identity, status = 'active', bootstrap, announce = true,
    graceMs = 6000, heartbeatMs = 5000, expireMs = 16000,
    refreshMs = [2000, 5000, 10000, 15000, 20000, 30000, 45000, 60000], refreshEveryMs = 30000,
    chatRate = { count: 6, perMs: 5000 },
    now = Date.now
  }) {
    super()
    this.room = room
    this.identity = identity
    this.me = identity.publicKey
    this.tag = randomId(4)
    this.key = this.me + ':' + this.tag
    this.status = status
    this.bootstrap = bootstrap
    this.announce = announce
    this.graceMs = graceMs
    this.heartbeatMs = heartbeatMs
    this.expireMs = expireMs
    this.refreshMs = refreshMs
    this.refreshEveryMs = refreshEveryMs
    this.chatRate = chatRate
    // Per-sender budget for all signed messages: heartbeats plus chat plus generous slack.
    this.senderBudget = Math.max(20, Math.ceil(BUDGET_WINDOW_MS / heartbeatMs) * 2 + chatRate.count * 2)
    this.now = now
    // Derived from the pre-rename `lolchat:v1:` namespace (see protocol.js), so autochat
    // peers still find and verify lolchat peers in the same room.
    this.topic = topicFor(room)
    this.roomKey = roomKeyFor(room)
    this.roomTag = roomTagFor(room)
    this.inst = null
    this.members = new Map()
    this.tombs = new Map()
    this.budgets = new Map()
    this.conns = new Set()
    this.seen = new Map()
    this.timers = []
    this.dead = false
    this.left = false
    this.swarm = null
  }

  get isHost () {
    return !!this.inst && this.inst.hostId === this.me
  }

  get hostHandle () {
    return this.inst ? handleFor(this.inst.hostId) : null
  }

  activeCount () {
    let n = ACTIVE.has(this.status) ? 1 : 0
    for (const m of this.members.values()) if (ACTIVE.has(m.status)) n++
    return n
  }

  mateCount () {
    let n = 0
    for (const c of this.conns) if (c.mate) n++
    return n
  }

  memberList () {
    const self = {
      key: this.key, from: this.me, handle: this.identity.handle, color: this.identity.color,
      status: this.status, self: true, host: this.isHost
    }
    const others = [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(m => ({ key: m.key, from: m.from, handle: m.handle, color: m.color, status: m.status, self: false, host: !!this.inst && this.inst.hostId === m.from }))
    return [self, ...others]
  }

  async join () {
    this.swarm = new Hyperswarm(this.bootstrap ? { bootstrap: this.bootstrap } : {})
    this.swarm.on('connection', (conn) => this._onConnection(conn))
    this.discovery = this.swarm.join(this.topic, { server: true, client: true })
    if (this.room.isPublic && this.announce) {
      this.dirDiscovery = this.swarm.join(DIRECTORY_TOPIC, { server: true, client: false })
    }
    // Peers that join at the same moment can miss each other's announce;
    // re-running discovery a few times early (then periodically) fixes that.
    for (const ms of this.refreshMs) this._timeout(() => this._refresh(), ms)
    this._interval(() => this._refresh(), this.refreshEveryMs)
    this._interval(() => this._broadcastState(), this.heartbeatMs)
    this._interval(() => this._expire(), 1000)
    this._timeout(() => this._createInstIfNone(), this.graceMs)
    this.discovery.flushed().then(() => this.emit('ready')).catch(() => {})
  }

  setStatus (status) {
    if (!STATUSES.has(status) || status === this.status) return
    this.status = status
    this._broadcastState()
    this.emit('change')
    this._checkAlive()
  }

  say (text) {
    const clean = sanitize(text)
    if (!clean || this.status === 'away' || this.left) return false
    const body = { t: 'chat', v: PROTOCOL_VERSION, room: this.roomTag, from: this.me, tag: this.tag, mid: randomId(), ts: this.now(), text: clean }
    this._broadcast(body)
    this.emit('chat', { from: this.me, handle: this.identity.handle, color: this.identity.color, text: clean, ts: body.ts, self: true })
    return true
  }

  async leave (reason = 'left') {
    if (this.left) return
    this.left = true
    if (!this.dead) {
      this._broadcast({ t: 'bye', v: PROTOCOL_VERSION, room: this.roomTag, from: this.me, tag: this.tag, mid: randomId(), ts: this.now(), reason: String(reason).slice(0, 32) })
    }
    for (const t of this.timers) { clearTimeout(t); clearInterval(t) }
    this.timers = []
    await new Promise(resolve => setTimeout(resolve, 250))
    if (this.swarm) await this.swarm.destroy().catch(() => {})
  }

  // --- internals -----------------------------------------------------------

  _timeout (fn, ms) { const t = setTimeout(fn, ms); t.unref?.(); this.timers.push(t) }
  _interval (fn, ms) { const t = setInterval(fn, ms); t.unref?.(); this.timers.push(t) }

  _refresh () {
    if (this.left) return
    this.discovery?.refresh({ client: true, server: true }).catch(() => {})
    this.dirDiscovery?.refresh({ client: false, server: true }).catch(() => {})
  }

  _createInstIfNone () {
    if (this.inst || this.left) return
    this.inst = signInst(this.identity, this.roomTag, { iid: randomId(8), createdAt: this.now(), hostId: this.me })
    this.emit('inst', this.inst, { created: true, wasHost: false })
    this._broadcastState()
    this.emit('change')
  }

  _considerInst (inst) {
    if (!inst || typeof inst !== 'object') return
    if (this.inst && (this.inst.iid === inst.iid || !olderInst(inst, this.inst))) return
    if (!verifyInst(this.roomTag, inst)) return
    const t = this.now()
    if (inst.createdAt > t + MAX_SKEW || inst.createdAt < t - MAX_INST_AGE) return
    const wasHost = this.isHost
    this.inst = { iid: inst.iid, createdAt: inst.createdAt, hostId: inst.hostId, sig: inst.sig }
    this.emit('inst', this.inst, { created: false, wasHost })
    this._broadcastState()
  }

  _dirInfo () {
    if (!this.room.isPublic || !this.announce) return null
    return { name: this.room.code, active: this.activeCount(), members: this.members.size + 1 }
  }

  _write (c, line) {
    try { c.conn.write(line + '\n') } catch {}
  }

  _broadcast (body, except = null) {
    const line = seal(this.identity, body)
    this._markSeen(body.mid)
    for (const c of this.conns) if (c.mate && c !== except) this._write(c, line)
    return line
  }

  _broadcastState () {
    if (this.left) return
    this._broadcast({ t: 'state', v: PROTOCOL_VERSION, room: this.roomTag, from: this.me, tag: this.tag, mid: randomId(), ts: this.now(), status: this.status, inst: this.inst })
  }

  _onConnection (conn) {
    const c = { conn, buf: '', mate: false, remoteKey: null, dir: null, lines: 0, window: 0 }
    this.conns.add(c)
    conn.on('error', () => {})
    conn.on('data', (chunk) => {
      c.buf += chunk.toString('utf8')
      if (c.buf.length > MAX_LINE * 4) { conn.destroy(); return }
      let i
      while ((i = c.buf.indexOf('\n')) !== -1) {
        const line = c.buf.slice(0, i)
        c.buf = c.buf.slice(i + 1)
        const sec = Math.floor(this.now() / 1000)
        if (sec !== c.window) { c.window = sec; c.lines = 0 }
        if (++c.lines > CONN_LINES_PER_SEC) { conn.destroy(); return }
        if (line && line.length <= MAX_LINE) this._onLine(c, line)
      }
    })
    conn.on('close', () => {
      this.conns.delete(c)
      if (c.mate && c.remoteKey) {
        // Let the member expire soon unless a relayed heartbeat proves it's still around.
        const m = this.members.get(c.remoteKey)
        if (m) m.lastSeen = Math.min(m.lastSeen, this.now() - this.expireMs + 4000)
      }
      this.emit('peers')
    })
    const hello = { v: PROTOCOL_VERSION, from: this.me, tag: this.tag, proof: this._proof(conn), dir: this._dirInfo() }
    this._write(c, JSON.stringify({ h: hello }))
  }

  _proof (conn) {
    if (!conn.publicKey || !conn.remotePublicKey) return null
    return proofFor(this.roomKey, conn.publicKey, conn.remotePublicKey)
  }

  _onLine (c, line) {
    let obj
    try { obj = JSON.parse(line) } catch { return }
    if (!obj || typeof obj !== 'object') return
    if (obj.h) return this._onHello(c, obj.h)
    if (!c.mate) return
    const body = open(obj)
    if (body) this._onSigned(c, body, line)
  }

  _onHello (c, h) {
    if (!h || h.v !== PROTOCOL_VERSION || c.mate) return
    if (typeof h.proof !== 'string' || h.proof !== this._proof(c.conn)) return
    if (!isHex(h.from, 64) || !isHex(h.tag, 8)) return
    c.mate = true
    c.remoteKey = h.from + ':' + h.tag
    // Catch the newcomer up with our state plus everyone else's latest signed state.
    this._broadcastState()
    for (const m of this.members.values()) if (m.stateLine && m.key !== c.remoteKey) this._write(c, m.stateLine)
    this.emit('peers')
  }

  _markSeen (mid) {
    this.seen.set(mid, this.now())
    capMap(this.seen, MAX_SEEN)
  }

  _withinBudget (key) {
    const t = this.now()
    const times = (this.budgets.get(key) || []).filter(x => t - x < BUDGET_WINDOW_MS)
    if (times.length >= this.senderBudget) return false
    times.push(t)
    this.budgets.delete(key)
    this.budgets.set(key, times)
    capMap(this.budgets, MAX_MEMBERS * 4)
    return true
  }

  // Validate everything (room binding, type, membership, rate limits) *before* relaying,
  // so a hostile member can't use the mesh to amplify junk.
  _onSigned (c, body, line) {
    if (!isHex(body.mid, 16) || this.seen.has(body.mid)) return
    this._markSeen(body.mid)
    if (body.v !== PROTOCOL_VERSION || body.room !== this.roomTag || !TYPES.has(body.t)) return
    if (!Number.isFinite(body.ts) || Math.abs(this.now() - body.ts) > MAX_SKEW) return
    if (!isHex(body.tag, 8)) return
    if (body.from === this.me && body.tag === this.tag) return
    const key = body.from + ':' + body.tag
    const m = this.members.get(key)
    if (body.t === 'state' && !STATUSES.has(body.status)) return
    if ((body.t === 'chat' || body.t === 'bye') && !m) return
    if (body.t === 'chat' && !this._chatAllowed(m)) return
    if (!this._withinBudget(key)) return
    for (const o of this.conns) if (o !== c && o.mate) this._write(o, line)
    if (body.t === 'state') this._applyState(key, body, line)
    else if (body.t === 'chat') this._applyChat(m, body)
    else this._applyBye(key, body)
  }

  _chatAllowed (m) {
    const t = this.now()
    m.chatTimes = m.chatTimes.filter(x => t - x < this.chatRate.perMs)
    if (m.chatTimes.length >= this.chatRate.count) return false
    m.chatTimes.push(t)
    return true
  }

  _applyState (key, body, line) {
    const tomb = this.tombs.get(key)
    if (tomb && body.ts <= tomb) return
    let m = this.members.get(key)
    if (m && body.ts <= m.ts) return
    const isNew = !m
    if (isNew && this.members.size >= MAX_MEMBERS) return
    if (!m) {
      m = { key, from: body.from, tag: body.tag, handle: handleFor(body.from), color: colorFor(body.from), joinedAt: this.now(), chatTimes: [] }
      this.members.set(key, m)
    }
    const prev = m.status
    m.status = body.status
    m.ts = body.ts
    m.lastSeen = this.now()
    m.stateLine = line
    if (body.inst) this._considerInst(body.inst)
    if (isNew) this.emit('member-join', m)
    else if (prev !== m.status) this.emit('member-status', m, prev)
    this.emit('change')
    this._checkAlive()
  }

  _applyChat (m, body) {
    const text = sanitize(body.text)
    if (!text) return
    m.lastSeen = this.now()
    this.emit('chat', { from: body.from, handle: handleFor(body.from), color: colorFor(body.from), text, ts: body.ts, self: false })
  }

  _applyBye (key, body) {
    this.tombs.set(key, body.ts)
    capMap(this.tombs, MAX_TOMBS)
    const m = this.members.get(key)
    if (!m) return
    this.members.delete(key)
    this.emit('member-leave', m, sanitize(String(body.reason || 'left'), 32))
    this.emit('change')
    this._checkAlive()
  }

  _expire () {
    const t = this.now()
    for (const [key, m] of this.members) {
      if (t - m.lastSeen > this.expireMs) {
        this.members.delete(key)
        this.emit('member-leave', m, 'timeout')
        this.emit('change')
      }
    }
    for (const [mid, ts] of this.seen) if (t - ts > 10 * 60 * 1000) this.seen.delete(mid)
    for (const [key, ts] of this.tombs) if (t - ts > 10 * 60 * 1000) this.tombs.delete(key)
    this._checkAlive()
  }

  // A room is alive while anyone is actively on autopilot. Spectators (the host after
  // being pulled back) watch until that count drops to zero, then the room dies.
  _checkAlive () {
    if (this.dead || this.left || this.status !== 'away') return
    if (this.activeCount() === 0) {
      this.dead = true
      this.emit('dead')
    }
  }
}

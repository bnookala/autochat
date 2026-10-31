import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { sanitize, sanitizeMultiline, charCount } from './text.js'
import { findSecret } from './secrets.js'

// The local agent room: agents of the same OS user on this machine, hosted by
// `autochat daemon` over the unix socket. Memory only, and no network: this module (and
// everything it imports) must never load Hyperswarm, the DHT or any socket API.
// See "Agent room (local)" in docs/protocol.md.

export const AGENT_PROTOCOL = 1
export const TIER = 'local'
export const STATES = ['exploring', 'editing', 'testing', 'blocked', 'done', 'idle']
export const POST_KINDS = ['note', 'question', 'reply', 'proposal', 'decision', 'handoff']

export const LIMITS = {
  maxAgents: 32,
  resumeMs: 10000,
  lingerMs: 10 * 60 * 1000,
  historyMax: 1000,
  historyMs: 24 * 60 * 60 * 1000,
  threadMs: 24 * 60 * 60 * 1000,
  budgetWindowMs: 10 * 60 * 1000,
  mainPosts: 10,
  threadPosts: 40,
  statusGapMs: 5000,
  waitDefaultMs: 30000,
  waitMaxMs: 50000,
  readDefault: 50,
  readMax: 100,
  snapshotMessages: 300,
  decisions: 10,
  recent: 20,
  text: 2000,
  summary: 140,
  title: 80,
  outcome: 500,
  component: 40,
  components: 10,
  path: 300,
  paths: 200,
  to: 16
}

class AgentError extends Error {
  constructor (message, extra = {}) {
    super(message)
    Object.assign(this, extra)
  }
}
const fail = (message, extra) => { throw new AgentError(message, extra) }

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex')
const isStr = (v) => typeof v === 'string'
const int = (v) => Number.isSafeInteger(v)
const opt = (v) => v === undefined || v === null

export function normalizeName (s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
    .replace(/^-+/, '').slice(0, 32).replace(/-+$/, '')
}

// `<harness>-<repo name or cwd basename>`
export function defaultName ({ harness, repo, cwd }) {
  const base = (repo && repo.split('/').pop()) || (cwd && cwd.split(/[\\/]/).filter(Boolean).pop()) || ''
  return normalizeName(base ? `${harness}-${base}` : harness) || 'agent'
}

export function dedupeName (name, taken) {
  if (!taken.has(name)) return name
  for (let i = 2; ; i++) {
    const suffix = '-' + i
    const candidate = name.slice(0, 32 - suffix.length).replace(/-+$/, '') + suffix
    if (!taken.has(candidate)) return candidate
  }
}

export function normalizePath (p) {
  if (!isStr(p)) return null
  let s = sanitize(p, Infinity).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/\/+$/, '')
  return !s || s === '.' ? null : s
}

// "src" covers "src/room.js": directory prefixes on path-segment boundaries.
function dirPrefixes (p) {
  const out = []
  for (let i = p.indexOf('/', 1); i > 0; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i))
  return out
}

function pathIndex (paths) {
  const set = new Set(paths)
  const dirs = new Set()
  for (const p of paths) for (const d of dirPrefixes(p)) dirs.add(d)
  return { paths, set, dirs }
}

function sharedPaths (a, b) {
  const out = new Set()
  for (const p of a.paths) {
    if (b.set.has(p) || dirPrefixes(p).some(d => b.set.has(d))) out.add(p)
    else if (b.dirs.has(p)) for (const q of b.paths) if (q.startsWith(p + '/')) out.add(q)
  }
  return [...out].sort()
}

/**
 * What two agents' cards share: same non-null repo, plus the same issue, a shared component
 * (case-insensitive) or an overlapping path. Returns null when they don't overlap.
 */
export function overlapOn (a, b) {
  if (!a.repo || !b.repo || a.repo.toLowerCase() !== b.repo.toLowerCase()) return null
  const on = {}
  if (a.focus.issue !== null && a.focus.issue === b.focus.issue) on.issue = a.focus.issue
  const theirs = new Set(b.focus.components.map(c => c.toLowerCase()))
  const components = a.focus.components.filter(c => theirs.has(c.toLowerCase()))
  if (components.length) on.components = components
  const paths = sharedPaths(a.pathIndex, b.pathIndex)
  if (paths.length) on.paths = paths
  return Object.keys(on).length ? on : null
}

function describeOverlap (on) {
  const bits = []
  if (on.issue !== undefined) bits.push(`issue #${on.issue}`)
  for (const c of on.components || []) bits.push(`component ${c}`)
  const paths = on.paths || []
  bits.push(...paths.slice(0, 3))
  return bits.join(', ') + (paths.length > 3 ? ` (+${paths.length - 3} more)` : '')
}

function threadSlug (title) {
  let slug = ''
  for (const w of title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (slug && slug.length + w.length + 1 > 24) break
    slug = slug ? slug + '-' + w : w.slice(0, 24)
  }
  return slug || 'thread'
}

const MENTION = /(^|[^A-Za-z0-9_-])@(?:[a-z0-9-]+\/)?([a-z0-9][a-z0-9-]*)/gi

/**
 * Events: `change` (anything visible changed), `presence` (event, card) with event
 * joined | away | back | left.
 */
export class AgentRoom extends EventEmitter {
  constructor ({ human, ack = false, onAck = () => {}, now = Date.now, limits = {} } = {}) {
    super()
    this.human = human || 'me'
    this.ack = !!ack
    this.onAck = onAck
    this.now = now
    this.limits = { ...LIMITS, ...limits }
    this.agents = new Map()
    this.tokens = new Map()
    this.formerNames = new Map()
    this.log = []
    this.bySeq = new Map()
    this.seq = 0
    this.threads = new Map()
    this.pairs = new Map()
    this.everConnected = false
    this.closed = false
    this.pruneTimer = setInterval(() => this._prune(), 60000)
    this.pruneTimer.unref?.()
  }

  // --- presence ------------------------------------------------------------------

  /**
   * A new agent connection whose first line was `agent-hello`. `peer` is
   * {send(obj), end(obj)}. Returns the connection handler {message(msg), close()}, or null
   * after refusing (the error line is sent and the connection ended).
   */
  connect (hello, peer) {
    const refuse = (error) => { peer.end({ type: 'error', v: AGENT_PROTOCOL, error }); return null }
    if (this.closed) return refuse('shutting down')
    if (hello.v !== undefined && hello.v !== AGENT_PROTOCOL) return refuse('unsupported protocol version')
    const info = this._helloInfo(hello)
    let agent = isStr(hello.resume) ? this.agents.get(this.tokens.get(hello.resume)) : null
    if (agent?.left) agent = null
    const resumed = !!agent
    if (agent) {
      clearTimeout(agent.awayTimer)
      agent.awayTimer = null
      const old = agent.peer
      agent.peer = null
      if (old) old.end()
      Object.assign(agent, info)
    } else {
      if (this._live().length >= this.limits.maxAgents) return refuse('too many agents')
      const now = this.now()
      const taken = this._takenNames()
      const name = dedupeName(normalizeName(hello.name) || defaultName(info), taken)
      agent = {
        id: this._newAgentId(),
        token: hex(16),
        name,
        ...info,
        state: 'idle',
        summary: null,
        focus: { issue: null, components: [], paths: [] },
        pathIndex: pathIndex([]),
        joinedAt: now,
        updatedAt: now,
        present: true,
        left: false,
        leftAt: null,
        cursor: this.seq,
        unread: new Map(),
        posts: { main: [], thread: [] },
        lastStatusAt: null,
        wait: null,
        awayTimer: null,
        removeTimer: null,
        peer: null
      }
      this.agents.set(agent.id, agent)
      this.tokens.set(agent.token, agent.id)
    }
    agent.peer = peer
    agent.present = true
    this.everConnected = true
    peer.send({
      type: 'agent-welcome',
      v: AGENT_PROTOCOL,
      tier: TIER,
      room: 'local',
      resume: agent.token,
      agent: { id: agent.id, name: agent.name, human: this.human, display: this._display(agent), harness: agent.harness }
    })
    if (resumed) {
      this._recomputeOverlaps(agent)
      this.emit('presence', 'back', this.card(agent))
    } else {
      this._sys(`${agent.name} joined`)
      this.emit('presence', 'joined', this.card(agent))
    }
    this._changed()
    return {
      message: (msg) => this._onLine(agent, peer, msg),
      close: () => this._onClose(agent, peer)
    }
  }

  _helloInfo (h) {
    const str = (v, max) => isStr(v) && v ? sanitize(v, max) : null
    const pid = (v) => int(v) && v > 0 ? v : null
    const repo = isStr(h.repo) && /^[\w.-]+\/[\w.-]+$/.test(h.repo) && h.repo.length <= 140 ? h.repo : null
    return {
      harness: normalizeName(h.harness).slice(0, 20) || 'agent',
      pid: pid(h.pid),
      harnessPid: pid(h.harnessPid),
      sessionId: str(h.sessionId, 128),
      cwd: str(h.cwd, 300),
      repo,
      branch: str(h.branch, 200),
      worktree: str(h.worktree, 100)
    }
  }

  _newAgentId () {
    let id
    do id = hex(4); while (this.agents.has(id))
    return id
  }

  _onClose (agent, peer) {
    if (agent.peer !== peer) return
    agent.peer = null
    agent.present = false
    this._cancelWait(agent)
    if (this.closed) return
    agent.awayTimer = setTimeout(() => this._leave(agent), this.limits.resumeMs)
    agent.awayTimer.unref?.()
    this.emit('presence', 'away', this.card(agent))
    this._changed()
  }

  _leave (agent) {
    if (agent.left) return
    agent.left = true
    agent.leftAt = this.now()
    agent.awayTimer = null
    agent.unread.clear()
    this.tokens.delete(agent.token)
    for (const [key, p] of this.pairs) if (p.a === agent.id || p.b === agent.id) this.pairs.delete(key)
    this._sys(`${agent.name} left`)
    agent.removeTimer = setTimeout(() => this._remove(agent), this.limits.lingerMs)
    agent.removeTimer.unref?.()
    this.emit('presence', 'left', this.card(agent))
    this._changed()
  }

  _remove (agent) {
    this.formerNames.set(agent.id, agent.name)
    if (this.formerNames.size > 1000) this.formerNames.delete(this.formerNames.keys().next().value)
    this.agents.delete(agent.id)
    this._changed()
  }

  _live () {
    return [...this.agents.values()].filter(a => !a.left)
  }

  _takenNames (except) {
    return new Set(this._live().filter(a => a !== except).map(a => a.name))
  }

  _nameOf (id) {
    return this.agents.get(id)?.name ?? this.formerNames.get(id) ?? '?'
  }

  _display (agent) {
    return `${this.human}/${agent.name}`
  }

  // `to` names → agent ids. Unknown or departed names are errors, so typos get noticed.
  _resolveNames (names, field = 'to') {
    if (opt(names)) return []
    if (!Array.isArray(names) || names.some(n => !isStr(n))) fail(`${field} must be a list of agent names`)
    if (names.length > this.limits.to) fail(`${field} has too many names (max ${this.limits.to})`)
    const ids = []
    for (const raw of names) {
      const name = normalizeName(raw.replace(/^@/, '').replace(/^.*\//, ''))
      const agent = this._live().find(a => a.name === name)
      if (agent) { if (!ids.includes(agent.id)) ids.push(agent.id); continue }
      if ([...this.agents.values()].some(a => a.name === name)) fail(`${name} left the room`)
      fail(`unknown agent: ${name || raw}`)
    }
    return ids
  }

  _mentionIds (text) {
    const ids = new Set()
    for (const m of text.matchAll(MENTION)) {
      const agent = this._live().find(a => a.name === m[2].toLowerCase())
      if (agent) ids.add(agent.id)
    }
    return ids
  }

  // --- the agent protocol -------------------------------------------------------------

  _onLine (agent, peer, msg) {
    if (agent.peer !== peer) return
    const id = msg?.id ?? null
    const reply = (r) => {
      if (agent.peer !== peer) return
      peer.send({ type: 'reply', id, ...r, inbox: this._inbox(agent) })
    }
    const failed = (err) => reply({ ok: false, error: err?.message || String(err), ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) })
    if (!msg || typeof msg !== 'object') return failed(new Error('invalid json'))
    if (msg.type !== 'cmd') return failed(new Error('unknown message type'))
    let result
    try {
      result = this._command(agent, msg)
    } catch (err) {
      if (!(err instanceof AgentError)) this.emit('error-log', err)
      return failed(err)
    }
    if (result && typeof result.then === 'function') {
      result.then((r) => reply({ ok: true, result: r }), failed)
    } else {
      reply({ ok: true, result })
    }
  }

  _command (agent, msg) {
    switch (msg.cmd) {
      case 'catchUp': return this._catchUp(agent)
      case 'status': return this._status(agent, msg)
      case 'post': return this._agentPost(agent, msg)
      case 'read': return this._read(agent, msg)
      case 'wait': return this._wait(agent, msg)
      case 'thread': return this._thread(agent, msg)
      default: fail('unknown command')
    }
  }

  _inbox (agent) {
    let mentions = 0
    for (const m of agent.unread.values()) if (m) mentions++
    return { unread: agent.unread.size, mentions }
  }

  _deliver (agent, entries) {
    for (const e of entries) agent.unread.delete(e.msg.seq)
    return entries.map(e => this._msgView(e))
  }

  _catchUp (agent) {
    const unread = this.log.filter(e => agent.unread.has(e.msg.seq))
    const inbox = unread.slice(0, this.limits.readMax)
    const seen = new Set(inbox)
    const decisions = this.log.filter(e => e.msg.kind === 'decision').slice(-this.limits.decisions).filter(e => !seen.has(e))
    const recent = this.log.filter(e => e.msg.thread === null).slice(-this.limits.recent).filter(e => !seen.has(e))
    const cursor = inbox.length < unread.length ? inbox.at(-1).msg.seq : this.seq
    agent.cursor = Math.max(agent.cursor, cursor)
    return {
      you: this.card(agent),
      tier: TIER,
      board: this._cards().filter(c => c.id !== agent.id),
      threads: this._threadList(),
      decisions: this._deliver(agent, decisions),
      recent: this._deliver(agent, recent),
      inbox: this._deliver(agent, inbox),
      cursor: agent.cursor
    }
  }

  _status (agent, msg) {
    const L = this.limits
    const patch = {}
    if (!opt(msg.summary)) {
      if (!isStr(msg.summary)) fail('summary must be a string')
      const summary = sanitize(msg.summary, Infinity)
      if (charCount(summary) > L.summary) fail(`summary too long (max ${L.summary} characters)`)
      this._scan(summary)
      patch.summary = summary || null
    }
    if (!opt(msg.state)) {
      if (!STATES.includes(msg.state)) fail('state must be one of ' + STATES.join(', '))
      patch.state = msg.state
    }
    if (!opt(msg.focus)) {
      if (typeof msg.focus !== 'object' || Array.isArray(msg.focus)) fail('focus must be an object')
      patch.focus = this._focus(msg.focus, agent.focus)
    }
    let name = null
    if (!opt(msg.name)) {
      if (!isStr(msg.name) || !normalizeName(msg.name)) fail('name must use a-z, 0-9 and -')
      name = normalizeName(msg.name)
    }
    const now = this.now()
    if (agent.lastStatusAt !== null && now - agent.lastStatusAt < L.statusGapMs) {
      fail('rate limited', { retryAfterMs: agent.lastStatusAt + L.statusGapMs - now })
    }
    agent.lastStatusAt = now
    Object.assign(agent, patch)
    if (patch.focus) agent.pathIndex = pathIndex(agent.focus.paths)
    if (name && name !== agent.name) {
      const old = agent.name
      agent.name = dedupeName(name, this._takenNames(agent))
      if (agent.name !== old) this._sys(`${old} is now ${agent.name}`)
    }
    agent.updatedAt = now
    this._recomputeOverlaps(agent)
    this._changed()
    return { card: this.card(agent), overlaps: this._overlapsOf(agent) }
  }

  _focus (f, prev) {
    const L = this.limits
    const next = { ...prev }
    if (f.issue !== undefined) {
      if (f.issue !== null && !(int(f.issue) && f.issue > 0)) fail('focus.issue must be a positive integer')
      next.issue = f.issue
    }
    if (f.components !== undefined) {
      if (f.components === null) f = { ...f, components: [] }
      if (!Array.isArray(f.components) || f.components.some(c => !isStr(c))) fail('focus.components must be a list of strings')
      if (f.components.length > L.components) fail(`focus.components has too many entries (max ${L.components})`)
      const seen = new Set()
      next.components = []
      for (const c of f.components) {
        const s = sanitize(c, Infinity)
        if (charCount(s) > L.component) fail(`focus.components entries are at most ${L.component} characters`)
        if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); next.components.push(s) }
      }
    }
    if (f.paths !== undefined) {
      if (f.paths === null) f = { ...f, paths: [] }
      if (!Array.isArray(f.paths) || f.paths.some(p => !isStr(p))) fail('focus.paths must be a list of strings')
      if (f.paths.length > L.paths) fail(`focus.paths has too many entries (max ${L.paths})`)
      const out = new Set()
      for (const p of f.paths) {
        if (charCount(p) > L.path) fail(`focus.paths entries are at most ${L.path} characters`)
        const n = normalizePath(p)
        if (n) out.add(n)
      }
      next.paths = [...out]
    }
    return next
  }

  _recomputeOverlaps (agent) {
    for (const other of this._live()) {
      if (other === agent) continue
      const key = [agent.id, other.id].sort().join(':')
      const on = overlapOn(agent, other)
      if (!on) { this.pairs.delete(key); continue }
      const fresh = !this.pairs.has(key)
      this.pairs.set(key, { a: agent.id, b: other.id })
      if (fresh) {
        this._append({
          kind: 'overlap',
          from: null,
          to: [agent.name, other.name],
          text: `${agent.name} and ${other.name} both touch ${describeOverlap(on)}`
        }, { audience: [agent.id, other.id], mentions: [agent.id, other.id] })
      }
    }
  }

  _overlapping (agent) {
    const out = []
    for (const p of this.pairs.values()) {
      if (p.a !== agent.id && p.b !== agent.id) continue
      const other = this.agents.get(p.a === agent.id ? p.b : p.a)
      if (other && !other.left) out.push(other)
    }
    return out
  }

  _overlapsOf (agent) {
    return this._overlapping(agent).map(other => ({ agent: other.name, on: overlapOn(agent, other) }))
  }

  _scan (text) {
    const kind = findSecret(text)
    if (kind) fail(`blocked: looks like a secret (${kind})`)
  }

  _text (value, max, field = 'text') {
    if (!isStr(value)) fail(`${field} must be a string`)
    const text = sanitizeMultiline(value)
    if (!text) fail(`${field} is empty`)
    if (charCount(text) > max) fail(`${field} too long (max ${max} characters)`)
    this._scan(text)
    return text
  }

  _budget (agent, which) {
    const L = this.limits
    const now = this.now()
    const list = agent.posts[which]
    while (list.length && now - list[0] >= L.budgetWindowMs) list.shift()
    const max = which === 'main' ? L.mainPosts : L.threadPosts
    return list.length < max ? null : list[0] + L.budgetWindowMs - now
  }

  _spend (agent, which) {
    agent.posts[which].push(this.now())
  }

  _openThread (thread) {
    if (opt(thread)) return null
    if (!isStr(thread)) fail('thread must be a thread id')
    const t = this.threads.get(thread)
    if (!t) fail(`unknown thread: ${sanitize(thread, 40)}`)
    if (t.status !== 'open') fail(`thread ${t.id} is resolved`)
    return t
  }

  _agentPost (agent, msg) {
    const kind = opt(msg.kind) ? 'note' : msg.kind
    if (!POST_KINDS.includes(kind)) fail('kind must be one of ' + POST_KINDS.join(', '))
    const text = this._text(msg.text, this.limits.text)
    let replyTo = null
    if (!opt(msg.replyTo)) {
      if (!int(msg.replyTo) || !this.bySeq.has(msg.replyTo)) fail('replyTo must be the seq of a message in the room')
      replyTo = msg.replyTo
    }
    let thread = this._openThread(msg.thread)
    // A reply to a thread message lands in that thread, unless `thread` says otherwise.
    if (msg.thread === undefined && replyTo !== null) {
      const parent = this.threads.get(this.bySeq.get(replyTo).msg.thread)
      if (parent?.status === 'open') thread = parent
    }
    const toIds = this._resolveNames(msg.to).filter(id => id !== agent.id)
    const autoThread = !thread && kind === 'question' && toIds.length > 0
    if (autoThread || !thread) {
      const wait = this._budget(agent, 'main')
      if (wait !== null) fail('rate limited', { retryAfterMs: wait })
    }
    if (autoThread || thread) {
      const wait = this._budget(agent, 'thread')
      if (wait !== null) fail('rate limited', { retryAfterMs: wait })
    }
    if (autoThread) {
      this._spend(agent, 'main')
      const title = sanitize(text, this.limits.title)
      thread = this._createThread(agent, title, toIds)
    }
    if (thread) {
      this._spend(agent, 'thread')
      thread.participants.add(agent.id)
      for (const id of toIds) thread.participants.add(id)
    } else {
      this._spend(agent, 'main')
    }
    const entry = this._append({
      kind,
      from: this._from(agent),
      thread: thread ? thread.id : null,
      to: toIds.map(id => this._nameOf(id)),
      replyTo,
      text
    }, { author: agent.id, toIds, replyTo })
    const result = { message: this._msgView(entry) }
    if (thread) result.thread = this._threadView(thread)
    return result
  }

  _from (agent) {
    return { name: agent.name, display: this._display(agent), human: this.human, harness: agent.harness, repo: agent.repo }
  }

  _read (agent, msg) {
    const L = this.limits
    const limit = opt(msg.limit) ? L.readDefault : msg.limit
    if (!int(limit) || limit < 1 || limit > L.readMax) fail(`limit must be 1-${L.readMax}`)
    if (!opt(msg.since) && !(int(msg.since) && msg.since >= 0)) fail('since must be a message seq (0 or more)')
    const scope = opt(msg.scope) ? 'inbox' : msg.scope
    if (!['inbox', 'all'].includes(scope)) fail('scope must be inbox or all')
    if (!opt(msg.thread)) {
      if (!isStr(msg.thread) || !this.threads.has(msg.thread)) fail(`unknown thread: ${sanitize(String(msg.thread), 40)}`)
      const since = msg.since ?? 0
      const all = this.log.filter(e => e.msg.thread === msg.thread && e.msg.seq > since)
      const page = all.slice(0, limit)
      return { messages: this._deliver(agent, page), cursor: page.length ? page.at(-1).msg.seq : since, hasMore: all.length > page.length }
    }
    const since = msg.since ?? agent.cursor
    const match = scope === 'all' ? () => true : (e) => e.audience.has(agent.id)
    const all = this.log.filter(e => e.msg.seq > since && match(e))
    const page = all.slice(0, limit)
    const hasMore = all.length > page.length
    const cursor = hasMore ? page.at(-1).msg.seq : Math.max(since, this.seq)
    agent.cursor = Math.max(agent.cursor, cursor)
    return { messages: this._deliver(agent, page), cursor, hasMore }
  }

  _wait (agent, msg) {
    const L = this.limits
    let timeoutMs = opt(msg.timeoutMs) ? L.waitDefaultMs : msg.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) fail('timeoutMs must be a number')
    timeoutMs = Math.min(L.waitMaxMs, Math.max(0, Math.round(timeoutMs)))
    let thread = null
    if (!opt(msg.thread)) {
      if (!isStr(msg.thread) || !this.threads.has(msg.thread)) fail(`unknown thread: ${sanitize(String(msg.thread), 40)}`)
      thread = msg.thread
    }
    if (agent.wait) this._cancelWait(agent, 'superseded')
    const since = thread
      ? Math.min(this.seq, ...this.log.filter(e => e.msg.thread === thread && agent.unread.has(e.msg.seq)).map(e => e.msg.seq - 1))
      : null
    return new Promise((resolve, reject) => {
      const w = { thread, since, resolve, reject, timer: null, pending: false }
      agent.wait = w
      const done = (timedOut) => {
        clearTimeout(w.timer)
        if (agent.wait === w) agent.wait = null
        const entries = this._waitMatches(agent, w)
        const messages = this._deliver(agent, entries)
        let cursor
        if (thread) {
          cursor = entries.length ? entries.at(-1).msg.seq : w.since
        } else {
          agent.cursor = Math.max(agent.cursor, this.seq)
          cursor = agent.cursor
        }
        resolve({ messages, cursor, timedOut: timedOut && !messages.length })
      }
      w.check = () => {
        if (w.pending || !this._waitMatches(agent, w).length) return
        w.pending = true
        setImmediate(() => {
          w.pending = false
          if (agent.wait !== w) return
          if (this._waitMatches(agent, w).length) done(false)
        })
      }
      w.timer = setTimeout(() => { if (agent.wait === w) done(true) }, timeoutMs)
      w.timer.unref?.()
      if (this._waitMatches(agent, w).length) done(false)
    })
  }

  _waitMatches (agent, w) {
    if (!w.thread) return this.log.filter(e => agent.unread.has(e.msg.seq))
    return this.log.filter(e => e.msg.thread === w.thread && e.msg.seq > w.since && e.author !== agent.id)
  }

  _cancelWait (agent, error) {
    const w = agent.wait
    if (!w) return
    agent.wait = null
    clearTimeout(w.timer)
    if (error) w.reject(new AgentError(error))
  }

  _thread (agent, msg) {
    switch (msg.action) {
      case 'open': {
        const title = this._title(msg.title)
        const withIds = this._resolveNames(msg.with, 'with').filter(id => id !== agent.id)
        const wait = this._budget(agent, 'main')
        if (wait !== null) fail('rate limited', { retryAfterMs: wait })
        this._spend(agent, 'main')
        const t = this._createThread(agent, title, withIds)
        this._changed()
        return { thread: this._threadView(t) }
      }
      case 'resolve': {
        if (!isStr(msg.thread) || !this.threads.has(msg.thread)) fail(`unknown thread: ${sanitize(String(msg.thread ?? ''), 40)}`)
        const t = this.threads.get(msg.thread)
        if (t.status !== 'open') fail(`thread ${t.id} is already resolved`)
        const outcome = this._text(msg.outcome, this.limits.outcome, 'outcome')
        t.status = 'resolved'
        t.outcome = outcome
        t.resolvedAt = this.now()
        t.participants.add(agent.id)
        this._sys(`🧵 ${agent.name} resolved “${t.title}”`)
        this._append({ kind: 'decision', from: this._from(agent), thread: t.id, text: outcome }, { author: agent.id })
        return { thread: this._threadView(t) }
      }
      case 'list':
        return { threads: this._threadList() }
      default:
        fail('action must be open, resolve or list')
    }
  }

  _title (value) {
    if (!isStr(value)) fail('title must be a string')
    const title = sanitize(value, Infinity)
    if (!title) fail('title is empty')
    if (charCount(title) > this.limits.title) fail(`title too long (max ${this.limits.title} characters)`)
    this._scan(title)
    return title
  }

  _createThread (agent, title, withIds) {
    const slug = threadSlug(title)
    let id
    do id = `${slug}-${hex(1)}`; while (this.threads.has(id))
    const now = this.now()
    const t = { id, title, opener: agent.id, participants: new Set([agent.id, ...withIds]), status: 'open', outcome: null, count: 0, openedAt: now, lastAt: now, resolvedAt: null }
    this.threads.set(id, t)
    const names = withIds.map(i => this._nameOf(i))
    this._sys(`🧵 ${agent.name} opened “${title}”${names.length ? ' with ' + names.join(', ') : ''}`)
    return t
  }

  // --- messages ------------------------------------------------------------------

  _sys (text) {
    this._append({ kind: 'sys', from: null, text })
  }

  _append (m, { author = null, audience = null, mentions = null, toIds = [], replyTo = null } = {}) {
    const now = this.now()
    const msg = {
      seq: ++this.seq,
      id: hex(8),
      ts: now,
      kind: m.kind,
      from: m.from ?? null,
      thread: m.thread ?? null,
      to: m.to ?? [],
      replyTo: m.replyTo ?? null,
      text: m.text,
      intervention: m.kind === 'human'
    }
    const thread = msg.thread ? this.threads.get(msg.thread) : null
    let aud
    let men
    if (audience) {
      aud = new Set(audience)
      men = new Set(mentions || [])
    } else {
      men = new Set([...toIds, ...(msg.kind === 'sys' ? [] : this._mentionIds(msg.text))])
      aud = new Set(men)
      if (msg.kind === 'decision' || msg.kind === 'human') for (const a of this._live()) aud.add(a.id)
      if (replyTo !== null) { const parent = this.bySeq.get(replyTo); if (parent?.author) aud.add(parent.author) }
      if (thread) for (const id of thread.participants) aud.add(id)
    }
    if (author) { aud.delete(author); men.delete(author) }
    for (const id of aud) {
      const a = this.agents.get(id)
      if (!a || a.left) { aud.delete(id); men.delete(id) }
    }
    const entry = { msg, author, audience: aud }
    this.log.push(entry)
    this.bySeq.set(msg.seq, entry)
    if (thread) { thread.count++; thread.lastAt = now }
    for (const id of aud) this.agents.get(id).unread.set(msg.seq, men.has(id))
    for (const a of this.agents.values()) a.wait?.check()
    if (this.log.length > this.limits.historyMax) this._prune()
    this._changed()
    return entry
  }

  _msgView (entry) {
    const m = entry.msg
    return { ...m, from: m.from && { ...m.from }, to: [...m.to] }
  }

  _prune () {
    const now = this.now()
    const L = this.limits
    let drop = 0
    while (drop < this.log.length && (this.log.length - drop > L.historyMax || now - this.log[drop].msg.ts > L.historyMs)) drop++
    if (drop) {
      for (const e of this.log.splice(0, drop)) {
        this.bySeq.delete(e.msg.seq)
        for (const id of e.audience) this.agents.get(id)?.unread.delete(e.msg.seq)
      }
    }
    for (const [id, t] of this.threads) {
      const since = t.status === 'resolved' ? t.resolvedAt : t.lastAt
      if (now - since > L.threadMs) this.threads.delete(id)
    }
    if (drop) this._changed()
  }

  // --- views ------------------------------------------------------------------------

  card (agent) {
    return {
      id: agent.id,
      name: agent.name,
      display: this._display(agent),
      human: this.human,
      harness: agent.harness,
      repo: agent.repo,
      branch: agent.branch,
      worktree: agent.worktree,
      state: agent.state,
      summary: agent.summary,
      focus: { issue: agent.focus.issue, components: [...agent.focus.components], paths: [...agent.focus.paths] },
      present: agent.present,
      joinedAt: agent.joinedAt,
      updatedAt: agent.updatedAt,
      overlaps: agent.left ? [] : this._overlapping(agent).map(o => o.name)
    }
  }

  _cards () {
    return [...this.agents.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(a => this.card(a))
  }

  _threadView (t) {
    return {
      id: t.id,
      title: t.title,
      opener: this._nameOf(t.opener),
      participants: [...t.participants].map(id => this._nameOf(id)),
      status: t.status,
      outcome: t.outcome,
      messages: t.count,
      openedAt: t.openedAt,
      lastAt: t.lastAt
    }
  }

  _threadList () {
    return [...this.threads.values()]
      .sort((a, b) => (a.status === b.status ? b.lastAt - a.lastAt : a.status === 'open' ? -1 : 1))
      .map(t => this._threadView(t))
  }

  // --- humans (the `agents` stream) ---------------------------------------------------

  snapshot () {
    return {
      type: 'agents',
      v: AGENT_PROTOCOL,
      now: this.now(),
      tier: TIER,
      human: this.human,
      ack: this.ack,
      agents: this._cards(),
      threads: this._threadList(),
      messages: this.log.slice(-this.limits.snapshotMessages).map(e => this._msgView(e))
    }
  }

  // For the lounge `state` snapshot: null until an agent has connected.
  summary () {
    if (!this.everConnected) return null
    let open = 0
    for (const t of this.threads.values()) if (t.status === 'open') open++
    return { present: [...this.agents.values()].filter(a => a.present).length, openThreads: open }
  }

  // Commands on an agents-stream subscription. Throws to reply {ok:false, error}.
  command (msg) {
    switch (msg.cmd) {
      case 'agents.ack':
        if (!this.ack) {
          this.ack = true
          this.onAck()
          this._changed()
        }
        return undefined
      case 'agents.say': {
        if (!this.ack) fail('ack-required')
        const text = this._text(msg.text, this.limits.text)
        const thread = this._openThread(msg.thread)
        const toIds = this._resolveNames(msg.to)
        const entry = this._append({
          kind: 'human',
          from: { name: null, display: `${this.human} (human)`, human: this.human, harness: null, repo: null },
          thread: thread ? thread.id : null,
          to: toIds.map(id => this._nameOf(id)),
          text
        }, { toIds })
        return { message: this._msgView(entry) }
      }
      default:
        fail('unknown command')
    }
  }

  _changed () {
    if (!this.closed) this.emit('change')
  }

  close () {
    this.closed = true
    clearInterval(this.pruneTimer)
    for (const a of this.agents.values()) {
      clearTimeout(a.awayTimer)
      clearTimeout(a.removeTimer)
      this._cancelWait(a, 'shutting down')
      const peer = a.peer
      a.peer = null
      peer?.end()
    }
  }
}

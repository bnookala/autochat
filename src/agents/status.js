import { sanitize, charCount } from '../text.js'
import { STATES, AgentError, fail, isStr, int, opt } from './limits.js'
import { normalizeName } from './names.js'
import { normalizePath } from './overlap.js'

// Status: the `status` command (summary, state, focus, name), focus validation, and deferring a
// status that comes too soon after the last one. See docs/agent-room/status.md.

// The fields a deferred status keeps from earlier calls in the same gap, unless a later call
// sets them (null means "unchanged" for these). `parent` is kept the same way, except that null
// clears it, so only a call without it keeps the earlier one. Any other field comes from the
// latest call only, so a deferred status stays as small as one call.
const STATUS_FIELDS = ['summary', 'state', 'focus', 'name', 'title']

function mergeStatus (prev, msg) {
  const next = { ...msg }
  for (const k of STATUS_FIELDS) if (opt(next[k]) && !opt(prev[k])) next[k] = prev[k]
  if (next.parent === undefined && prev.parent !== undefined) next.parent = prev.parent
  if (!opt(prev.focus) && !opt(msg.focus)) next.focus = { ...prev.focus, ...msg.focus }
  return next
}

export const methods = {
  _status (agent, msg) {
    const L = this.limits
    const patch = {}
    if (!opt(msg.summary)) {
      if (!isStr(msg.summary)) fail('summary must be a string')
      if (msg.summary.length > L.summary * 4 + 256) fail(`summary too long (max ${L.summary} characters)`)
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
    // names.js: the card's title ("" restores the default) and its parent agent (null or "" for none).
    if (!opt(msg.title)) patch.ownTitle = this._statusTitle(msg.title)
    if (msg.parent !== undefined) patch.parent = this._statusParent(agent, msg.parent)
    let name = null
    if (!opt(msg.name)) {
      if (!isStr(msg.name) || !normalizeName(msg.name)) fail('name must use a-z, 0-9 and -')
      name = normalizeName(msg.name)
    }
    const now = this.now()
    if (agent.statusLater || (agent.lastStatusAt !== null && now - agent.lastStatusAt < L.statusGapMs)) {
      return this._deferStatus(agent, msg, Math.max(0, agent.lastStatusAt + L.statusGapMs - now))
    }
    agent.lastStatusAt = now
    Object.assign(agent, patch)
    if (patch.focus) this._indexPaths(agent)
    if (name && name !== agent.name) this._rename(agent, name)
    agent.updatedAt = now
    // overlap.js recomputes the agent's overlaps.
    this._hook('status', agent, msg)
    this._changed()
    return this._contribute('status', { agent, msg })
  },

  // Within the gap (or while one is waiting): kept, merged into any status already waiting, and
  // applied when the gap ends. The result is for the card as it is now.
  _deferStatus (agent, msg, appliesInMs) {
    const later = agent.statusLater || (agent.statusLater = { msg: {}, timer: null })
    later.msg = mergeStatus(later.msg, msg)
    if (!later.timer) {
      later.timer = setTimeout(() => this._statusLater(agent), appliesInMs)
      later.timer.unref?.()
    }
    return { ...this._contribute('status', { agent, msg }), deferred: true, appliesInMs }
  },

  _statusLater (agent) {
    const later = agent.statusLater
    agent.statusLater = null
    if (!later || agent.left || this.closed) return
    agent.lastStatusAt = null // the gap is over
    try {
      this._status(agent, later.msg)
    } catch (err) {
      // It was valid when it was deferred; only the room can have changed since.
      if (!(err instanceof AgentError)) this.emit('error-log', err)
    }
  },

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
}

export function register (r) {
  r.command('status', methods._status)
  // A status waiting for the end of its gap: {msg, timer}, or null.
  r.on('join', function (agent, { resumed }) {
    if (!resumed) agent.statusLater = null
  })
  r.on('leave', function (agent) {
    clearTimeout(agent.statusLater?.timer)
    agent.statusLater = null
  })
  r.contribute('card', function ({ agent }) {
    return {
      state: agent.state,
      summary: agent.summary,
      focus: { issue: agent.focus.issue, components: [...agent.focus.components], paths: [...agent.focus.paths] }
    }
  })
  r.contribute('status', function ({ agent }) {
    return { card: this.card(agent) }
  })
}

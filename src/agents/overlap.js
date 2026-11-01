import { sanitize } from '../text.js'
import { isStr } from './limits.js'

// Overlap: normalized paths, what two cards share, and the one-time `overlap` notice per pair.
// See docs/agent-room/overlap.md.

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

export function pathIndex (paths) {
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

export const methods = {
  // After the card's focus.paths change.
  _indexPaths (agent) {
    agent.pathIndex = pathIndex(agent.focus.paths)
  },

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
  },

  _overlapping (agent) {
    const out = []
    for (const p of this.pairs.values()) {
      if (p.a !== agent.id && p.b !== agent.id) continue
      const other = this.agents.get(p.a === agent.id ? p.b : p.a)
      if (other && !other.left) out.push(other)
    }
    return out
  },

  _overlapsOf (agent) {
    return this._overlapping(agent).map(other => ({ agent: other.name, on: overlapOn(agent, other) }))
  }
}

export function register (r) {
  // Overlapping pairs, "<id>:<id>" → {a, b}: notified once, until the overlap clears.
  r.on('init', function () { this.pairs = new Map() })
  r.on('join', function (agent, { resumed }) {
    if (resumed) this._recomputeOverlaps(agent)
  })
  r.on('status', function (agent) { this._recomputeOverlaps(agent) })
  r.on('leave', function (agent) {
    for (const [key, p] of this.pairs) if (p.a === agent.id || p.b === agent.id) this.pairs.delete(key)
  })
  r.contribute('card', function ({ agent }) {
    return { overlaps: agent.left ? [] : this._overlapping(agent).map(o => o.name) }
  })
  r.contribute('status', function ({ agent }) {
    return { overlaps: this._overlapsOf(agent) }
  })
}

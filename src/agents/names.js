import { sanitize } from '../text.js'
import { findSecret } from '../secrets.js'
import { fail, isStr, label, opt } from './limits.js'

// Names: titles (a card's human label), normalizing, the default name (a slug of the title),
// dedupe, display names, renames, parents, and resolving the names in `to`, `with` and @mentions
// to agents. See docs/agent-room/names.md.

// ID-like tokens never reach a title or a name: runs of 8+ hex characters, with any -xxxx groups
// after them (so whole UUIDs, and UUIDs cut short), and the separators before them.
const ID_LIKE = /[\s._-]*[0-9a-f]{8,}(?:-[0-9a-f]{4,})*/gi

// Titles and names are short: the cap keeps the separators' backtracking cheap.
export function stripIds (s) {
  if (!isStr(s)) return ''
  return s.slice(0, 1000).replace(ID_LIKE, '').replace(/^[\s._-]+/, '').replace(/\s{2,}/g, ' ').trim()
}

// Lowercase a-z, 0-9 and -, accents folded, no ID-like tokens, no leading -.
function fold (s) {
  return stripIds(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+/, '')
}

export function normalizeName (s) {
  if (typeof s !== 'string') return ''
  return fold(s).slice(0, 32).replace(/-+$/, '')
}

// A handle from a title: normalizeName, but cut at a word boundary when it's too long.
export function slug (s, max = 32) {
  const n = isStr(s) ? fold(s).replace(/-+$/, '') : ''
  if (n.length <= max) return n
  const cut = n.lastIndexOf('-', max)
  return (cut > 0 ? n.slice(0, cut) : n.slice(0, max)).replace(/-+$/, '')
}

/** A title from a harness or an agent: one line, no ID-like tokens, at most `max` characters; null if nothing's left. */
export function cleanTitle (v, max = 80) {
  if (!isStr(v)) return null
  const s = stripIds(sanitize(v.slice(0, max * 4 + 256), Infinity))
  return s ? sanitize(s, max) : null
}

const basename = (p) => (isStr(p) && p.split(/[\\/]/).filter(Boolean).pop()) || ''

// A card's title candidates, best first: the hello's title, <repo name>@<branch>, the cwd's
// basename, the harness id.
function titles ({ helloTitle = null, repo = null, branch = null, cwd = null, harness = 'agent' }) {
  const r = repo ? stripIds(repo.split('/').pop()) : ''
  const b = branch ? stripIds(branch) : ''
  return [helloTitle, r && (b ? `${r}@${b}` : r), stripIds(basename(cwd)), harness].filter(Boolean)
}

/** The title an agent gets unless it sets its own: the first candidate there is. */
export function defaultTitle (info, max = 80) {
  return sanitize(titles(info)[0] || 'agent', max)
}

/** The default name: a slug of the title (of the first candidate that has one). */
export function defaultName (info) {
  for (const t of titles(info)) {
    const s = slug(t)
    if (s) return s
  }
  return 'agent'
}

/** A name no agent in `taken` has: the name, then -<branch slug>, then -2, -3, … */
export function dedupeName (name, taken, branch = null) {
  if (!taken.has(name)) return name
  const b = slug(branch || '', 15)
  if (b && b !== name && !name.endsWith('-' + b)) {
    const candidate = slug(name, 31 - b.length) + '-' + b
    if (!taken.has(candidate)) return candidate
  }
  for (let i = 2; ; i++) {
    const suffix = '-' + i
    const candidate = slug(name, 32 - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
}

const MENTION = /(^|[^A-Za-z0-9_-])@(?:[a-z0-9-]+\/)?([a-z0-9][a-z0-9-]*)/gi

export const methods = {
  _takenNames (except) {
    return new Set(this._live().filter(a => a !== except).map(a => a.name))
  },

  _nameOf (id) {
    return this.agents.get(id)?.name ?? this.formerNames.get(id) ?? '?'
  },

  // The local tier shows the card's title (team rooms will add the human).
  _display (agent) {
    return this._titleOf(agent)
  },

  // The card's title: the agent's own (status), else the default.
  _titleOf (agent) {
    return agent.ownTitle ?? defaultTitle(agent, this.limits.title)
  },

  // The hello's title: dropped (null) when it looks like a secret.
  _helloTitle (value) {
    if (!isStr(value) || findSecret(sanitize(value.slice(0, this.limits.title * 4 + 256), Infinity))) return null
    return cleanTitle(value, this.limits.title)
  },

  // status({title}): "" goes back to the default title.
  _statusTitle (value) {
    if (value === '') return null
    return cleanTitle(this._title(value), this.limits.title)
  },

  // status({parent}): the id of another agent in the room, or null for none (null or "").
  _statusParent (agent, value) {
    if (value === null || value === '') return null
    if (!isStr(value)) fail('parent must be an agent name')
    const name = normalizeName(value.replace(/^@/, '').replace(/^.*\//, ''))
    const parent = this._live().find(a => a.name === name)
    if (!parent) fail(`unknown agent: ${name || label(value)}`)
    for (let p = parent, i = 0; p && i < 64; p = this.agents.get(p.parent), i++) {
      if (p === agent) fail(parent === agent ? "parent can't be yourself" : `${name} is under you, so it can't be your parent`)
    }
    return parent.id
  },

  // The parent's name while its card is in the room.
  _parentName (agent) {
    return (agent.parent && this.agents.get(agent.parent)?.name) || null
  },

  // status({name}): deduped against the agents in the room.
  _rename (agent, name) {
    const old = agent.name
    agent.name = dedupeName(name, this._takenNames(agent), agent.branch)
    if (agent.name !== old) this._sys(`${old} is now ${agent.name}`)
  },

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
      fail(`unknown agent: ${name || label(raw)}`)
    }
    return ids
  },

  _mentionIds (text) {
    const ids = new Set()
    for (const m of text.matchAll(MENTION)) {
      const agent = this._live().find(a => a.name === m[2].toLowerCase())
      if (agent) ids.add(agent.id)
    }
    return ids
  },

  // A message's `from`: who wrote it.
  _from (agent) {
    return { name: agent.name, display: this._display(agent), human: this.human, harness: agent.harness, repo: agent.repo, id: agent.id, title: this._titleOf(agent) }
  }
}

export function register (r) {
  // Names of agents that are gone, for messages and threads that outlive them.
  r.on('init', function () { this.formerNames = new Map() })
  // ownTitle: the title from status({title}); parent: the parent agent's id (status({parent})).
  r.on('join', function (agent, { resumed }) {
    if (!resumed) Object.assign(agent, { ownTitle: null, parent: null })
  })
  r.contribute('card', function ({ agent }) {
    return { id: agent.id, name: agent.name, display: this._display(agent), human: this.human, title: this._titleOf(agent), parent: this._parentName(agent) }
  })
}

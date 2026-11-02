import { fail, isStr, opt } from './limits.js'

// Names: normalizing, the default name, dedupe, display names, renames, and resolving the names
// in `to`, `with` and @mentions to agents. See docs/agent-room/names.md.

export function normalizeName (s) {
  if (typeof s !== 'string') return ''
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
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

const MENTION = /(^|[^A-Za-z0-9_-])@(?:[a-z0-9-]+\/)?([a-z0-9][a-z0-9-]*)/gi

export const methods = {
  _takenNames (except) {
    return new Set(this._live().filter(a => a !== except).map(a => a.name))
  },

  _nameOf (id) {
    return this.agents.get(id)?.name ?? this.formerNames.get(id) ?? '?'
  },

  _display (agent) {
    return `${this.human}/${agent.name}`
  },

  // status({name}): deduped against the agents in the room.
  _rename (agent, name) {
    const old = agent.name
    agent.name = dedupeName(name, this._takenNames(agent))
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
      fail(`unknown agent: ${name || raw}`)
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
    return { name: agent.name, display: this._display(agent), human: this.human, harness: agent.harness, repo: agent.repo, id: agent.id }
  }
}

export function register (r) {
  // Names of agents that are gone, for messages and threads that outlive them.
  r.on('init', function () { this.formerNames = new Map() })
  r.contribute('card', function ({ agent }) {
    return { id: agent.id, name: agent.name, display: this._display(agent), human: this.human }
  })
}

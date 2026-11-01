import { sanitize, charCount } from '../text.js'
import { fail, hex, isStr, label, opt } from './limits.js'
import { overlapOn } from './overlap.js'

// Threads: the `thread` command (open, resolve, list), thread ids and titles, and the decision a
// resolve posts: its owner and next steps, who has seen it, its record, and the decisions that
// catchUp shows as relevant. See docs/agent-room/threads.md.

function threadSlug (title) {
  let slug = ''
  for (const w of title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (slug && slug.length + w.length + 1 > 24) break
    slug = slug ? slug + '-' + w : w.slice(0, 24)
  }
  return slug || 'thread'
}

// The title of a thread a question opens: its first sentence (or line), cut at a word boundary
// to at most `max` characters, with "…" when cut.
function firstSentence (text, max = 60) {
  const line = sanitize(text.split('\n').find(l => l.trim()) || text, Infinity)
  const end = line.search(/[.?!](?=\s|$)|[。？！]/)
  const sentence = (end === -1 ? line : line.slice(0, end + 1)).replace(/[\s.]+$/, '') || line
  const chars = Array.from(sentence)
  if (chars.length <= max) return sentence
  const head = chars.slice(0, max - 1).join('')
  const words = /\s/.test(chars[max - 1]) ? head : head.replace(/\s+\S*$/, '')
  return (words.trim() ? words : head).replace(/[\s,;:.-]+$/, '') + '…'
}

export const methods = {
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
        if (!isStr(msg.thread) || !this.threads.has(msg.thread)) fail(`unknown thread: ${label(msg.thread)}`)
        const t = this.threads.get(msg.thread)
        // Two agents resolving the same thread: the first outcome stands.
        if (t.status !== 'open') return { thread: this._threadView(t), alreadyResolved: true, record: this._record(t) }
        const outcome = this._text(msg.outcome, this.limits.outcome, 'outcome')
        const owner = this._owner(agent, msg.owner)
        const next = this._nextSteps(msg.next)
        t.status = 'resolved'
        t.outcome = outcome
        t.resolvedAt = this.now()
        t.resolvedBy = agent.id
        t.owner = owner
        t.next = next
        t.participants.add(agent.id)
        t.focus = this._threadFocus(t)
        this._sys(`🧵 ${agent.name} resolved “${t.title}”`)
        // The `post` hook below makes it the thread's decision.
        this._append({ kind: 'decision', from: this._from(agent), thread: t.id, text: outcome }, { author: agent.id })
        return { thread: this._threadView(t), record: this._record(t) }
      }
      case 'list':
        return { threads: this._threadList() }
      default:
        fail('action must be open, resolve or list')
    }
  },

  // The title of the thread a question opens: `title` (≤ 80 characters) or its first sentence.
  _threadTitle (title, text) {
    return opt(title) ? firstSentence(text) : this._title(title)
  },

  // A thread to post in: null, or an open thread.
  _openThread (thread) {
    if (opt(thread)) return null
    if (!isStr(thread)) fail('thread must be a thread id')
    const t = this.threads.get(thread)
    if (!t) fail(`unknown thread: ${label(thread)}`)
    if (t.status !== 'open') fail(`thread ${t.id} is resolved`)
    return t
  },

  _createThread (agent, title, withIds) {
    const slug = threadSlug(title)
    let id
    do id = `${slug}-${hex(1)}`; while (this.threads.has(id))
    const now = this.now()
    // A resolve sets resolvedAt and resolvedBy, owner and next, the participants' focus, and the
    // decision (its log entry).
    const t = { id, title, opener: agent.id, participants: new Set([agent.id, ...withIds]), status: 'open', outcome: null, count: 0, openedAt: now, lastAt: now, resolvedAt: null, resolvedBy: null, owner: null, next: [], focus: [], decision: null }
    this.threads.set(id, t)
    const names = withIds.map(i => this._nameOf(i))
    this._sys(`🧵 ${agent.name} opened “${title}”${names.length ? ' with ' + names.join(', ') : ''}`)
    return t
  },

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
      lastAt: t.lastAt,
      owner: t.owner && this._nameOf(t.owner),
      next: [...t.next],
      resolvedBy: t.resolvedBy && this._nameOf(t.resolvedBy),
      resolvedAt: t.resolvedAt
    }
  },

  // `owner`: an agent in the room; by default, whoever resolves.
  _owner (agent, owner) {
    if (opt(owner)) return agent.id
    if (!isStr(owner)) fail('owner must be an agent name')
    const [id] = this._resolveNames([owner], 'owner')
    if (this.agents.get(id)?.left) fail(`${this._nameOf(id)} left the room`)
    return id
  },

  // `next`: up to 5 next steps, one line of ≤ 140 characters each.
  _nextSteps (next) {
    const L = this.limits
    if (opt(next)) return []
    if (!Array.isArray(next) || next.some(s => !isStr(s))) fail('next must be a list of strings')
    if (next.length > L.nextSteps) fail(`next has too many entries (max ${L.nextSteps})`)
    const out = []
    for (const raw of next) {
      const step = raw.length > L.nextStep * 4 + 256 ? null : sanitize(raw, Infinity)
      if (step === null || charCount(step) > L.nextStep) fail(`next entries are at most ${L.nextStep} characters`)
      this._scan(step)
      if (step) out.push(step)
    }
    return out
  },

  // A thread's focus, captured when it's resolved: its participants' repo, issue, components and
  // paths, so its decision can find agents that overlap it after they have all left.
  _threadFocus (t) {
    const out = []
    for (const id of t.participants) {
      const a = this.agents.get(id)
      if (a?.repo) out.push({ repo: a.repo, focus: { ...a.focus }, pathIndex: a.pathIndex })
    }
    return out
  },

  // Up to 10 decisions whose thread's focus overlaps your card, posted before you joined or not.
  // It leaves out what catchUp returns anyway: your unread messages (`inbox`) and the last 10
  // decisions (`decisions`). The newest ones, oldest first.
  _relevant (agent) {
    const L = this.limits
    const last = new Set(this.log.filter(e => e.msg.kind === 'decision').slice(-L.decisions))
    const out = []
    const resolved = [...this.threads.values()].filter(t => t.decision).sort((a, b) => b.decision.msg.seq - a.decision.msg.seq)
    for (const t of resolved) {
      if (out.length === L.relevant) break
      const e = t.decision
      if (last.has(e) || agent.unread.has(e.msg.seq)) continue
      if (t.focus.some(f => overlapOn(agent, f))) out.push(e)
    }
    return out.reverse()
  },

  // The record of a decision, in markdown, for the PR description or the linked issue.
  _record (t) {
    const d = new Date(t.resolvedAt)
    const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-')
    return [
      `### Decision: ${t.title}`,
      '',
      ...t.outcome.split('\n').map(l => l ? '> ' + l : '>'),
      '',
      `- **Owner:** ${this._nameOf(t.owner)}`,
      `- **Next steps:**${t.next.length ? '' : ' none'}`,
      ...t.next.map(s => `  - [ ] ${s}`),
      `- **Participants:** ${[...t.participants].map(id => this._nameOf(id)).join(', ')}`,
      `- **Decided:** ${day}, in the autochat agent room (thread \`${t.id}\`)`
    ].join('\n')
  },

  // Open first, then resolved; newest activity first.
  _threadList () {
    return [...this.threads.values()]
      .sort((a, b) => (a.status === b.status ? b.lastAt - a.lastAt : a.status === 'open' ? -1 : 1))
      .map(t => this._threadView(t))
  }
}

export function register (r) {
  r.on('init', function () { this.threads = new Map() })
  r.command('thread', methods._thread)
  r.on('post', function (entry, { thread }) {
    if (thread) { thread.count++; thread.lastAt = entry.msg.ts }
    // A resolve's decision (nothing else can be posted in a resolved thread): its owner and next
    // steps, and who has seen it, starting with whoever resolved it.
    if (thread?.status === 'resolved' && entry.msg.kind === 'decision' && !thread.decision) {
      thread.decision = entry
      entry.decision = { owner: thread.owner, next: thread.next, seenBy: new Set([entry.author]) }
    }
  })
  // Seen: catchUp, read or wait returned it to the agent.
  r.on('deliver', function (agent, entries) {
    let seen = false
    for (const e of entries) {
      if (e.decision && !e.decision.seenBy.has(agent.id)) { e.decision.seenBy.add(agent.id); seen = true }
    }
    if (seen) this._changed()
  })
  r.contribute('message', function ({ entry }) {
    const d = entry.decision
    return d ? { decision: { owner: this._nameOf(d.owner), next: [...d.next], seenBy: [...d.seenBy].map(id => this._nameOf(id)) } } : null
  })
  r.contribute('catchUp', function () {
    return { threads: this._threadList() }
  })
  r.contribute('catchUp', function ({ agent }) {
    return { relevant: this._deliver(agent, this._relevant(agent)) }
  })
  r.contribute('post', function ({ thread }) {
    return thread ? { thread: this._threadView(thread) } : null
  })
}

import { fail, hex, isStr, label, opt } from './limits.js'

// Threads: the `thread` command (open, resolve, list), thread ids, and the decision a resolve
// posts. See docs/agent-room/threads.md.

function threadSlug (title) {
  let slug = ''
  for (const w of title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (slug && slug.length + w.length + 1 > 24) break
    slug = slug ? slug + '-' + w : w.slice(0, 24)
  }
  return slug || 'thread'
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
    const t = { id, title, opener: agent.id, participants: new Set([agent.id, ...withIds]), status: 'open', outcome: null, count: 0, openedAt: now, lastAt: now, resolvedAt: null }
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
      lastAt: t.lastAt
    }
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
  })
  r.contribute('catchUp', function () {
    return { threads: this._threadList() }
  })
  r.contribute('post', function ({ thread }) {
    return thread ? { thread: this._threadView(thread) } : null
  })
}

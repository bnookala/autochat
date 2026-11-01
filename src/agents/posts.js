import { POST_KINDS, fail, int, opt } from './limits.js'

// Posts: the `post` command, its recipients, and the question that opens a thread.
// See docs/agent-room/posts.md.

export const methods = {
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
      const title = this._threadTitle(msg.title, text)
      this._spend(agent, 'main')
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
    return this._contribute('post', { agent, msg, entry, thread })
  }
}

export function register (r) {
  r.command('post', methods._agentPost)
  r.contribute('post', function ({ entry }) {
    return { message: this._msgView(entry) }
  })
}

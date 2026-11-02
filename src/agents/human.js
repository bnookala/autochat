import { AGENT_PROTOCOL, TIER, fail } from './limits.js'

// Humans: the `agents` stream snapshot, the lounge's summary of the room, and the agents-stream
// commands `agents.ack` and `agents.say`. See docs/agent-room/human.md.

export const methods = {
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
  },

  // For the lounge `state` snapshot: null until an agent has connected.
  summary () {
    if (!this.everConnected) return null
    let open = 0
    for (const t of this.threads.values()) if (t.status === 'open') open++
    return { present: [...this.agents.values()].filter(a => a.present).length, openThreads: open }
  },

  _ack () {
    if (!this.ack) {
      this.ack = true
      this.onAck()
      this._changed()
    }
    return undefined
  },

  _say (msg) {
    if (!this.ack) fail('ack-required')
    const text = this._text(msg.text, this.limits.text)
    const thread = this._openThread(msg.thread)
    const toIds = this._resolveNames(msg.to)
    const entry = this._append({
      kind: 'human',
      from: { name: null, display: `${this.human} (human)`, human: this.human, harness: null, repo: null, id: null },
      thread: thread ? thread.id : null,
      to: toIds.map(id => this._nameOf(id)),
      text
    }, { toIds })
    return { message: this._msgView(entry) }
  }
}

export function register (r) {
  r.humanCommand('agents.ack', methods._ack)
  r.humanCommand('agents.say', methods._say)
}

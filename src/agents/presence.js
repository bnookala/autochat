// Presence: a closed connection makes the agent away; after the resume window it has left (a
// `sys` line), and its card lingers, then goes. See docs/agent-room/presence.md.

export const methods = {
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
  },

  _leave (agent) {
    if (agent.left) return
    agent.left = true
    agent.leftAt = this.now()
    agent.awayTimer = null
    agent.unread.clear()
    this.tokens.delete(agent.token)
    // overlap.js forgets the agent's overlapping pairs.
    this._hook('leave', agent)
    if (agent.active !== false) this._sys(`${agent.name} left`)
    agent.removeTimer = setTimeout(() => this._remove(agent), this.limits.lingerMs)
    agent.removeTimer.unref?.()
    this.emit('presence', 'left', this.card(agent))
    this._changed()
  },

  _remove (agent) {
    this.formerNames.set(agent.id, agent.name)
    if (this.formerNames.size > 1000) this.formerNames.delete(this.formerNames.keys().next().value)
    this.agents.delete(agent.id)
    this._changed()
  },

  // Agents that haven't left: present, or away within the resume window.
  _live () {
    return [...this.agents.values()].filter(a => !a.left)
  }
}

export function register (r) {
  r.contribute('card', function ({ agent }) {
    return { present: agent.present, joinedAt: agent.joinedAt, updatedAt: agent.updatedAt }
  })
}

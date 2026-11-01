// Presence: an agent is here (connected), away (its connection dropped; it can resume within the
// resume window) or left (it said `bye`, or the window ended: a `sys` line). A left card lingers,
// then goes. See docs/agent-room/presence.md.

export const methods = {
  // here | away | left
  _presence (agent) {
    return agent.left ? 'left' : agent.present ? 'here' : 'away'
  },

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

  // `bye`: the agent leaves now, rather than after the resume window, and its connection closes.
  _bye (agent, msg) {
    const peer = agent.peer
    // Detached first: nothing else on this connection reaches the room, and its close is no news.
    agent.peer = null
    agent.present = false
    this._cancelWait(agent)
    this._leave(agent)
    // The reply is the connection's last line. It can't go the usual way (index.js _onLine),
    // which only answers the agent's current connection.
    peer.end({ type: 'reply', id: msg.id ?? null, ok: true, result: {}, inbox: this._inbox(agent) })
    return {}
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
  r.command('bye', methods._bye)
  r.contribute('card', function ({ agent }) {
    const presence = this._presence(agent)
    return { present: presence === 'here', joinedAt: agent.joinedAt, updatedAt: agent.updatedAt, presence, leftAt: agent.leftAt }
  })
}

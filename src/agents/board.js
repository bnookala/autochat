import { TIER } from './limits.js'

// The board: cards, the `catchUp` command, and the cards in the human snapshot.
// See docs/agent-room/board.md.

export const methods = {
  // An agent's card: the fields every module contributes ('card' contributors).
  card (agent) {
    return this._contribute('card', { agent })
  },

  // Every card, oldest first, including agents that left and still linger.
  _cards () {
    return [...this.agents.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(a => this.card(a))
  },

  _catchUp (agent, msg) {
    return this._contribute('catchUp', { agent, msg })
  }
}

export function register (r) {
  r.command('catchUp', methods._catchUp)
  r.contribute('catchUp', function ({ agent }) {
    return {
      you: this.card(agent),
      tier: TIER,
      board: this._cards().filter(c => c.id !== agent.id)
    }
  })
}

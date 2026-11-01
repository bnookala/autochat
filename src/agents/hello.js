import { AGENT_PROTOCOL, TIER, hex, isStr, int } from './limits.js'
import { normalizeName, defaultName, dedupeName } from './names.js'
import { pathIndex } from './overlap.js'
import { sanitize } from '../text.js'

// Hello: an agent connects, its hello is parsed, it gets a welcome and a resume token, and a
// resume reclaims the same agent. See docs/agent-room/hello.md.

export const methods = {
  /**
   * A new agent connection whose first line was `agent-hello`. `peer` is
   * {send(obj), end(obj)}. Returns the connection handler {message(msg), close()}, or null
   * after refusing (the error line is sent and the connection ended).
   */
  connect (hello, peer) {
    const refuse = (error) => { peer.end({ type: 'error', v: AGENT_PROTOCOL, error }); return null }
    if (this.closed) return refuse('shutting down')
    if (hello.v !== undefined && hello.v !== AGENT_PROTOCOL) return refuse('unsupported protocol version')
    const info = this._helloInfo(hello)
    let agent = isStr(hello.resume) ? this.agents.get(this.tokens.get(hello.resume)) : null
    if (agent?.left) agent = null
    const resumed = !!agent
    if (agent) {
      clearTimeout(agent.awayTimer)
      agent.awayTimer = null
      this._cancelWait(agent, 'superseded')
      const old = agent.peer
      agent.peer = null
      if (old) old.end()
      Object.assign(agent, info)
    } else {
      if (this._live().length >= this.limits.maxAgents) return refuse('too many agents')
      const now = this.now()
      const taken = this._takenNames()
      const name = dedupeName(normalizeName(hello.name) || defaultName(info), taken)
      agent = {
        id: this._newAgentId(),
        token: hex(16),
        name,
        ...info,
        state: 'idle',
        summary: null,
        focus: { issue: null, components: [], paths: [] },
        pathIndex: pathIndex([]),
        joinedAt: now,
        updatedAt: now,
        present: true,
        left: false,
        leftAt: null,
        cursor: this.seq,
        unread: new Map(),
        posts: { main: [], thread: [] },
        lastStatusAt: null,
        wait: null,
        awayTimer: null,
        removeTimer: null,
        peer: null
      }
      this.agents.set(agent.id, agent)
      this.tokens.set(agent.token, agent.id)
    }
    agent.peer = peer
    agent.present = true
    this.everConnected = true
    peer.send({
      type: 'agent-welcome',
      v: AGENT_PROTOCOL,
      tier: TIER,
      room: 'local',
      resume: agent.token,
      agent: { id: agent.id, name: agent.name, human: this.human, display: this._display(agent), harness: agent.harness }
    })
    // presence.js posts "<name> joined" for a new agent; overlap.js recomputes a resumed one's.
    this._hook('join', agent, { resumed })
    this.emit('presence', resumed ? 'back' : 'joined', this.card(agent))
    this._changed()
    return {
      message: (msg) => this._onLine(agent, peer, msg),
      close: () => this._onClose(agent, peer)
    }
  },

  _helloInfo (h) {
    const str = (v, max) => isStr(v) && v ? sanitize(v, max) : null
    const pid = (v) => int(v) && v > 0 ? v : null
    const repo = isStr(h.repo) && /^[\w.-]+\/[\w.-]+$/.test(h.repo) && h.repo.length <= 140 ? h.repo : null
    return {
      harness: normalizeName(h.harness).slice(0, 20) || 'agent',
      pid: pid(h.pid),
      harnessPid: pid(h.harnessPid),
      sessionId: str(h.sessionId, 128),
      cwd: str(h.cwd, 300),
      repo,
      branch: str(h.branch, 200),
      worktree: str(h.worktree, 100)
    }
  },

  _newAgentId () {
    let id
    do id = hex(4); while (this.agents.has(id))
    return id
  }
}

export function register (r) {
  // Resume tokens → agent ids, while an agent can still resume.
  r.on('init', function () { this.tokens = new Map() })
  r.contribute('card', function ({ agent }) {
    return { harness: agent.harness, repo: agent.repo, branch: agent.branch, worktree: agent.worktree }
  })
}

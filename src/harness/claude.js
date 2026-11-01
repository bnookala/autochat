import path from 'node:path'
import { exists } from './util.js'
import { SERVER, argsFor } from './mcp-config.js'
import { defaultAutonomy } from './event.js'

// Claude Code. MCP registration goes through its CLI (user scope). Hooks: not yet.

const mcp = {
  where () { return 'claude mcp (user scope)' },
  // `claude mcp get` prints Command:/Args: lines, and exits 1 when there's no such server.
  status (ctx) {
    const binary = ctx.which('claude')
    if (!binary) return { registered: false }
    const r = ctx.run(binary, ['mcp', 'get', SERVER])
    if (r.status !== 0) return { registered: false }
    const field = (k) => (new RegExp(`^\\s*${k}:[ \\t]*(.*)$`, 'm').exec(r.stdout || '') || [])[1]?.trim() ?? ''
    const command = field('Command')
    const args = field('Args')
    const binPath = (/(\S.*?autochat\.js)(?: |$)/.exec(args) || [])[1]
    return {
      registered: true,
      valid: !!command && exists(command) && !!binPath && exists(binPath) && /(^| )mcp( |$)/.test(args),
      command: `${command} ${args}`.trim(),
      args
    }
  },
  plan (ctx) {
    const binary = ctx.which('claude')
    const want = argsFor('claude', ctx)
    const st = this.status(ctx)
    const current = st.registered && st.command === [ctx.node, ...want].join(' ')
    if (current) return { id: 'claude', action: 'none' }
    const add = ['mcp', 'add', '--scope', 'user', SERVER, '--', ctx.node, ...want]
    return {
      id: 'claude',
      action: st.registered ? 'update' : 'add',
      command: ['claude', ...add],
      apply: () => {
        if (st.registered) ctx.run(binary, ['mcp', 'remove', '--scope', 'user', SERVER])
        const r = ctx.run(binary, add)
        if (r.status !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
      }
    }
  },
  unplan (ctx) {
    const binary = ctx.which('claude')
    if (!binary || !this.status(ctx).registered) return { id: 'claude', action: 'none' }
    return {
      id: 'claude',
      action: 'remove',
      command: ['claude', 'mcp', 'remove', '--scope', 'user', SERVER],
      apply: () => {
        const r = ctx.run(binary, ['mcp', 'remove', '--scope', 'user', SERVER])
        if (r.status !== 0) throw new Error(`claude mcp remove failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
      }
    }
  }
}

export default {
  id: 'claude',
  name: 'Claude Code',
  modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto', 'headless'],
  trigger: ['auto', 'headless'],
  detect (ctx) {
    const binary = ctx.which('claude')
    return { installed: !!binary, binary, paths: { settings: path.join(ctx.claudeHome, 'settings.json') } }
  },
  normalize: () => null,
  autonomy: defaultAutonomy,
  mcp
}

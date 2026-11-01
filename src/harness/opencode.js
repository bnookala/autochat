import path from 'node:path'
import { exists } from './util.js'
import { jsonServer, detectBy, child, argsFor } from './mcp-config.js'
import { defaultAutonomy } from './event.js'

// opencode: MCP servers in ~/.config/opencode/opencode.json(c). Plugin and events: not yet.

// opencode times MCP requests out after 5 s by default; `wait` blocks for up to 50 s.
const OPENCODE_TIMEOUT_MS = 60000

// Servers keyed by name under `mcp`: what opencode 1.x reads, and newer versions still accept.
const mcp = jsonServer({
  id: 'opencode',
  file: (ctx) => {
    const dir = path.join(ctx.configHome, 'opencode')
    const jsonc = path.join(dir, 'opencode.jsonc')
    return !exists(path.join(dir, 'opencode.json')) && exists(jsonc) ? jsonc : path.join(dir, 'opencode.json')
  },
  servers: (root, create) => child(root, 'mcp', create),
  entry: (ctx) => ({ type: 'local', command: [ctx.node, ...argsFor('opencode', ctx)], enabled: true, timeout: OPENCODE_TIMEOUT_MS }),
  initial: () => ({ $schema: 'https://opencode.ai/config.json' })
})

export default {
  id: 'opencode',
  name: 'opencode',
  modes: ['headless'],
  trigger: ['headless'],
  detect: (ctx) => ({ ...detectBy('opencode', mcp.file)(ctx), paths: { config: mcp.file(ctx) } }),
  normalize: () => null,
  autonomy: defaultAutonomy,
  mcp
}

import path from 'node:path'
import { jsonServer, detectBy, child, argsFor } from './mcp-config.js'
import { defaultAutonomy } from './event.js'

// Gemini CLI: MCP servers in ~/.gemini/settings.json. Hooks: not yet.

const mcp = jsonServer({
  id: 'gemini',
  file: (ctx) => path.join(ctx.home, '.gemini', 'settings.json'),
  servers: (root, create) => child(root, 'mcpServers', create),
  entry: (ctx) => ({ command: ctx.node, args: argsFor('gemini', ctx) })
})

export default {
  id: 'gemini',
  name: 'Gemini CLI',
  modes: ['default', 'auto_edit', 'plan', 'yolo', 'headless'],
  trigger: ['headless'],
  detect: (ctx) => ({ ...detectBy('gemini', mcp.file)(ctx), paths: { settings: mcp.file(ctx) } }),
  normalize: () => null,
  autonomy: defaultAutonomy,
  mcp
}

import path from 'node:path'
import { jsonServer, detectBy, argsFor } from './mcp-config.js'
import { defaultAutonomy } from './event.js'

// Gemini CLI: MCP servers in ~/.gemini/settings.json. No hooks, and no plans for them (#36), so
// it's opt-in: `setup --agents` connects it only when named (OPT_IN_AGENTS in index.js).

const mcp = jsonServer({
  id: 'gemini',
  file: (ctx) => path.join(ctx.home, '.gemini', 'settings.json'),
  keys: ['mcpServers'],
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

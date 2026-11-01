import { defaultAutonomy } from './event.js'

// pi: no MCP, no hooks yet.

export default {
  id: 'pi',
  name: 'pi',
  modes: ['headless'],
  trigger: ['headless'],
  detect (ctx) { const binary = ctx.which('pi'); return { installed: !!binary, binary, paths: {} } },
  normalize: () => null,
  autonomy: defaultAutonomy,
  mcp: {
    where () { return null },
    status () { return { registered: false, unsupported: true } },
    plan () { return { id: 'pi', action: 'unsupported', reason: 'no MCP support: pi support comes with the CLI fallback' } },
    unplan () { return { id: 'pi', action: 'none' } }
  }
}

import path from 'node:path'
import { readText, writeFileSafely, planned, tilde, isDir, same } from './util.js'
import { argsFor, commandValid } from './mcp-config.js'
import { defaultAutonomy } from './event.js'

// Codex: MCP servers in $CODEX_HOME/config.toml, a TOML table edited as text so comments and
// formatting survive. Hooks: not yet.

const TOML_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:autochat|"autochat"|'autochat')\s*(\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_HEADER = /^\s*\[/
const tomlString = (s) => JSON.stringify(String(s))

function tomlBlocks (text) {
  // [start, end) line ranges of [mcp_servers.autochat] and its sub-tables.
  const lines = text.split('\n')
  const ranges = []
  for (let i = 0; i < lines.length; i++) {
    const m = TOML_HEADER.exec(lines[i])
    if (!m) continue
    let j = i + 1
    while (j < lines.length && !ANY_HEADER.test(lines[j])) j++
    ranges.push({ start: i, end: j, sub: !!m[1] })
    i = j - 1
  }
  return { lines, ranges }
}

function tomlValue (lines, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (const l of lines) {
    const m = re.exec(l)
    if (!m) continue
    try { return JSON.parse(m[1].replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))) } catch { return m[1] }
  }
  return undefined
}

const mcp = {
  file: (ctx) => path.join(ctx.codexHome, 'config.toml'),
  where (ctx) { return tilde(this.file(ctx), ctx) },
  read (ctx) {
    const text = readText(this.file(ctx)) ?? ''
    const { lines, ranges } = tomlBlocks(text)
    const main = ranges.find(r => !r.sub)
    const body = main ? lines.slice(main.start + 1, main.end) : null
    const inline = /^\s*autochat\s*=\s*\{/m.test(text) && /^\s*\[\s*mcp_servers\s*\]/m.test(text)
    return { text, lines, ranges, main, body, inline }
  },
  status (ctx) {
    const { body } = this.read(ctx)
    if (!body) return { registered: false }
    const command = tomlValue(body, 'command')
    const args = tomlValue(body, 'args')
    return { registered: true, valid: commandValid(command, args), command: [command, ...(Array.isArray(args) ? args : [])].join(' ') }
  },
  plan (ctx) { return planned((c) => this.compute(c), ctx) },
  compute (ctx) {
    const f = this.file(ctx)
    const { text, lines, main, body, inline } = this.read(ctx)
    const want = { command: ctx.node, args: argsFor('codex', ctx) }
    const block = [`command = ${tomlString(want.command)}`, `args = [${want.args.map(tomlString).join(', ')}]`]
    if (inline) return { id: 'codex', action: 'manual', file: f, reason: `${tilde(f, ctx)} defines autochat inline under [mcp_servers]`, snippet: `[mcp_servers.autochat]\n${block.join('\n')}` }
    if (body && same(tomlValue(body, 'command'), want.command) && same(tomlValue(body, 'args'), want.args)) return { id: 'codex', action: 'none', file: f }
    let next
    if (main) {
      // Rewrite command and args in place (args may span lines); keep the table's other settings.
      const kept = []
      let inArgs = false
      for (const l of body) {
        if (inArgs) { if (l.includes(']')) inArgs = false; continue }
        if (/^\s*command\s*=/.test(l)) continue
        if (/^\s*args\s*=/.test(l)) { inArgs = !l.includes(']'); continue }
        kept.push(l)
      }
      next = [...lines.slice(0, main.start + 1), ...block, ...kept, ...lines.slice(main.end)].join('\n')
    } else {
      const base = text.replace(/\n*$/, '')
      next = (base ? base + '\n\n' : '') + `[mcp_servers.autochat]\n${block.join('\n')}\n`
    }
    return { id: 'codex', action: main ? 'update' : 'add', file: f, entry: `[mcp_servers.autochat]\n${block.join('\n')}`, write: () => writeFileSafely(f, next) }
  },
  unplan (ctx) { return planned((c) => this.uncompute(c), ctx) },
  uncompute (ctx) {
    const f = this.file(ctx)
    const { lines, ranges } = this.read(ctx)
    if (!ranges.length) return { id: 'codex', action: 'none', file: f }
    const drop = new Set()
    for (const r of ranges) for (let i = r.start; i < r.end; i++) drop.add(i)
    const next = lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
    return { id: 'codex', action: 'remove', file: f, write: () => writeFileSafely(f, next) }
  }
}

export default {
  id: 'codex',
  name: 'Codex',
  modes: ['headless'],
  trigger: ['headless'],
  detect (ctx) {
    const binary = ctx.which('codex')
    return { installed: !!binary || isDir(ctx.codexHome), binary, paths: { config: mcp.file(ctx) } }
  },
  normalize: () => null,
  autonomy: defaultAutonomy,
  mcp
}

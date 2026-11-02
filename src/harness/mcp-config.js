import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson, writeFileSafely, planned, tilde, exists, isObj, same } from './util.js'
import { jsonDelete } from './json-edit.js'

// Registering `autochat mcp` with a harness (`autochat setup --agents`), for adapter.mcp. Each
// registration runs the absolute node and bin/autochat.js (like the hooks), with
// `mcp --harness <id>`. File edits keep other entries and the file's indentation, are atomic,
// and keep a one-time backup (<file>.autochat.bak), which uninstall puts back when nothing else in
// the file has changed since. Formats, as verified against each CLI:
//
//   copilot   $COPILOT_HOME/mcp-config.json   mcpServers.autochat = {type:"local", command, args, tools:["*"]}
//   claude    claude mcp add --scope user autochat -- <node> <bin> mcp --harness claude
//   gemini    ~/.gemini/settings.json          mcpServers.autochat = {command, args}
//   opencode  ~/.config/opencode/opencode.json mcp.autochat = {type:"local", command:[…], enabled:true, timeout},
//             and the etiquette file ~/.config/opencode/autochat.md at the end of `instructions`
//             (edited as text, src/harness/opencode.js)
//   codex     $CODEX_HOME/config.toml          [mcp_servers.autochat] command, args
//   pi        no MCP: autochat's pi extension registers the tools itself (src/harness/pi.js)

export const SERVER = 'autochat'
export const argsFor = (id, ctx) => [ctx.bin, 'mcp', '--harness', id]

// The registered command still points at a node and an autochat that exist.
export function commandValid (command, args) {
  const bin = Array.isArray(args) ? args.find(a => /autochat\.js$/.test(a)) : null
  return !!command && exists(command) && !!bin && exists(bin) && args.includes('mcp')
}

export const child = (obj, key, create) => {
  if (!isObj(obj[key])) {
    if (!create) return null
    obj[key] = {}
  }
  return obj[key]
}

const dig = (obj, keys) => keys.reduce((o, k) => isObj(o) ? o[k] : undefined, obj)

/** A JSON config file with a map of MCP servers inside it, at `keys` (object keys from the root). */
export function jsonServer ({ id, file, keys, entry, initial = () => ({}) }) {
  const servers = (root, create) => keys.reduce((obj, key) => obj && child(obj, key, create), root)
  return {
    file,
    where: (ctx) => tilde(file(ctx), ctx),
    status (ctx) {
      const { root } = readJson(file(ctx))
      const have = root ? servers(root, false)?.[SERVER] : null
      if (!isObj(have)) return { registered: false }
      const command = Array.isArray(have.command) ? have.command[0] : have.command
      const args = Array.isArray(have.command) ? have.command.slice(1) : have.args
      return { registered: true, valid: commandValid(command, args), command: [command, ...(args || [])].join(' ') }
    },
    plan (ctx) { return planned((c) => this.compute(c), ctx) },
    compute (ctx) {
      const f = file(ctx)
      const { text, root } = readJson(f)
      const want = entry(ctx)
      if (root === undefined) return { id, action: 'manual', file: f, reason: `${tilde(f, ctx)} isn't plain JSON (comments?), so autochat won't rewrite it`, snippet: { [SERVER]: want } }
      const next = root ? structuredClone(root) : initial()
      const map = servers(next, true)
      const have = map[SERVER]
      const merged = isObj(have) ? { ...have, ...want } : want
      if (isObj(have) && same(merged, have)) return { id, action: 'none', file: f }
      map[SERVER] = merged
      return { id, action: have ? 'update' : 'add', file: f, entry: want, write: () => writeJson(f, text, next) }
    },
    unplan (ctx) { return planned((c) => this.uncompute(c), ctx) },
    // Undoes setup's edit. Only our entry goes, edited as text (json-edit.js), so the rest of the
    // file keeps its layout, and so does a map of servers it leaves empty, unless autochat added
    // that map. When what's left is what the file held before autochat first wrote to it (its
    // .autochat.bak), those exact bytes go back, whatever setup's rewrite did to the layout. A file
    // autochat made goes, once nothing else is in it.
    uncompute (ctx) {
      const f = file(ctx)
      const { text, root } = readJson(f)
      const map = root ? servers(root, false) : null
      if (!map || !(SERVER in map)) return { id, action: 'none', file: f }
      const before = readJson(f + '.autochat.bak')
      const next = jsonDelete(text, [...keys, SERVER], { prune: (k) => !isObj(dig(before.root, k)) })
      const left = JSON.parse(next)
      const restore = before.text !== null && before.root !== undefined && same(left, before.root ?? {})
      const made = before.text === null && !Object.keys(left).length
      // No backup now: one taken here would hold our entry, not what the file had before it.
      const write = restore
        ? () => writeFileSafely(f, before.text, { backup: false })
        : made ? () => fs.rmSync(f, { force: true }) : () => writeFileSafely(f, next, { backup: false })
      return { id, action: 'remove', file: f, write }
    }
  }
}

/** Installed: its binary is on the path, or the directory of its config file exists. */
export const detectBy = (binary, file) => (ctx) => {
  const found = ctx.which(binary)
  return { installed: !!found || fs.existsSync(path.dirname(file(ctx))), binary: found }
}

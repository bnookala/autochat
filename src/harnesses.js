import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { BIN } from './launcher.js'
import { envVar } from './env.js'

// `autochat setup --agents`: register `autochat mcp` with the coding-agent harnesses a user has
// installed. Each registration runs the absolute node and bin/autochat.js (like the hooks), with
// `mcp --harness <id>`. File edits keep other entries and the file's indentation, are atomic,
// and keep a one-time backup (<file>.autochat.bak). Formats, as verified against each CLI:
//
//   copilot   $COPILOT_HOME/mcp-config.json   mcpServers.autochat = {type:"local", command, args, tools:["*"]}
//   claude    claude mcp add --scope user autochat -- <node> <bin> mcp --harness claude
//   gemini    ~/.gemini/settings.json          mcpServers.autochat = {command, args}
//   opencode  ~/.config/opencode/opencode.json mcp.autochat = {type:"local", command:[…], enabled:true, timeout}
//   codex     $CODEX_HOME/config.toml          [mcp_servers.autochat] command, args
//   pi        no MCP support (yet)

export const SERVER = 'autochat'
// opencode times MCP requests out after 5 s by default; `wait` blocks for up to 50 s.
const OPENCODE_TIMEOUT_MS = 60000

export function harnessContext ({ env = process.env, node = process.execPath, bin = BIN, run = null } = {}) {
  const home = env.HOME || os.homedir()
  const searchPath = envVar('HARNESS_PATH', env) ?? env.PATH ?? ''
  return {
    env,
    node,
    bin,
    home,
    copilotHome: env.COPILOT_HOME || path.join(home, '.copilot'),
    configHome: env.XDG_CONFIG_HOME || path.join(home, '.config'),
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
    which: (name) => which(name, searchPath),
    run: run || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
}

// AUTOCHAT_HARNESS_PATH (path-delimited) replaces PATH when looking for harness binaries.
export function which (name, searchPath) {
  for (const dir of String(searchPath).split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name)
    try {
      if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p }
    } catch {}
  }
  return null
}

export const tilde = (p, ctx) => p && ctx.home && p.startsWith(ctx.home + path.sep) ? '~' + p.slice(ctx.home.length) : p
const argsFor = (id, ctx) => [ctx.bin, 'mcp', '--harness', id]
const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The registered command still points at a node and an autochat that exist.
function commandValid (command, args) {
  const bin = Array.isArray(args) ? args.find(a => /autochat\.js$/.test(a)) : null
  return !!command && exists(command) && !!bin && exists(bin) && args.includes('mcp')
}

// --- careful file edits ---------------------------------------------------------------------------

function readText (file) {
  try { return fs.readFileSync(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err }
}

// Atomic (temp file + rename), with a one-time backup. A symlinked config (stow, chezmoi,
// home-manager) is written through to its target, so the link stays a link.
export function writeFileSafely (file, text) {
  let target = file
  try { target = fs.realpathSync(file) } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let mode = 0o600
  if (exists(target)) {
    mode = fs.statSync(target).mode & 0o777
    const backup = file + '.autochat.bak'
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup)
  }
  const tmp = `${target}.autochat-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, target)
}

// Plans are shown first and applied later (maybe after a prompt), so apply() works from the file
// as it is then, not as it was when planned: nothing written in between gets lost.
const freshly = (compute, ctx) => () => {
  const now = compute(ctx)
  if (now.action === 'manual') throw new Error(now.reason)
  now.write?.()
}
const shown = ({ write, ...rest }) => rest

function jsonIndent (text) {
  const m = /^([ \t]+)["}\]]/m.exec(text || '')
  return m ? m[1] : 2
}

// A JSON config file with a map of MCP servers inside it.
function jsonHarness ({ id, name, binary, file, servers, entry, initial = () => ({}) }) {
  const load = (ctx) => {
    const f = file(ctx)
    const text = readText(f)
    if (text === null || !text.trim()) return { f, text, root: null }
    try {
      const root = JSON.parse(text)
      return { f, text, root: isObj(root) ? root : undefined }
    } catch {
      return { f, text, root: undefined }
    }
  }
  const write = (f, text, root) => writeFileSafely(f, JSON.stringify(root, null, jsonIndent(text)) + (text && !text.endsWith('\n') ? '' : '\n'))
  return {
    id,
    name,
    detect: (ctx) => ({ installed: !!ctx.which(binary) || fs.existsSync(path.dirname(file(ctx))), binary: ctx.which(binary) }),
    where: (ctx) => tilde(file(ctx), ctx),
    status (ctx) {
      const { root } = load(ctx)
      const have = root ? servers(root, false)?.[SERVER] : null
      if (!isObj(have)) return { registered: false }
      const command = Array.isArray(have.command) ? have.command[0] : have.command
      const args = Array.isArray(have.command) ? have.command.slice(1) : have.args
      return { registered: true, valid: commandValid(command, args), command: [command, ...(args || [])].join(' ') }
    },
    plan (ctx) {
      const p = this.compute(ctx)
      return p.write ? { ...shown(p), apply: freshly((c) => this.compute(c), ctx) } : shown(p)
    },
    compute (ctx) {
      const { f, text, root } = load(ctx)
      const want = entry(ctx)
      if (root === undefined) return { id, action: 'manual', file: f, reason: `${tilde(f, ctx)} isn't plain JSON (comments?), so autochat won't rewrite it`, snippet: { [SERVER]: want } }
      const next = root ? structuredClone(root) : initial()
      const map = servers(next, true)
      const have = map[SERVER]
      const merged = isObj(have) ? { ...have, ...want } : want
      if (isObj(have) && same(merged, have)) return { id, action: 'none', file: f }
      map[SERVER] = merged
      return { id, action: have ? 'update' : 'add', file: f, entry: want, write: () => write(f, text, next) }
    },
    unplan (ctx) {
      const p = this.uncompute(ctx)
      return p.write ? { ...shown(p), apply: freshly((c) => this.uncompute(c), ctx) } : shown(p)
    },
    uncompute (ctx) {
      const { f, text, root } = load(ctx)
      const map = root ? servers(root, false) : null
      if (!map || !(SERVER in map)) return { id, action: 'none', file: f }
      delete map[SERVER]
      return { id, action: 'remove', file: f, write: () => write(f, text, root) }
    }
  }
}

const child = (obj, key, create) => {
  if (!isObj(obj[key])) {
    if (!create) return null
    obj[key] = {}
  }
  return obj[key]
}

const copilot = jsonHarness({
  id: 'copilot',
  name: 'Copilot CLI',
  binary: 'copilot',
  file: (ctx) => path.join(ctx.copilotHome, 'mcp-config.json'),
  servers: (root, create) => child(root, 'mcpServers', create),
  entry: (ctx) => ({ type: 'local', command: ctx.node, args: argsFor('copilot', ctx), tools: ['*'] })
})

const gemini = jsonHarness({
  id: 'gemini',
  name: 'Gemini CLI',
  binary: 'gemini',
  file: (ctx) => path.join(ctx.home, '.gemini', 'settings.json'),
  servers: (root, create) => child(root, 'mcpServers', create),
  entry: (ctx) => ({ command: ctx.node, args: argsFor('gemini', ctx) })
})

// Servers keyed by name under `mcp`: what opencode 1.x reads, and newer versions still accept.
const opencode = jsonHarness({
  id: 'opencode',
  name: 'opencode',
  binary: 'opencode',
  file: (ctx) => {
    const dir = path.join(ctx.configHome, 'opencode')
    const jsonc = path.join(dir, 'opencode.jsonc')
    return !exists(path.join(dir, 'opencode.json')) && exists(jsonc) ? jsonc : path.join(dir, 'opencode.json')
  },
  servers: (root, create) => child(root, 'mcp', create),
  entry: (ctx) => ({ type: 'local', command: [ctx.node, ...argsFor('opencode', ctx)], enabled: true, timeout: OPENCODE_TIMEOUT_MS }),
  initial: () => ({ $schema: 'https://opencode.ai/config.json' })
})

// --- Codex: a TOML table, edited as text so comments and formatting survive -------------------------

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

const codex = {
  id: 'codex',
  name: 'Codex',
  file: (ctx) => path.join(ctx.codexHome, 'config.toml'),
  detect (ctx) { return { installed: !!ctx.which('codex') || isDir(ctx.codexHome), binary: ctx.which('codex') } },
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
  plan (ctx) {
    const p = this.compute(ctx)
    return p.write ? { ...shown(p), apply: freshly((c) => this.compute(c), ctx) } : shown(p)
  },
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
  unplan (ctx) {
    const p = this.uncompute(ctx)
    return p.write ? { ...shown(p), apply: freshly((c) => this.uncompute(c), ctx) } : shown(p)
  },
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

// --- Claude Code: through its CLI ---------------------------------------------------------------------

const claude = {
  id: 'claude',
  name: 'Claude Code',
  detect (ctx) { const binary = ctx.which('claude'); return { installed: !!binary, binary } },
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

const pi = {
  id: 'pi',
  name: 'pi',
  detect (ctx) { const binary = ctx.which('pi'); return { installed: !!binary, binary } },
  where () { return null },
  status () { return { registered: false, unsupported: true } },
  plan () { return { id: 'pi', action: 'unsupported', reason: 'no MCP support: pi support comes with the CLI fallback' } },
  unplan () { return { id: 'pi', action: 'none' } }
}

export const HARNESSES = [copilot, claude, gemini, opencode, codex, pi]

/** What `setup --agents` would do for each harness: installed ones get a plan. */
export function planAgents (ctx = harnessContext()) {
  return HARNESSES.map((h) => {
    const det = h.detect(ctx)
    if (!det.installed) return { id: h.id, name: h.name, action: 'absent' }
    return { name: h.name, where: h.where(ctx), ...h.plan(ctx) }
  })
}

/** What `uninstall` would remove: every registration we find, installed or not. */
export function unplanAgents (ctx = harnessContext()) {
  return HARNESSES.map(h => ({ name: h.name, where: h.where(ctx), ...h.unplan(ctx) }))
}

/** Per harness, for `autochat doctor`: installed, registered, command still valid. */
export function agentsStatus (ctx = harnessContext()) {
  return HARNESSES.map((h) => {
    const det = h.detect(ctx)
    const st = det.installed || h.id !== 'claude' ? h.status(ctx) : { registered: false }
    return { id: h.id, name: h.name, installed: det.installed, where: h.where(ctx), ...st }
  })
}

const short = (s, ctx) => String(s).split(ctx.bin).join(tilde(ctx.bin, ctx)).split(ctx.node).join(tilde(ctx.node, ctx))

/** Human-readable lines for one plan entry (setup and uninstall show these before acting). */
export function describePlan (p, ctx) {
  const label = p.id.padEnd(9)
  switch (p.action) {
    case 'absent': return [`${label}not installed`]
    case 'unsupported': return [`${label}${p.reason}`]
    case 'none': return [`${label}${p.file || p.id === 'claude' ? 'already connected' : 'nothing to do'}${p.where ? ` (${p.where})` : ''}`]
    case 'manual': return [`${label}${p.reason}. Add this yourself:`, ...String(typeof p.snippet === 'string' ? p.snippet : JSON.stringify(p.snippet, null, 2)).split('\n').map(l => ' '.repeat(9) + l)]
    case 'add':
    case 'update':
    case 'remove': {
      const verb = { add: 'add to', update: 'update in', remove: 'remove from' }[p.action]
      if (p.command) return [`${label}run: ${short(p.command.join(' '), ctx)}`]
      const lines = [`${label}${verb} ${tilde(p.file, ctx)}`]
      if (p.entry) {
        const body = typeof p.entry === 'string' ? p.entry : `"${SERVER}": ${JSON.stringify(p.entry)}`
        for (const l of body.split('\n')) lines.push(' '.repeat(9) + (p.action === 'remove' ? '- ' : '+ ') + short(l, ctx))
      }
      return lines
    }
    default: return [`${label}${p.action}`]
  }
}

/**
 * `autochat setup --agents`: show every change, then make it (or only show, with dryRun).
 * Pass `plans` from planAgents() to reuse them.
 */
export function setupAgents ({ ctx = harnessContext(), dryRun = false, out = console.log, plans = planAgents(ctx) } = {}) {
  out(`Connecting your agents to the agent room: ${short(`${ctx.node} ${ctx.bin} mcp --harness <id>`, ctx)}`)
  for (const p of plans) for (const l of describePlan(p, ctx)) out('  ' + l)
  const todo = plans.filter(p => p.apply)
  if (dryRun) {
    out(todo.length ? 'Dry run: nothing changed.' : 'Nothing to change.')
    return { plans, applied: [], failed: [] }
  }
  const applied = []
  const failed = []
  for (const p of todo) {
    try {
      p.apply()
      applied.push(p.id)
      out(`✔ ${p.id} connected`)
    } catch (err) {
      failed.push(p.id)
      out(`✘ ${p.id}: ${err.message}`)
    }
  }
  if (applied.length) out('New agent sessions get the autochat tools; restart running ones to pick them up.')
  else if (!failed.length && plans.some(p => p.action === 'none')) out('Nothing to change.')
  else if (!failed.length && !plans.some(p => ['none', 'manual'].includes(p.action))) out('No agent harnesses found (Copilot CLI, Claude Code, Gemini CLI, opencode, Codex).')
  return { plans, applied, failed }
}

/** `autochat uninstall`: remove every registration. */
export function removeAgents ({ ctx = harnessContext(), out = console.log } = {}) {
  const removed = []
  for (const p of unplanAgents(ctx).filter(p => p.apply)) {
    try {
      p.apply()
      removed.push(p.id)
      out(`removed the autochat MCP server from ${p.name}${p.file ? ` (${tilde(p.file, ctx)})` : ''}`)
    } catch (err) {
      out(`✘ ${p.id}: ${err.message}`)
    }
  }
  return removed
}

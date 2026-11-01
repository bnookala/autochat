import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { envVar } from '../env.js'
import { ADAPTERS, harnessContext } from './index.js'
import { hooksInstalledAt } from './copilot.js'

// Process-scan detection (#38): which coding agents are running right now, found in the process
// table (`ps`), whether or not they ever call autochat. It's a hint, never a session: the daemon
// shows it to clients (`detected` in the lounge snapshot) and doctor turns it into advice ("claude
// in ~/code/x has no autochat hooks"), but a process can't say whether its agent works on its
// own or with you, so nothing here ever tracks a session or puts you in the lounge.
//
// It only reads: one `ps` per scan, `lsof` (macOS) or /proc (Linux) for the working directory of
// agents it hasn't seen before. It never signals a process, not even with signal 0.

export const SCAN_INTERVAL_MS = 15000
export const MAX_AGENTS = 64

// How each harness's CLI shows up in `ps`: as its own binary (the adapter id), or as a script
// that node or bun runs, recognised by its package. Claude Code's native installs run a binary
// named after its version, under …/claude/versions/.
const PACKAGES = {
  copilot: [/\/@github\/copilot\//],
  claude: [/\/@anthropic-ai\/claude-code\//, /\/claude\/versions\/[^/]+$/],
  codex: [/\/@openai\/codex\//],
  gemini: [/\/@google\/gemini-cli\//],
  opencode: [/\/opencode-ai\//],
  pi: [/\/pi-coding-agent\//]
}
const INTERPRETER = /^(?:node|nodejs|bun|deno)(?:\d+(?:\.\d+)*)?$/
// Interpreter flags that take the next argument as their value.
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval', '-p', '--print', '--conditions', '-C'])
// First arguments that make a harness's process something other than an agent session: version
// and help, account and install commands, and the harness serving others (MCP, IDE backends).
const NOT_A_SESSION = new Set(['--version', '-v', '-V', 'version', '--help', '-h', 'help', 'login', 'logout', 'auth', 'update', 'upgrade', 'doctor', 'completion', 'config', 'install', 'uninstall', 'setup-token', 'migrate-installer', 'mcp', 'mcp-server', 'app-server', 'serve', 'web'])
const SCRIPT = /\.(?:[cm]?js|ts)$/

const ids = () => ADAPTERS.map(a => a.id)
const base = (p) => path.basename(p || '')

/**
 * The harness a process command line is an agent session of, or null. Stricter than
 * matchHarness() in src/mcp.js, which only looks at an MCP server's own ancestors: this looks at
 * every process. Binary names match exactly (the Claude and Copilot desktop apps are "Claude" and
 * "Copilot"); a harness binary running a script is a helper (Copilot's extension workers).
 */
export function matchProcess (command) {
  if (typeof command !== 'string') return null
  const argv = command.trim().split(/\s+/)
  const exe = argv[0] || ''
  let harness = null
  let rest = argv.slice(1)
  if (INTERPRETER.test(base(exe))) {
    let i = 1
    while (i < argv.length && argv[i].startsWith('-')) i += VALUE_FLAGS.has(argv[i]) ? 2 : 1
    const script = argv[i]
    if (!script) return null
    harness = ids().find(id => (PACKAGES[id] || []).some(re => re.test(script))) ||
      ids().find(id => base(script).replace(SCRIPT, '') === id) || null
    rest = argv.slice(i + 1)
  } else {
    harness = ids().find(id => base(exe) === id || (PACKAGES[id] || []).some(re => re.test(exe))) || null
    if (harness && rest[0] && SCRIPT.test(rest[0]) && !rest[0].startsWith('@')) return null
  }
  if (!harness) return null
  if (rest[0] && NOT_A_SESSION.has(rest[0])) return null
  return harness
}

/** Rows of `ps -A -ww -o pid=,ppid=,uid=,lstart=,command=` (in the C locale). */
export function parsePs (stdout) {
  const out = []
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    const startedAt = Date.parse(m[4].replace(/\s+/g, ' '))
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), startedAt: Number.isNaN(startedAt) ? null : startedAt, command: m[5] })
  }
  return out
}

/**
 * The agent sessions among `procs` ([{pid, ppid, uid?, startedAt?, command}]): this user's only,
 * and only the outermost process of each (a wrapper and the binary it starts are one agent).
 */
export function findAgents (procs, { uid = process.getuid?.() } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const matched = new Map()
  for (const p of procs) {
    if (uid !== undefined && p.uid !== undefined && p.uid !== uid) continue
    const harness = matchProcess(p.command)
    if (harness) matched.set(p.pid, harness)
  }
  const out = []
  for (const [pid, harness] of matched) {
    let parent = byPid.get(pid)?.ppid
    let nested = false
    for (let i = 0; parent > 1 && i < 16; i++) {
      if (matched.get(parent) === harness) { nested = true; break }
      parent = byPid.get(parent)?.ppid
    }
    if (!nested) out.push({ harness, pid, startedAt: byPid.get(pid).startedAt ?? null })
  }
  return out.sort((a, b) => a.harness.localeCompare(b.harness) || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.pid - b.pid).slice(0, MAX_AGENTS)
}

const run = (cmd, args, env) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout) => resolve(err && !stdout ? null : stdout))
})

/**
 * The process table. AUTOCHAT_PROCESS_LIST names a JSON file to read instead (tests): a list of
 * {pid, ppid, uid?, startedAt?, command, cwd?}. Null where there's no `ps` (Windows).
 */
export async function listProcesses (env = process.env) {
  const fixture = envVar('PROCESS_LIST', env)
  if (fixture) {
    try { return JSON.parse(fs.readFileSync(fixture, 'utf8')) } catch { return [] }
  }
  if (process.platform === 'win32') return null
  // lstart, not etime: a start time that's the same on every scan.
  const stdout = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,lstart=,command='], { ...process.env, LC_ALL: 'C' })
  return stdout === null ? null : parsePs(stdout)
}

/** Working directories of these processes: {pid: cwd}. lsof on macOS, /proc on Linux. */
export async function processCwds (pids) {
  const out = {}
  if (!pids.length) return out
  if (process.platform === 'linux') {
    for (const pid of pids) { try { out[pid] = fs.readlinkSync(`/proc/${pid}/cwd`) } catch {} }
    return out
  }
  if (process.platform !== 'darwin') return out
  const stdout = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])
  let pid = null
  for (const line of (stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) out[pid] = line.slice(1)
  }
  return out
}

/**
 * Whether autochat would hear from an agent of this harness: `installed` (its hooks are),
 * `missing` (the harness has autochat hooks, not installed), `unsupported` (no autochat hooks
 * for it yet), or `stale`: Copilot CLI loads hooks when it starts, and this one started before.
 */
export function hookStates (ctx) {
  const states = {}
  for (const a of ADAPTERS) {
    if (!a.hookStatus) { states[a.id] = 'unsupported'; continue }
    let st = {}
    try { st = a.hookStatus(ctx) || {} } catch {}
    states[a.id] = st.installed ? 'installed' : 'missing'
  }
  let copilotSince = null
  try { copilotSince = hooksInstalledAt(ctx) } catch {}
  return (harness, startedAt) => {
    const s = states[harness] ?? 'unsupported'
    if (harness === 'copilot' && s === 'installed' && copilotSince && startedAt && startedAt < copilotSince) return 'stale'
    return s
  }
}

/**
 * One scan: {scannedAt, agents: [{harness, pid, cwd, startedAt, hooks}]}, or null where processes
 * can't be listed. `list`, `cwds` and `known` (pid:start → cwd, kept between scans) are for the
 * scanner and tests.
 */
export async function scanProcesses ({ ctx = harnessContext(), env = ctx.env, list = listProcesses, cwds = processCwds, known = new Map(), now = Date.now() } = {}) {
  const procs = await list(env)
  if (!Array.isArray(procs)) return null
  const agents = findAgents(procs.filter(p => p && Number.isInteger(p.pid) && typeof p.command === 'string'))
  const key = (a) => `${a.pid}:${a.startedAt ?? ''}`
  const given = new Map(procs.filter(p => typeof p?.cwd === 'string').map(p => [p.pid, p.cwd]))
  const fresh = agents.filter(a => !known.has(key(a)) && !given.has(a.pid)).map(a => a.pid)
  const found = fresh.length ? await cwds(fresh) : {}
  const hooks = hookStates(ctx)
  const live = new Set()
  const out = agents.map((a) => {
    const k = key(a)
    live.add(k)
    if (!known.has(k)) known.set(k, given.get(a.pid) ?? found[a.pid] ?? null)
    return { harness: a.harness, pid: a.pid, cwd: known.get(k), startedAt: a.startedAt, hooks: hooks(a.harness, a.startedAt) }
  })
  for (const k of known.keys()) if (!live.has(k)) known.delete(k)
  return { scannedAt: now, agents: out }
}

/**
 * Scans every `intervalMs` (AUTOCHAT_PROCESS_SCAN_MS), and emits `change` when the list of agents
 * changes. snapshot() is the latest scan, or null before the first one.
 */
export class ProcessScanner extends EventEmitter {
  constructor ({ ctx = harnessContext(), intervalMs, list = listProcesses, cwds = processCwds } = {}) {
    super()
    this.ctx = ctx
    const fromEnv = Number(envVar('PROCESS_SCAN_MS', ctx.env))
    this.intervalMs = intervalMs ?? (fromEnv > 0 ? fromEnv : SCAN_INTERVAL_MS)
    this.list = list
    this.cwds = cwds
    this.known = new Map()
    this.last = null
    this.timer = null
    this.scanning = null
  }

  start () {
    if (this.timer) return this
    this.scan()
    this.timer = setInterval(() => this.scan(), this.intervalMs)
    this.timer.unref?.()
    return this
  }

  async scan () {
    if (this.scanning) return this.scanning
    this.scanning = (async () => {
      let next = null
      try { next = await scanProcesses({ ctx: this.ctx, list: this.list, cwds: this.cwds, known: this.known }) } catch {}
      if (next === null) return this.last
      const changed = JSON.stringify(next.agents) !== JSON.stringify(this.last?.agents)
      this.last = next
      if (changed) this.emit('change', next)
      return next
    })()
    try { return await this.scanning } finally { this.scanning = null }
  }

  snapshot () {
    return this.last ? { scannedAt: this.last.scannedAt, agents: this.last.agents.map(a => ({ ...a })) } : null
  }

  stop () {
    clearInterval(this.timer)
    this.timer = null
  }
}

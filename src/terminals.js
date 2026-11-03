import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { envVar } from './env.js'
import { focusOrigin } from './launcher.js'
import { isValidSessionId } from './paths.js'
import { parsePs } from './agent-client/binding.js'

// agents.open (#122): show an agent's session to its human. The daemon hands terminalOpener() to
// the agent room (`new AgentRoom({terminals})`), whose agents.open (src/agents/human.js) calls
// open() with what the agent's hello said. It tries, in order:
//
//   1. Rex: the pane whose processes hold the harness (the hello's REX_SESSION and REX_BLOCK are
//      checked first). The app shows its session and tab, and comes to the front.
//   2. tmux: the hello's pane (or another pane of that server) holding the harness: its window
//      and pane are selected, and the terminal showing tmux comes to the front.
//   3. Terminal, iTerm, Ghostty…: the harness's terminal app comes to the front (focusOrigin()).
//   4. No terminal: Copilot in the GitHub Copilot app opens there, at the session. Anything else
//      gets its harness's resume command in a new tab of the Rex session "autochat" (created
//      once, then reused), or without Rex, in a new Terminal window.
//
// It never types into a pane, and never closes a pane, tab or session. Errors are one line for
// the human. docs/agents.md ("Open a session") has the details.

export const REX_APP_ID = 'com.superlogical.rex'
export const COPILOT_APP_ID = 'com.github.githubapp'
export const REX_SESSION_LABEL = 'autochat'
const REX_BUNDLE = ['Library', 'Application Support', 'com.superlogical.rex', 'RexServer', 'Versions', 'Current', 'Rex Server.app', 'Contents', 'MacOS', 'rex']
const REX_TIMEOUT = '3s'
const NAMES = { copilot: 'Copilot CLI', claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', pi: 'pi', gemini: 'Gemini CLI' }
// The terminal apps focusOrigin() knows by TERM_PROGRAM (src/launcher.js), when there's no bundle id.
const TERMINAL_APPS = { ghostty: 'Ghostty', 'iTerm.app': 'iTerm', Apple_Terminal: 'Terminal', vscode: 'Visual Studio Code', WezTerm: 'WezTerm' }
// Harness processes that serve sessions shown elsewhere: a pane holding one shows none of them.
// Codex's app-server (the TUI's daemon); Claude Code's background sessions and their daemon.
const HOSTS = { codex: /\bapp-server\b/, claude: /\bbg-(?:spare|pty-host)\b|--bg-spare\b|\bdaemon run\b/ }
const CLAUDE_BACKGROUND = /\bbg-(?:spare|pty-host)\b|--bg-spare\b/
const TERMINAL_SCRIPT = ['on run argv', 'tell application "Terminal"', 'do script (item 1 of argv)', 'activate', 'end tell', 'end run']

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const firstLine = (s) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || ''
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Runs a program; resolves to {code, stdout, stderr}, never rejects (code -1: it didn't run). */
export function runFile (cmd, args, { env = process.env, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = !err ? 0 : Number.isInteger(err.code) ? err.code : -1
      resolve({ code, stdout: stdout || '', stderr: stderr || (code === -1 ? err.message : '') })
    })
  })
}

/** pid → {ppid, tty, command} for every process. */
export async function processTable (run = runFile) {
  const r = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,tty=,command='], { timeoutMs: 3000 })
  return parsePs(r.stdout)
}

const isExecutable = (p) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true) } catch { return false }
}

/**
 * The rex command: AUTOCHAT_REX (an AUTOCHAT_REX that isn't a program, such as `off`, means no
 * Rex), else `rex` on PATH, else $REX_BIN_DIR/rex, else the one in the Rex Server app. Null if
 * there's none.
 */
export function rexBinary (env = process.env, { exists = isExecutable, home = os.homedir() } = {}) {
  const set = envVar('REX', env)
  if (set) return exists(set) ? set : null
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && exists(path.join(dir, 'rex'))) return path.join(dir, 'rex')
  }
  if (env.REX_BIN_DIR && path.isAbsolute(env.REX_BIN_DIR) && exists(path.join(env.REX_BIN_DIR, 'rex'))) return path.join(env.REX_BIN_DIR, 'rex')
  const bundled = path.join(home, ...REX_BUNDLE)
  return exists(bundled) ? bundled : null
}

// --- processes ---------------------------------------------------------------------------------

// The harness and the ancestors that share its terminal (its shell, login…): what a pane holding
// it runs. A harness without a terminal is only itself.
export function harnessChain (procs, pid) {
  const out = [pid]
  const tty = procs.get(pid)?.tty
  let p = procs.get(pid)?.ppid
  while (tty && p > 1 && out.length < 32 && !out.includes(p)) {
    const row = procs.get(p)
    if (!row || row.tty !== tty) break
    out.push(p)
    p = row.ppid
  }
  return out
}

function descendants (procs, pid) {
  const kids = new Map()
  for (const [p, row] of procs) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, [])
    kids.get(row.ppid).push(p)
  }
  const out = new Set()
  const todo = [pid]
  while (todo.length && out.size < 4096) {
    for (const k of kids.get(todo.pop()) || []) if (!out.has(k)) { out.add(k); todo.push(k) }
  }
  return out
}

// A pane's processes, from Rex's `process`: its foreground process, the ones between it and the
// pane's own process, that one, and everything the foreground process started.
function paneProcesses (proc, procs) {
  const pids = []
  if (Number.isInteger(proc?.foreground?.pid)) pids.push(proc.foreground.pid, ...descendants(procs, proc.foreground.pid))
  for (const a of Array.isArray(proc?.ancestors) ? proc.ancestors : []) if (Number.isInteger(a?.pid)) pids.push(a.pid)
  if (Number.isInteger(proc?.child?.pid)) pids.push(proc.child.pid)
  return pids
}

// The app bundle a process runs from ("/Applications/Rex.app"), or null.
const appBundle = (command) => /^(\/.+?\.app)\/Contents\/MacOS\//.exec(command || '')?.[1] || null

// The first app among the process and its ancestors: the terminal app a tmux client runs in. Not
// a helper app under Library/Application Support, such as the Rex Server, which shows nothing.
function hostApp (procs, pid) {
  for (let p = pid, n = 0; p > 1 && n < 32; p = procs.get(p)?.ppid, n++) {
    const app = appBundle(procs.get(p)?.command)
    if (app && !app.includes('/Library/Application Support/')) return app
  }
  return null
}

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

// --- Rex ----------------------------------------------------------------------------------------

function rexClient (ctx) {
  const bin = rexBinary(ctx.env, { exists: ctx.exists, home: ctx.home })
  if (!bin) return null
  // Never a session, pane or client from the daemon's own env: every call names them.
  const env = { ...ctx.env }
  for (const k of ['REX_SESSION', 'REX_BLOCK', 'REX_CLIENT']) delete env[k]
  // --autostart=false: never start a Rex server that isn't running.
  const call = (args) => ctx.run(bin, ['--autostart=false', '--timeout', REX_TIMEOUT, ...args], { env, timeoutMs: 8000 })
  const json = async (args) => {
    const r = await call(args)
    if (r.code !== 0) return null
    try { return JSON.parse(r.stdout) } catch { return null }
  }
  let apps = null
  return {
    bin,
    call,
    json,
    // The Rex apps connected on this Mac, the one showing `session` first.
    async apps (session) {
      apps ??= json(['client', 'ls', '--json']).then(r => (Array.isArray(r?.clients) ? r.clients : []).filter(c =>
        c?.info?.kind === 'app' && c.connection_state === 'connected' && c.principal?.transport === 'unix' && typeof c.client_id === 'string'))
      const list = await apps
      return [...list].sort((a, b) => Number(!!b.session_ids?.includes(session)) - Number(!!a.session_ids?.includes(session)))
    }
  }
}

// The pane holding one of `pids`: the hinted one if it does, else the first one that does.
async function findRexPane (rex, pids, hint, procs) {
  const want = new Set(pids)
  const holds = (proc) => paneProcesses(proc, procs).some(p => want.has(p))
  const processOf = (session, block) => rex.json(['block', 'call', '-s', session, '-b', block, 'process'])
  if (hint) {
    if (holds(await processOf(hint.session, hint.block))) {
      const info = await rex.json(['block', 'inspect', '-s', hint.session, hint.block, '--json'])
      if (typeof info?.block?.window_id === 'string') return { session: hint.session, block: hint.block, window: info.block.window_id }
    }
  }
  const sessions = (await rex.json(['ls', '--json']))?.sessions
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (typeof s?.session_id !== 'string') continue
    const blocks = (await rex.json(['block', 'ls', '-s', s.session_id, '--json']))?.blocks
    const terms = (Array.isArray(blocks) ? blocks : []).filter(b => typeof b?.block_id === 'string' && /terminal/.test(b.creator_name || b.flavor || '') &&
      !(hint && b.block_id === hint.block))
    const procsOf = await mapLimit(terms, 8, (b) => processOf(s.session_id, b.block_id))
    const i = procsOf.findIndex(holds)
    if (i !== -1) return { session: s.session_id, block: terms[i].block_id, window: terms[i].window_id }
  }
  return null
}

// Brings the Rex app to the front: the app of that client, else the one LaunchServices knows.
async function frontRex (ctx, procs, app) {
  const bundle = app && appBundle(procs.get(app.principal?.pid)?.command)
  await ctx.run('open', bundle ? ['-a', bundle] : ['-b', REX_APP_ID])
}

// Shows a session's tab in the Rex app, and brings the app to the front. False without an app.
async function showRex (ctx, rex, procs, session, window) {
  const [app] = await rex.apps(session)
  if (!app) return false
  await rex.call(['-C', app.client_id, 'do', 'session.select', `session_id=${session}`, ...(window ? [`window_id=${window}`] : [])])
  await frontRex(ctx, procs, app)
  return true
}

async function openRexPane (ctx, rex, procs, pane) {
  // The pane, in its tab: the server's focus, which every Rex app follows.
  await rex.call(['focus', '-s', pane.session, pane.block])
  if (!await showRex(ctx, rex, procs, pane.session, pane.window)) {
    await ctx.run('open', ['-b', REX_APP_ID])
    return { opened: 'rex', detail: `a Rex pane (${pane.block}): Rex wasn't open, so it may not show it yet` }
  }
  return { opened: 'rex', detail: `its Rex pane (${pane.block})` }
}

// --- tmux ---------------------------------------------------------------------------------------

async function openTmuxPane (ctx, rex, procs, tmux, pids, agent) {
  const run = (...args) => ctx.run('tmux', ['-S', tmux.socket, ...args], { timeoutMs: 3000 })
  const listed = await run('list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}')
  if (listed.code !== 0) return null
  const panes = listed.stdout.split('\n').map(l => l.split('\t')).filter(f => /^%\d+$/.test(f[0])).map(([id, pid, session]) => ({ id, pid: Number(pid), session }))
  const harness = pids[0]
  const holds = (p) => pids.includes(p.pid) || descendants(procs, p.pid).has(harness)
  const pane = panes.find(p => p.id === tmux.pane && holds(p)) || panes.find(holds)
  if (!pane) return null
  // The tmux client that shows its session (else the last one used) switches to it.
  const clients = (await run('list-clients', '-F', '#{client_pid}\t#{client_session}\t#{client_name}')).stdout.split('\n')
    .map(l => l.split('\t')).filter(f => /^\d+$/.test(f[0])).map(([pid, session, name]) => ({ pid: Number(pid), session, name }))
  const client = clients.find(c => c.session === pane.session) || clients[0] || null
  if (client) await run('switch-client', '-c', client.name, '-t', pane.id)
  await run('select-window', '-t', pane.id)
  await run('select-pane', '-t', pane.id)
  // The terminal showing that client: its Rex pane, else the app it runs in, else the app the
  // harness was started from.
  let where = 'its tmux pane'
  const clientPane = client && rex && await findRexPane(rex, harnessChain(procs, client.pid), null, procs)
  if (clientPane) {
    await rex.call(['focus', '-s', clientPane.session, clientPane.block])
    await showRex(ctx, rex, procs, clientPane.session, clientPane.window)
    where += ', in Rex'
  } else if (ctx.platform === 'darwin') {
    const app = client && hostApp(procs, client.pid)
    const t = agent.terminal || {}
    if (app) await ctx.run('open', ['-a', app])
    else if (t.bundleId || TERMINAL_APPS[t.program]) ctx.focus({ bundleId: t.bundleId, termProgram: t.program })
  }
  return { opened: 'tmux', detail: `${where} (${pane.id})` }
}

// --- resuming -----------------------------------------------------------------------------------

// A Claude Code background session's id for `claude attach`, from `claude agents --json` (Claude
// Code 2.1.317): the entry with the agent's session id, or the harness's pid.
async function claudeJob (ctx, agent) {
  const r = await ctx.run('claude', ['agents', '--json'], { timeoutMs: 8000 })
  let list = null
  try { list = JSON.parse(r.stdout) } catch {}
  const job = (Array.isArray(list) ? list : []).find(e => isObj(e) && e.kind === 'background' && typeof e.id === 'string' && /^[a-z0-9]{4,16}$/.test(e.id) &&
    ((agent.sessionId && e.sessionId === agent.sessionId) || (agent.harnessPid && e.pid === agent.harnessPid)))
  return job ? job.id : null
}

/**
 * The command that shows the agent's session in a new terminal, run in its directory: its session
 * when the hello said which, else the harness's session picker (opencode has none: its TUI).
 * Null for a harness autochat can't resume.
 */
export async function resumeCommand (agent, ctx = {}, row = null) {
  const id = isValidSessionId(agent.sessionId) ? agent.sessionId : null
  switch (agent.harness) {
    case 'codex': return id ? ['codex', 'resume', id] : ['codex', 'resume']
    case 'claude': {
      // A background session (`claude --bg`, the agents view) is attached to, not resumed: resuming
      // one that runs starts a copy.
      const job = row && CLAUDE_BACKGROUND.test(row.command) && ctx.run ? await claudeJob(ctx, agent) : null
      if (job) return ['claude', 'attach', job]
      return id ? ['claude', '--resume', id] : ['claude', '--resume']
    }
    case 'copilot': return id ? ['copilot', `--resume=${id}`] : ['copilot', '--resume']
    case 'opencode': return id ? ['opencode', '-s', id] : ['opencode']
    case 'pi': return id ? ['pi', '--session', id] : ['pi', '--resume']
    default: return null
  }
}

// A tab's name: the agent's title, on one line, never read as an option.
const tabName = (agent) => (String(agent.title || agent.name || 'agent').replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '') || 'agent').slice(0, 40)
const directory = (cwd) => {
  try { return typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory() ? cwd : null } catch { return null }
}

async function openRexTab (ctx, rex, procs, agent, cmd) {
  const sessions = (await rex.json(['ls', '--json']))?.sessions
  if (!Array.isArray(sessions)) return null
  // No Rex app open to show it: a Terminal window shows it instead.
  if (!(await rex.apps(null)).length) return null
  const name = tabName(agent)
  const cwd = directory(agent.cwd)
  const dir = cwd ? ['-c', cwd] : []
  let session = sessions.find(s => s?.label === REX_SESSION_LABEL && typeof s.session_id === 'string')?.session_id || null
  let window = null
  let created = false
  if (session) {
    window = (await rex.json(['window', 'new', '-s', session, name, ...dir, '--json', '--', ...cmd]))?.window_id || null
    if (!window) throw new Error(`couldn't open a tab in Rex's ${REX_SESSION_LABEL} session`)
  } else {
    const r = await rex.json(['new', REX_SESSION_LABEL, `--window=${name}`, ...dir, '--json', '--', ...cmd])
    session = typeof r?.session_id === 'string' ? r.session_id : null
    if (!session) throw new Error(`couldn't create Rex's ${REX_SESSION_LABEL} session`)
    window = r.initial_windows?.[0]?.window_id || null
    created = true
  }
  await showRex(ctx, rex, procs, session, window)
  return { opened: 'new-tab', detail: `${cmd.join(' ')}, in a new tab of Rex's ${REX_SESSION_LABEL} session${created ? ' (new)' : ''}` }
}

async function openTerminalWindow (ctx, agent, cmd) {
  const cwd = directory(agent.cwd)
  const line = `${cwd ? `cd ${shq(cwd)} && ` : ''}${cmd.map(shq).join(' ')}`
  const r = await ctx.run('osascript', [...TERMINAL_SCRIPT.flatMap(l => ['-e', l]), line], { timeoutMs: 8000 })
  if (r.code !== 0) throw new Error(`couldn't open a Terminal window: ${firstLine(r.stderr) || `osascript failed (${r.code})`}`)
  return { opened: 'new-tab', detail: `${cmd.join(' ')}, in a new Terminal window` }
}

// --- open ---------------------------------------------------------------------------------------

/**
 * Shows an agent's session. `agent`: {id, name, title, harness, present, pid, harnessPid, shared,
 * sessionId, cwd, terminal} (src/agents/human.js). Resolves to {opened, detail}: opened is "rex",
 * "tmux", "terminal", "app" or "new-tab". Rejects with a one-line message.
 */
export async function openSession (agent, ctx) {
  const t = isObj(agent.terminal) ? agent.terminal : {}
  const procs = await ctx.processes()
  const row = agent.harnessPid ? procs.get(agent.harnessPid) : null
  // Only a live harness that has a terminal of its own can be found in one. A left agent's pid may
  // belong to another process by now; a harness process several agents share shows none of them.
  const live = !!(agent.present && row)
  const hosted = live && (agent.shared || HOSTS[agent.harness]?.test(row.command))
  const findable = live && !hosted && !!row.tty
  const pids = findable ? harnessChain(procs, agent.harnessPid) : []
  const rex = rexClient(ctx)

  if (findable && rex) {
    const pane = await findRexPane(rex, pids, t.rex, procs)
    if (pane) return openRexPane(ctx, rex, procs, pane)
  }
  if (findable && t.tmux) {
    const r = await openTmuxPane(ctx, rex, procs, t.tmux, pids, agent)
    if (r) return r
  }
  // In a terminal: the harness shares its terminal with its parent (its shell).
  if (findable && procs.get(row.ppid)?.tty === row.tty) {
    if (ctx.platform === 'darwin' && (t.bundleId || TERMINAL_APPS[t.program])) {
      ctx.focus({ termProgram: t.program, bundleId: t.bundleId })
      return { opened: 'terminal', detail: TERMINAL_APPS[t.program] || t.bundleId }
    }
    throw new Error(`${agent.name} runs in a terminal autochat can't find (${row.tty})`)
  }

  // No terminal.
  const id = isValidSessionId(agent.sessionId) ? agent.sessionId : null
  if (agent.harness === 'copilot' && t.bundleId === COPILOT_APP_ID) {
    const r = await ctx.run('open', ['-b', COPILOT_APP_ID, ...(id ? [`ghapp://sessions/${id}`] : [])])
    if (r.code !== 0) throw new Error(`couldn't open the GitHub Copilot app: ${firstLine(r.stderr) || `open failed (${r.code})`}`)
    return { opened: 'app', detail: id ? 'the GitHub Copilot app, at its session' : 'the GitHub Copilot app' }
  }
  const cmd = await resumeCommand(agent, ctx, live ? row : null)
  if (!cmd) throw new Error(`${agent.name} has no terminal to open, and autochat can't resume ${NAMES[agent.harness] || agent.harness} sessions`)
  if (rex) {
    const r = await openRexTab(ctx, rex, procs, agent, cmd)
    if (r) return r
  }
  if (ctx.platform !== 'darwin') throw new Error(`${agent.name} has no terminal to open, and there's no Rex to resume it in`)
  return openTerminalWindow(ctx, agent, cmd)
}

/**
 * The agent room's `terminals` (src/agents/human.js): {open(agent)}. Tests pass `run` (every
 * program it starts: rex, tmux, open, osascript, claude, ps), `processes`, `focus` (focusOrigin)
 * and `exists`.
 */
export function terminalOpener ({ env = process.env, run = runFile, processes = null, focus = focusOrigin, exists = isExecutable, home = os.homedir(), platform = process.platform } = {}) {
  // Every program runs with this env (its PATH finds them), unless the call passes its own.
  const runIn = (cmd, args, opts = {}) => run(cmd, args, { env, ...opts })
  const ctx = { env, run: runIn, focus, exists, home, platform, processes: processes || (() => processTable(runIn)) }
  return { open: (agent) => openSession(agent, ctx) }
}

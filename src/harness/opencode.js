import fs from 'node:fs'
import path from 'node:path'
import { isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { readText, planned, tilde, exists, isDir, isObj, shq } from './util.js'
import { jsonServer, detectBy, child, argsFor } from './mcp-config.js'
import { byTrigger, modesOf, originFrom } from './event.js'

// opencode. Hooks: a plugin of our own, $XDG_CONFIG_HOME/opencode/plugin/autochat.js
// (~/.config/opencode/plugin/), made from opencode-plugin.js: it forwards events to
// `autochat hook --harness opencode <event>`, so normalize() and the trigger rule stay here. MCP
// servers go in ~/.config/opencode/opencode.json(c).
//
// Verified against opencode 1.2.6 (test/fixtures/opencode/, recorded from the real binary):
// - It loads every {plugin,plugins}/*.{js,ts} in its config dirs at startup and calls each export
//   with {client, project, worktree, directory, serverUrl, $}. The `event` hook gets every bus
//   event without being awaited; chat.message and tool.execute.before are awaited.
// - tool.execute.after is awaited too, and the model reads what it leaves in `output`: a string in
//   output.output for built-in tools, MCP content blocks in output.content for MCP tools. The
//   plugin's doorbell appends its line there.
// - `opencode run` creates its session denying the question, plan_enter and plan_exit permissions
//   (`opencode github` denies question): session.created/updated carry those rules, which is
//   what marks a headless session, `run --attach` included. A session that run continues
//   (--continue, --session) only shows it in process.argv: [bun, /$bunfs/root/src/index.js, run,
//   …]. The TUI runs plugins in its worker: [bun, /$bunfs/root/src/cli/cmd/tui/worker.js].
// - run rejects its session's permission requests within milliseconds (permission.replied, reply
//   reject), but never a subagent's, and never answers a question: those hang it.
// - opencode has no signal handlers: Ctrl+C kills it without server.instance.disposed, so the
//   plugin sends its pid and the Controller ends the session once that process is gone.
// - Subagents work in child sessions (parentID) with their own prompts, tools and idle.
// - Processes the plugin spawns with detached: true outlive `opencode run`, so its last events
//   (session.idle, server.instance.disposed) get through.

export const PLUGIN = 'autochat.js'
const DIRS = ['plugin', 'plugins']
const TEMPLATE = new URL('./opencode-plugin.js', import.meta.url)
const MARKER = "autochat's opencode plugin"
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit'])

// --- hooks: the plugin --------------------------------------------------------------------------------

export const configDir = (ctx) => path.join(ctx.configHome, 'opencode')
const candidates = (ctx) => DIRS.map(d => path.join(configDir(ctx), d, PLUGIN))
const isOurs = (text) => typeof text === 'string' && text.includes(MARKER)

/** The plugin, with the node and autochat.js its hook runs. */
export function pluginSource (ctx) {
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/^const NODE = .*$/m, () => `const NODE = ${JSON.stringify(ctx.node)}`)
    .replace(/^const BIN = .*$/m, () => `const BIN = ${JSON.stringify(ctx.bin)}`)
}

// The node and autochat.js an installed plugin runs.
function embedded (text) {
  const get = (name) => { try { return JSON.parse((new RegExp(`^const ${name} = (.*)$`, 'm').exec(text) || [])[1]) } catch { return null } }
  return [get('NODE'), get('BIN')].filter(p => typeof p === 'string')
}

/**
 * Where our plugin is, or goes: plugin/ (which every opencode reads), or plugins/ when that's the
 * directory the user has.
 */
export function pluginFile (ctx) {
  const [singular, plural] = candidates(ctx)
  const ours = [singular, plural].find(f => isOurs(readText(f)))
  if (ours) return ours
  return !isDir(path.dirname(singular)) && isDir(path.dirname(plural)) ? plural : singular
}

// A file of our own: written whole, atomically, through a symlink if it is one. No backup.
function writeOwn (file, text) {
  let target = file
  try { target = fs.realpathSync(file) } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.autochat-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o644 })
  fs.renameSync(tmp, target)
}

function computeHooks (ctx) {
  const file = pluginFile(ctx)
  const want = pluginSource(ctx)
  const have = readText(file)
  if (have === want) return { id: 'opencode', action: 'none', file }
  if (have !== null && !isOurs(have)) return { id: 'opencode', action: 'manual', file, reason: `${tilde(file, ctx)} is a plugin of someone else's, so autochat won't replace it`, snippet: want }
  return {
    id: 'opencode',
    action: have === null ? 'add' : 'update',
    file,
    entries: [`a plugin that runs ${shq(ctx.node)} ${shq(ctx.bin)} hook --harness opencode <event>`],
    write: () => writeOwn(file, want)
  }
}

// Only our plugin goes; the directories it's in, and everything else in them, stay.
function uncomputeHooks (ctx) {
  const files = candidates(ctx).filter(f => isOurs(readText(f)))
  if (!files.length) return { id: 'opencode', action: 'none', file: pluginFile(ctx) }
  return {
    id: 'opencode',
    action: 'remove',
    file: files[0],
    entries: files.map(f => tilde(f, ctx)),
    write: () => { for (const f of files) fs.rmSync(f, { force: true }) }
  }
}

function hookStatus (ctx) {
  const file = pluginFile(ctx)
  const text = readText(file)
  const installed = isOurs(text)
  const paths = installed ? embedded(text) : []
  // valid: the node and autochat.js the plugin runs still exist.
  return { installed, file, valid: !installed || (paths.length === 2 && paths.every(exists)) }
}

// --- events -----------------------------------------------------------------------------------------

const str = (v) => typeof v === 'string' ? v : ''

/**
 * The opencode command a plugin runs under, from its process.argv (without the executable): the
 * first argument that isn't an option (`run`, `serve`, `github`, …), or 'tui' for the TUI's worker
 * and for opencode with no command or a path to open. null when the payload doesn't say.
 */
export function command (argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') return null
  if (/[/\\]tui[/\\]worker\.[cm]?[jt]s$/.test(argv[0])) return 'tui'
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--log-level') { i++; continue }
    if (!a.startsWith('-')) return /^[a-z][a-z-]*$/.test(a) ? a : 'tui'
  }
  return 'tui'
}

/**
 * Nobody attends the session: this is `opencode run` (or `opencode github`), or a server running a
 * session that denies the question tool, as theirs do (`run --attach`). Someone's at the TUI, or
 * in an editor over ACP, even in a session that run created: it keeps those rules for good. null
 * when the payload doesn't say.
 */
export function headless (p) {
  const cmd = command(p?.argv)
  if (cmd === 'run' || cmd === 'github') return true
  if (cmd === 'tui' || cmd === 'acp') return false
  const rules = Array.isArray(p?.session?.permission) ? p.session.permission : []
  if (rules.some(r => isObj(r) && r.permission === 'question' && r.pattern === '*' && r.action === 'deny')) return true
  return cmd === null ? null : false
}

function describePermission (p) {
  const patterns = Array.isArray(p.patterns) ? p.patterns.filter(x => typeof x === 'string') : []
  const what = str(p.permission) || 'a tool'
  return sanitize(patterns.length ? `${what}: ${patterns.join(', ')}` : what, 600)
}

function describeQuestions (questions) {
  const qs = Array.isArray(questions) ? questions.filter(isObj) : []
  return sanitize(qs.map((q) => {
    const choices = Array.isArray(q.options) ? q.options.map(o => isObj(o) ? str(o.label) : str(o)).filter(Boolean) : []
    return str(q.question) + (choices.length ? ` [${choices.join(' / ')}]` : '')
  }).filter(Boolean).join(' · '), 600)
}

function editedFiles (tool, args, cwd) {
  if (!EDIT_TOOLS.has(tool) || !isObj(args) || !str(args.filePath)) return undefined
  return [sanitize(cwd ? path.resolve(cwd, args.filePath) : args.filePath, 300)]
}

/** What the plugin forwards (`{event, sessionID, session, agent, argv, directory, …}`) as a SessionEvent. */
export function normalize (event, p, env) {
  if (!isObj(p) || !isValidSessionId(p.sessionID)) return null
  const name = str(p.event) || event
  const props = isObj(p.properties) ? p.properties : {}
  const cwd = str(p.session?.directory) || str(p.directory)
  const ev = {
    harness: 'opencode',
    sid: p.sessionID,
    kind: 'notice',
    // The agent is opencode's mode: build, plan, or one of your own.
    mode: str(p.agent) || null,
    headless: headless(p),
    cwd: cwd ? sanitize(cwd, 300) : undefined,
    origin: originFrom(env),
    // When it happened: the plugin's events can reach the core out of order.
    at: Number.isFinite(p.at) && p.at > 0 ? p.at : undefined,
    // The opencode process: Ctrl+C kills it without a word.
    pid: Number.isInteger(p.pid) && p.pid > 0 ? p.pid : undefined
  }
  switch (name) {
    case 'session.created':
      ev.kind = 'start'
      break
    case 'chat.message':
      ev.kind = 'activity'
      break
    case 'tool.execute.before':
      ev.kind = 'activity'
      ev.files = editedFiles(props.tool, props.args, cwd)
      break
    case 'permission.asked':
      ev.kind = 'request'
      ev.request = { title: 'Permission needed', message: describePermission(props) }
      break
    case 'question.asked':
      ev.kind = 'request'
      ev.request = { title: 'opencode has a question for you', message: describeQuestions(props.questions) }
      break
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected':
      ev.kind = 'activity'
      break
    case 'session.idle':
      ev.kind = 'idle'
      if (str(p.summary)) ev.summary = sanitize(p.summary, 2000)
      break
    case 'server.instance.disposed':
      ev.kind = 'end'
      ev.reason = 'exit'
      if (str(p.summary)) ev.summary = sanitize(p.summary, 2000)
      break
  }
  if (!ev.files) delete ev.files
  if (!ev.at) delete ev.at
  if (!ev.pid) delete ev.pid
  return ev
}

// The agent in the trigger list, or headless. When the payload doesn't say whether anyone's
// there, an agent that doesn't count by itself leaves it unknown.
function autonomy (payload, session) {
  const a = byTrigger(modesOf(session), session.trigger)
  const headlessCounts = Array.isArray(session.trigger) && session.trigger.includes('headless')
  return a === 'interactive' && session.headless === null && headlessCounts ? 'unknown' : a
}

// --- the adapter ------------------------------------------------------------------------------------

// opencode times MCP requests out after 5 s by default; `wait` blocks for up to 50 s.
const OPENCODE_TIMEOUT_MS = 60000

// Servers keyed by name under `mcp`: what opencode 1.x reads, and newer versions still accept.
const mcp = jsonServer({
  id: 'opencode',
  file: (ctx) => {
    const dir = configDir(ctx)
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
  modes: ['build', 'plan', 'headless'],
  trigger: ['headless'],
  detect: (ctx) => ({ ...detectBy('opencode', mcp.file)(ctx), paths: { config: mcp.file(ctx), plugin: pluginFile(ctx) } }),
  hooksNote: "New opencode processes load the plugin; ones already running (a TUI, opencode serve) don't until they restart.",
  planHooks: (ctx) => planned(computeHooks, ctx),
  unplanHooks: (ctx) => planned(uncomputeHooks, ctx),
  hookStatus,
  normalize,
  autonomy,
  focus: focusOrigin,
  mcp
}

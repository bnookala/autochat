import fs from 'node:fs'
import path from 'node:path'
import { quickMode } from './session.js'
import { send } from './ipc.js'
import { loadConfig } from './config.js'
import { launchUI } from './launcher.js'
import { runDir, ensureDir, isValidSessionId } from './paths.js'
import { parseRoom, sanitize } from './protocol.js'

export const HOOK_EVENTS = ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop', 'notification', 'sessionEnd']
const REQUEST_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])
const LOCK_STALE_MS = 15000
const OPTOUT_TTL_MS = 2 * 60 * 60 * 1000

const optoutFile = (sid) => path.join(runDir(), 'optout-' + sid)
const lockFile = () => path.join(runDir(), 'launch.lock')

export function setOptout (sid) {
  if (!isValidSessionId(sid)) return
  ensureDir(runDir())
  fs.writeFileSync(optoutFile(sid), String(Date.now()))
}

export function clearOptout (sid) {
  try { fs.unlinkSync(optoutFile(sid)) } catch {}
}

function optedOut (sid) {
  try {
    const st = fs.statSync(optoutFile(sid))
    if (Date.now() - st.mtimeMs < OPTOUT_TTL_MS) return true
    clearOptout(sid)
  } catch {}
  return false
}

function acquireLock () {
  ensureDir(runDir())
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lockFile(), String(process.pid), { flag: 'wx' })
      return true
    } catch (err) {
      if (err.code !== 'EEXIST') return false
      try {
        if (Date.now() - fs.statSync(lockFile()).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockFile()); continue }
      } catch { continue }
      return false
    }
  }
  return false
}

export function releaseLaunchLock () {
  try { fs.unlinkSync(lockFile()) } catch {}
}

function describeQuestion (args) {
  if (!args || typeof args !== 'object') return ''
  let text = args.question || args.message || ''
  if (Array.isArray(args.choices) && args.choices.length) text += ' [' + args.choices.join(' / ') + ']'
  const props = args.requestedSchema?.properties
  if (props && typeof props === 'object') {
    const fields = Object.values(props).filter(p => p && p.title).map(p => Array.isArray(p.enum) ? `${p.title}: ${p.enum.join(' / ')}` : p.title)
    if (fields.length) text += ' (' + fields.join(', ') + ')'
  }
  return text
}

function parseArgs (a) {
  if (typeof a === 'string') { try { return JSON.parse(a) } catch { return { question: a } } }
  return a
}

// Real CLI payloads differ from the docs: preToolUse batches `toolCalls: [{name, args}]`
// and notifications use `notificationType`. Accept every shape we've seen.
function toolCalls (p) {
  if (Array.isArray(p.toolCalls)) return p.toolCalls.filter(c => c && typeof c === 'object').map(c => ({ name: c.name || c.toolName, args: parseArgs(c.args ?? c.arguments ?? c.toolArgs) }))
  const name = p.toolName || p.tool_name
  return name ? [{ name, args: parseArgs(p.toolArgs ?? p.tool_input) }] : []
}

export function buildMessage (event, p, env, mode) {
  const sessionId = p.sessionId || p.session_id || env.COPILOT_AGENT_SESSION_ID
  if (!isValidSessionId(sessionId)) return null
  const calls = toolCalls(p)
  const find = (n) => calls.find(c => c.name === n)
  const msg = {
    type: 'hook',
    event,
    sessionId,
    mode,
    cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
    ts: Date.now(),
    origin: { tmux: env.TMUX, tmuxPane: env.TMUX_PANE, termProgram: env.TERM_PROGRAM, bundleId: env.__CFBundleIdentifier },
    kind: 'notice'
  }
  switch (event) {
    case 'userPromptSubmitted':
    case 'UserPromptSubmit':
      msg.kind = 'activity'
      break
    case 'postToolUse':
    case 'PostToolUse':
    case 'preToolUse':
    case 'PreToolUse': {
      const done = find('task_complete')
      const ask = find('ask_user')
      if (done && /^post/i.test(event)) {
        msg.kind = 'complete'
        msg.summary = sanitize(done.args?.summary || '', 2000)
      } else if (ask && /^pre/i.test(event)) {
        msg.kind = 'request'
        msg.request = { title: 'Copilot has a question for you', message: sanitize(describeQuestion(ask.args), 600) }
      } else {
        msg.kind = 'activity'
      }
      break
    }
    case 'notification':
    case 'Notification': {
      const t = p.notification_type || p.notificationType
      if (REQUEST_NOTIFICATIONS.has(t)) {
        msg.kind = 'request'
        msg.request = {
          title: sanitize(p.title || (t === 'permission_prompt' ? 'Permission needed' : 'Copilot needs input'), 80),
          message: sanitize(p.message || '', 600)
        }
      }
      break
    }
    case 'agentStop':
    case 'Stop':
      msg.kind = 'stop'
      break
    case 'sessionEnd':
    case 'SessionEnd':
      msg.kind = 'end'
      msg.reason = sanitize(String(p.reason || 'end'), 32)
      break
  }
  return msg
}

export function shouldLaunch (msg) {
  return msg.mode === 'autopilot' && (msg.kind === 'activity' || msg.kind === 'request')
}

function readStdin (timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    const timer = setTimeout(() => resolve(data), timeoutMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { data += d; if (data.length > 10 * 1024 * 1024) { clearTimeout(timer); resolve(data) } })
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data) })
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data) })
  })
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Entry point for Copilot CLI hooks. Must never fail or print: preToolUse
 * command hooks are fail-closed, so any error here could block a tool call.
 */
export async function runHook (event, env = process.env) {
  const raw = await readStdin()
  let payload = {}
  try { payload = JSON.parse(raw || '{}') || {} } catch {}
  const cfg = loadConfig()
  if (cfg.launch === 'off') return { action: 'disabled' }
  const sid = payload.sessionId || payload.session_id || env.COPILOT_AGENT_SESSION_ID
  if (!isValidSessionId(sid)) return { action: 'no-session' }
  const msg = buildMessage(event, payload, env, quickMode(sid))
  if (!msg) return { action: 'no-session' }
  if (msg.kind === 'complete' || msg.kind === 'end') clearOptout(sid)

  if (await send(msg, 600)) return { action: 'delivered' }
  if (!shouldLaunch(msg)) return { action: 'ignored' }
  if (optedOut(sid)) return { action: 'opted-out' }

  if (!acquireLock()) {
    // Another hook is starting the UI right now; hand our event to it once it's up.
    for (let i = 0; i < 15; i++) {
      await sleep(200)
      if (await send(msg, 300)) return { action: 'delivered' }
    }
    return { action: 'dropped' }
  }
  const spool = path.join(runDir(), `spool-${Date.now()}-${process.pid}.json`)
  fs.writeFileSync(spool, JSON.stringify(msg), { mode: 0o600 })
  let roomDisplay = cfg.room
  try { roomDisplay = parseRoom(cfg.room).display } catch {}
  const method = launchUI({ cfg, env, roomDisplay })
  if (method === 'notify' || method === 'off') releaseLaunchLock()
  return { action: 'launched', method }
}

export function readSpool () {
  const out = []
  let files = []
  try { files = fs.readdirSync(runDir()).filter(f => f.startsWith('spool-') && f.endsWith('.json')).sort() } catch {}
  for (const f of files) {
    const p = path.join(runDir(), f)
    try { out.push(JSON.parse(fs.readFileSync(p, 'utf8'))) } catch {}
    try { fs.unlinkSync(p) } catch {}
  }
  return out
}

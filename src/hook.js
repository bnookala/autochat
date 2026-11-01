import fs from 'node:fs'
import path from 'node:path'
import { send } from './ipc.js'
import { loadConfig } from './config.js'
import { launchUI, pickMethod, notify } from './launcher.js'
import { runDir, ensureDir, isValidSessionId } from './paths.js'
import { parseRoom } from './protocol.js'
import { adapter, sessionEvent } from './harness/index.js'
import { hookMessage } from './harness/event.js'

// `autochat hook [--harness <id>] <event>`: the harness's adapter turns the payload into a
// SessionEvent, which goes to the running core (or wakes one). Without --harness it's Copilot.
export { HOOK_EVENTS } from './harness/copilot.js'
// How long a launch may take before another hook tries again. Events in between are
// spooled for the new process. Covers a cold AutoChat.app start (~2-3 s) plus its daemon.
const LOCK_STALE_MS = 15000
const SPOOL_TTL_MS = 2 * 60 * 1000
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000
const OPTOUT_TTL_MS = 2 * 60 * 60 * 1000

// Per-session files: Copilot's keep the names they had before there were other harnesses.
const fileKey = (sid, harness) => !harness || harness === 'copilot' ? sid : `${harness}-${sid}`
const optoutFile = (sid, harness) => path.join(runDir(), 'optout-' + fileKey(sid, harness))
const lockFile = () => path.join(runDir(), 'launch.lock')

export function setOptout (sid, harness) {
  if (!isValidSessionId(sid)) return
  ensureDir(runDir())
  fs.writeFileSync(optoutFile(sid, harness), String(Date.now()))
}

export function clearOptout (sid, harness) {
  try { fs.unlinkSync(optoutFile(sid, harness)) } catch {}
}

function optedOut (sid, harness) {
  try {
    const st = fs.statSync(optoutFile(sid, harness))
    if (Date.now() - st.mtimeMs < OPTOUT_TTL_MS) return true
    clearOptout(sid, harness)
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

// Only an agent working on its own opens autochat: see byTrigger() in src/harness/event.js.
export function shouldLaunch (ev) {
  return ev.autonomy === 'autonomous' && (ev.kind === 'activity' || ev.kind === 'request')
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

/**
 * Entry point for harness hooks. Must never fail or print: preToolUse
 * command hooks are fail-closed, so any error here could block a tool call.
 */
export async function runHook (event, { harness = 'copilot', env = process.env } = {}) {
  const raw = await readStdin()
  let payload = {}
  try { payload = JSON.parse(raw || '{}') || {} } catch {}
  const cfg = loadConfig()
  if (cfg.launch === 'off') return { action: 'disabled' }
  const a = adapter(harness)
  if (!a) return { action: 'unknown-harness' }
  const ev = sessionEvent(a, event, payload, { env, config: cfg })
  if (!ev) return { action: 'no-session' }
  const msg = hookMessage(ev, event)
  if (ev.kind === 'complete' || ev.kind === 'end') clearOptout(ev.sid, ev.harness)

  if (await send(msg, 600)) return { action: 'delivered' }
  // A UI is being launched right now: queue *every* event (including completions) for it.
  if (launchPending()) { spool(msg); return { action: 'spooled' } }
  if (!shouldLaunch(ev)) return { action: 'ignored' }
  if (optedOut(ev.sid, ev.harness)) return { action: 'opted-out' }

  let roomDisplay = cfg.room
  try { roomDisplay = parseRoom(cfg.room).display } catch {}
  const method = pickMethod(cfg, env)
  if (method === 'off') return { action: 'disabled' }
  if (method === 'notify') {
    // No terminal we can open: nudge once per session rather than on every tool call.
    if (!cooledDown(fileKey(ev.sid, ev.harness))) return { action: 'ignored' }
    notify('autochat', `${a.id === 'copilot' ? 'Autopilot engaged' : `${a.name} is working on its own`}. Run \`autochat\` to join ${roomDisplay}.`)
    return { action: 'launched', method }
  }
  if (!acquireLock()) { spool(msg); return { action: 'spooled' } }
  spool(msg)
  launchUI({ cfg, env, method })
  return { action: 'launched', method }
}

function launchPending () {
  try { return Date.now() - fs.statSync(lockFile()).mtimeMs < LOCK_STALE_MS } catch { return false }
}

function cooledDown (key) {
  const f = path.join(runDir(), 'notified-' + key)
  try { if (Date.now() - fs.statSync(f).mtimeMs < NOTIFY_COOLDOWN_MS) return false } catch {}
  ensureDir(runDir())
  fs.writeFileSync(f, '')
  return true
}

function spool (msg) {
  ensureDir(runDir())
  const now = Date.now()
  // Drop leftovers from launches that never came up.
  try {
    for (const f of fs.readdirSync(runDir())) {
      if (!f.startsWith('spool-')) continue
      const p = path.join(runDir(), f)
      try { if (now - fs.statSync(p).mtimeMs > SPOOL_TTL_MS) fs.unlinkSync(p) } catch {}
    }
  } catch {}
  const name = `spool-${String(now).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`
  fs.writeFileSync(path.join(runDir(), name), JSON.stringify(msg), { mode: 0o600 })
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

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { copilotHome, isValidSessionId } from './paths.js'
import { scanEvents, quickMode } from './session.js'
import { sanitize } from './protocol.js'

// Hooks are loaded once when a Copilot CLI process starts, so sessions that were already
// running when `autochat setup` ran never call us. This finds them from session-state instead.

const TAIL = 512 * 1024
const START = new Set(['user.message', 'assistant.turn_start'])
const STOP = new Set(['session.task_complete', 'abort', 'session.shutdown'])
const END = 'assistant.turn_end'

export function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

function lockPid (dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const n of names) {
    const m = /^inuse\.(\d+)\.lock$/.exec(n)
    if (m) return Number(m[1])
  }
  return null
}

function workspaceCwd (dir) {
  try {
    const m = /^cwd: (.+)$/m.exec(fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8'))
    return m ? sanitize(m[1].replace(/^["']|["']$/g, ''), 300) : undefined
  } catch { return undefined }
}

/** Latest start / stop / turn-end timestamps from the tail of a session log. */
export function lifecycle (file) {
  let size
  try { size = fs.statSync(file).size } catch { return null }
  const lc = { lastStart: 0, lastStop: 0, lastEnd: 0 }
  scanEvents(file, Math.max(0, size - TAIL), (t) => START.has(t) || STOP.has(t) || t === END, (e) => {
    const ts = Date.parse(e.timestamp) || 0
    if (START.has(e.type)) lc.lastStart = Math.max(lc.lastStart, ts)
    else if (STOP.has(e.type)) lc.lastStop = Math.max(lc.lastStop, ts)
    else lc.lastEnd = Math.max(lc.lastEnd, ts)
  })
  return lc
}

/**
 * Copilot sessions whose process is alive and whose log changed within `windowMs`.
 * `running` = in autopilot, working on something since the last completion/abort, and not
 * sitting idle after its final turn for longer than `idleMs`.
 */
export function liveSessions ({ idleMs = 45000, windowMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  const root = path.join(copilotHome(), 'session-state')
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return [] }
  const out = []
  for (const sid of dirs) {
    if (!isValidSessionId(sid)) continue
    const dir = path.join(root, sid)
    const file = path.join(dir, 'events.jsonl')
    let mtime
    try { mtime = fs.statSync(file).mtimeMs } catch { continue }
    if (now - mtime > windowMs) continue
    const pid = lockPid(dir)
    if (!pid || !pidAlive(pid)) continue
    const mode = quickMode(sid)
    const lc = lifecycle(file) || { lastStart: 0, lastStop: 0, lastEnd: 0 }
    const working = lc.lastStart > lc.lastStop
    const idle = lc.lastEnd > lc.lastStart && now - mtime > idleMs
    out.push({ sid, pid, mode, cwd: workspaceCwd(dir), mtime, ...lc, running: mode === 'autopilot' && working && !idle, scannedAt: now })
  }
  return out
}

/** Process start time in ms (via `ps -o etime`), or null if unknown. */
export function processStartMs (pid, now = Date.now()) {
  if (process.platform === 'win32') return null
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' })
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout || '')
  if (!m) return null
  const [, d = 0, h = 0, min, s] = m
  return now - ((Number(d) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(s)) * 1000
}

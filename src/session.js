import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { sessionEventsPath, sessionDir, cacheDir, ensureDir, isValidSessionId } from './paths.js'
import { sanitize } from './protocol.js'

const HEAD = 200
const CHUNK = 1024 * 1024
const TYPE_RE = /^\{"type":"([^"]+)"/

/**
 * Incrementally scan a JSONL file from `offset`, parsing only lines whose
 * leading "type" passes `want`. Huge uninteresting lines are skipped without
 * being buffered. Returns the offset just past the last complete line.
 */
export function scanEvents (file, offset, want, onEvent) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return { offset, missing: true } }
  try {
    const size = fs.fstatSync(fd).size
    let reset = false
    if (size < offset) { offset = 0; reset = true }
    const buf = Buffer.alloc(CHUNK)
    let pos = offset
    let lastComplete = offset
    let parts = []
    let partsLen = 0
    let skipping = false
    let decided = false
    const decide = () => {
      const head = Buffer.concat(parts).subarray(0, HEAD).toString('utf8')
      const m = TYPE_RE.exec(head)
      if (!m || !want(m[1])) { skipping = true; parts = []; partsLen = 0 }
      decided = true
    }
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos)
      if (n <= 0) break
      let i = 0
      while (i < n) {
        let nl = buf.indexOf(10, i)
        if (nl >= n) nl = -1
        const end = nl === -1 ? n : nl
        if (!skipping) {
          parts.push(Buffer.from(buf.subarray(i, end)))
          partsLen += end - i
          if (!decided && partsLen >= HEAD) decide()
        }
        if (nl === -1) { i = n; break }
        if (!skipping) {
          if (!decided) decide()
          if (!skipping) {
            try { onEvent(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch {}
          }
        }
        parts = []; partsLen = 0; skipping = false; decided = false
        lastComplete = pos + nl + 1
        i = nl + 1
      }
      pos += n
    }
    return { offset: lastComplete, reset }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Current agent mode of a Copilot CLI session ("interactive" | "plan" | "autopilot" | null),
 * cached per session so hooks firing on every tool call only read appended bytes.
 */
export function quickMode (sessionId) {
  if (!isValidSessionId(sessionId)) return null
  const file = sessionEventsPath(sessionId)
  const cacheFile = path.join(cacheDir(), sessionId + '.json')
  let cache = { offset: 0, mode: null }
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } } catch {}
  let mode = cache.mode
  const res = scanEvents(file, cache.offset, (t) => t === 'session.mode_changed', (e) => {
    if (typeof e.data?.newMode === 'string') mode = e.data.newMode
  })
  if (res.missing) return null
  if (res.reset) {
    // File shrank (rewritten); rescan from scratch.
    mode = null
    scanEvents(file, 0, (t) => t === 'session.mode_changed', (e) => { mode = e.data?.newMode ?? mode })
  }
  try {
    ensureDir(cacheDir())
    fs.writeFileSync(cacheFile, JSON.stringify({ offset: res.offset, mode }))
  } catch {}
  return mode
}

export function objectiveStatus (sessionId) {
  if (!isValidSessionId(sessionId)) return null
  try {
    const o = JSON.parse(fs.readFileSync(path.join(sessionDir(sessionId), 'autopilot-objective.json'), 'utf8'))
    return o?.current?.status ?? null
  } catch { return null }
}

const WATCHED = new Set([
  'session.mode_changed', 'session.task_complete', 'abort', 'session.shutdown',
  'assistant.turn_start', 'user.message', 'session.autopilot_objective_changed'
])

/**
 * Tails a session's events.jsonl. The initial scan only establishes current mode;
 * lifecycle events are emitted for lines appended after start().
 * Events: mode(newMode), task-complete({summary}), abort(reason), shutdown, activity(type)
 */
export class SessionLog extends EventEmitter {
  constructor (sessionId, { pollMs = 1000 } = {}) {
    super()
    this.sessionId = sessionId
    this.file = sessionEventsPath(sessionId)
    this.pollMs = pollMs
    this.offset = 0
    this.mode = null
    this.timer = null
  }

  /** `since` (ms): also replay lifecycle events logged at or after this time. */
  start ({ since = Infinity } = {}) {
    const replay = []
    const res = scanEvents(this.file, 0, (t) => t === 'session.mode_changed' || (since !== Infinity && WATCHED.has(t)), (e) => {
      if (e.type === 'session.mode_changed' && typeof e.data?.newMode === 'string') this.mode = e.data.newMode
      if (since !== Infinity && Date.parse(e.timestamp) >= since) replay.push(e)
    })
    this.offset = res.offset
    const startMode = this.mode
    this.mode = null
    for (const e of replay) this._event(e)
    this.mode = startMode
    this.timer = setInterval(() => this.poll(), this.pollMs)
    this.timer.unref?.()
    return this
  }

  poll () {
    const res = scanEvents(this.file, this.offset, (t) => WATCHED.has(t), (e) => this._event(e))
    if (!res.missing) this.offset = res.offset
  }

  _event (e) {
    const d = e.data || {}
    switch (e.type) {
      case 'session.mode_changed':
        if (typeof d.newMode === 'string' && d.newMode !== this.mode) {
          this.mode = d.newMode
          this.emit('mode', d.newMode)
        }
        break
      case 'session.task_complete':
        this.emit('task-complete', { summary: typeof d.summary === 'string' ? sanitize(d.summary, 2000) : '' })
        break
      case 'abort':
        this.emit('abort', d.reason || 'abort')
        break
      case 'session.shutdown':
        this.emit('shutdown')
        break
      case 'session.autopilot_objective_changed':
        this.emit('objective', d.status)
        break
      default:
        this.emit('activity', e.type)
    }
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

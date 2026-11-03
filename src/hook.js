import { send } from './ipc.js'
import { loadConfig } from './config.js'
import { adapter, sessionEvent } from './harness/index.js'
import { hookMessage } from './harness/event.js'
import { ring } from './doorbell.js'

// `autochat hook [--harness <id>] <event>`: the harness's adapter turns the payload into a
// SessionEvent, which goes to the running core for its attention queue. With no core running, it
// goes nowhere. Without --harness it's Copilot. On the adapter's doorbell event it also asks the
// agent room's doorbell (src/doorbell.js), whose line is the only thing a hook ever prints.
export { HOOK_EVENTS } from './harness/copilot.js'

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
 * Entry point for harness hooks. Must never fail, and prints only what its harness reads as
 * context: preToolUse command hooks are fail-closed, so any error here could block a tool call.
 * The result's `output`, when there is one, is the doorbell's line in this harness's format, for
 * the hook's stdout (src/doorbell.js).
 */
export async function runHook (event, { harness = 'copilot', env = process.env } = {}) {
  const raw = await readStdin()
  let payload = {}
  try { payload = JSON.parse(raw || '{}') || {} } catch {}
  const cfg = loadConfig()
  const a = adapter(harness)
  // The doorbell is the agent room's, so it rings whether or not you're in the lounge.
  const bell = cfg.doorbell !== 'off' && ringsOn(a, event, payload)
  if (!a) return { action: 'unknown-harness' }
  const ev = sessionEvent(a, event, payload, { env, config: cfg })
  if (!ev) return { action: 'no-session' }
  // Both are one round trip to the same daemon: ask while the hook's message goes out.
  const ringing = bell ? ring({ harness: a.id, sessionId: ev.sid, pid: a.doorbell.pid?.(env) ?? process.ppid }) : null
  let res
  try {
    res = await send(hookMessage(ev, event), 600) ? { action: 'delivered' } : { action: 'not-running' }
  } catch (err) {
    res = { action: 'failed', error: String(err?.message || err) }
  }
  const text = await ringing
  return text ? { ...res, output: a.doorbell.output(text) } : res
}

/**
 * Whether this hook call rings the doorbell: the adapter's doorbell event, and a tool call that
 * isn't the agent reading the room already (or one after which the agent never reads again).
 */
export function ringsOn (a, event, payload) {
  if (!a?.doorbell || a.doorbell.event !== event || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  try { return !a.doorbell.skip?.(payload) } catch { return false }
}

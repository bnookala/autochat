import { isValidSessionId } from '../paths.js'

// The normalized session event (#17, #30): what every adapter's normalize() returns, what
// `autochat hook` sends to the core, and what the Controller consumes.
//
//   { harness, sid, kind, autonomy, mode, headless, cwd, repo, branch, origin, request, summary, reason, files }
//
// kind
//   start     the session started; nothing to do yet
//   activity  the agent is working: a prompt went in, a tool runs
//   request   it's blocked on you, for an approval or an answer (request: {title, message})
//   waiting   it finished its turn and sits at its prompt, waiting for you
//   idle      its turn ended: it may carry on by itself, or wait for you
//   complete  it says it's done (summary)
//   end       the session or its process ended (reason)
//   notice    a hook fired and nothing changed (it still refreshes cwd and origin)
//
// autonomy says whether the agent works without you taking turns, which is what puts you in the
// lounge: see byTrigger(). mode is the harness's own name for its mode (`autopilot`, `auto`, …)
// and headless is true for non-interactive runs (`claude -p`, `codex exec`, …).

export const KINDS = ['start', 'activity', 'request', 'waiting', 'idle', 'complete', 'end', 'notice']
export const AUTONOMY = ['autonomous', 'interactive', 'unknown']
const HARNESS_ID = /^[a-z][a-z0-9-]{0,19}$/

/** The modes a session is in, as `autochat config trigger` names them. */
export const modesOf = (ev) => [ev?.mode, ev?.headless ? 'headless' : null].filter(m => typeof m === 'string' && m)

/**
 * The autonomy rule: a session counts as autonomous when one of its modes is in its harness's
 * trigger list (`autochat config trigger`), interactive when its mode is known and isn't, and
 * unknown when nothing says. `never` never counts.
 */
export function byTrigger (modes, trigger) {
  if (!modes.length) return 'unknown'
  if (!Array.isArray(trigger)) return 'interactive'
  return modes.some(m => trigger.includes(m)) ? 'autonomous' : 'interactive'
}

/**
 * adapter.autonomy() for harnesses whose normalize() fills in mode and headless. `session` is
 * the SessionEvent so far, plus `env` and `trigger` (this harness's trigger list, or 'never').
 */
export const defaultAutonomy = (payload, session) => byTrigger(modesOf(session), session.trigger)

// Sessions are keyed `${harness}:${sid}`. Hook messages from before adapters name no harness:
// they're Copilot's, and so is a bare sid used as a key.
export const sessionKey = (harness, sid) => `${harness || 'copilot'}:${sid}`
const canonical = (key) => typeof key === 'string' && !key.includes(':') ? sessionKey(null, key) : key

export class SessionMap extends Map {
  get (key) { return super.get(canonical(key)) }
  has (key) { return super.has(canonical(key)) }
  set (key, value) { return super.set(canonical(key), value) }
  delete (key) { return super.delete(canonical(key)) }
}

/** Where the agent runs, so the core can put focus back on it (see focusOrigin). */
export const originFrom = (env) => ({ tmux: env.TMUX, tmuxPane: env.TMUX_PANE, termProgram: env.TERM_PROGRAM, bundleId: env.__CFBundleIdentifier })

/**
 * A SessionEvent as it travels on the socket (and in the spool): a `hook` message in the shape
 * daemons have always read (`sessionId`, Copilot's `mode`, `stop` for idle), plus the new fields.
 */
export function hookMessage (ev, event, ts = Date.now()) {
  const { sid, kind, ...rest } = ev
  return { type: 'hook', event, sessionId: sid, ...rest, kind: kind === 'idle' ? 'stop' : kind, ts }
}

/**
 * Back from a hook message: from this version, or from before adapters (no harness, no autonomy:
 * then autonomy is null and the caller derives it from mode). Null if it names no valid session.
 */
export function fromHookMessage (msg) {
  if (!msg || typeof msg !== 'object') return null
  const sid = msg.sessionId ?? msg.sid
  if (!isValidSessionId(sid)) return null
  return {
    harness: typeof msg.harness === 'string' && HARNESS_ID.test(msg.harness) ? msg.harness : null,
    sid,
    kind: msg.kind === 'stop' ? 'idle' : msg.kind,
    autonomy: AUTONOMY.includes(msg.autonomy) ? msg.autonomy : null,
    mode: typeof msg.mode === 'string' ? msg.mode : null,
    headless: msg.headless === true,
    cwd: msg.cwd,
    repo: msg.repo,
    branch: msg.branch,
    origin: msg.origin,
    request: msg.request,
    summary: msg.summary,
    reason: msg.reason,
    files: msg.files,
    via: msg.via,
    ts: msg.ts
  }
}

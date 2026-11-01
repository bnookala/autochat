import { focusOrigin } from '../launcher.js'
import { harnessContext, tilde, isObj } from './util.js'
import { SERVER } from './mcp-config.js'
import { AUTONOMY } from './event.js'
import copilot from './copilot.js'
import claude from './claude.js'
import gemini from './gemini.js'
import opencode from './opencode.js'
import codex from './codex.js'
import pi from './pi.js'

// The harness adapters: one module per coding-agent harness (docs/harnesses.md). Each one owns
// detection, hook install and uninstall, turning hook payloads into SessionEvents, the autonomy
// rule, an optional fallback observer, terminal focus, and registering `autochat mcp`.

export const ADAPTERS = [copilot, claude, gemini, opencode, codex, pi]
export const adapter = (id) => ADAPTERS.find(a => a.id === id) ?? null
// What `autochat setup` installs hooks for without asking.
export const DEFAULT_HOOKS = ['copilot']

export { harnessContext, tilde }

// --- events and the autonomy rule -------------------------------------------------------------------

/**
 * The modes that count as autonomous for a harness: `autochat config trigger <harness> …` (saved
 * as config.trigger[harness]), else the adapter's default. 'never' when switched off.
 */
export function triggerFor (config, id) {
  const t = config?.trigger?.[id]
  if (t === 'never') return 'never'
  if (Array.isArray(t)) return t.filter(m => typeof m === 'string')
  return adapter(id)?.trigger ?? []
}

/** Validates `autochat config trigger <id> <value>`: a mode list, 'never', or null for 'default'. */
export function parseTrigger (id, value) {
  const a = adapter(id)
  if (!a) throw new Error(`usage: autochat config trigger <${ADAPTERS.map(x => x.id).join('|')}> <mode,…>|never|default`)
  if (value === 'never') return 'never'
  if (value === 'default') return null
  const modes = [...new Set(String(value ?? '').split(',').map(s => s.trim()).filter(Boolean))]
  if (!modes.length || modes.some(m => !a.modes.includes(m))) throw new Error(`usage: autochat config trigger ${id} <mode,…>|never|default (${id} modes: ${a.modes.join(', ')})`)
  return modes
}

/** config.trigger with `id` set to `t` (from parseTrigger: null drops the override). */
export function withTrigger (config, id, t) {
  const next = isObj(config?.trigger) ? { ...config.trigger } : {}
  if (t === null) delete next[id]
  else next[id] = t
  return next
}

/** Every harness's effective trigger, for `autochat config trigger` and doctor. */
export const triggers = (config) => Object.fromEntries(ADAPTERS.map(a => [a.id, triggerFor(config, a.id)]))

/**
 * One hook call as a SessionEvent: the adapter's normalize(), then its autonomy() under this
 * harness's trigger. Null when the payload names no session.
 */
export function sessionEvent (a, event, payload, { env = process.env, config = {} } = {}) {
  const ev = a.normalize(event, payload, env)
  if (!ev) return null
  ev.harness = a.id
  const autonomy = a.autonomy(payload, { ...ev, env, trigger: triggerFor(config, a.id) })
  ev.autonomy = AUTONOMY.includes(autonomy) ? autonomy : 'unknown'
  return ev
}

/** Starts every adapter's fallback observer: emit(live, harness). Returns a stop function. */
export function observeAll (ctx, emit) {
  const stops = ADAPTERS.filter(a => a.observe).map(a => a.observe(ctx, (live) => emit(live, a.id)))
  return () => { for (const stop of stops) stop?.() }
}

/** Puts focus back on the terminal running a session, the adapter's way. */
export function focusSession (origin, harness) {
  const a = adapter(harness || 'copilot')
  return (a?.focus ?? focusOrigin)(origin)
}

// --- hooks: setup, uninstall, doctor ----------------------------------------------------------------

/** Plans to install the hooks of these harnesses. */
export function planHooks (ids, ctx = harnessContext()) {
  return ids.map((id) => {
    const a = adapter(id)
    if (!a) return { id, name: id, action: 'unknown' }
    if (!a.planHooks) return { id, name: a.name, action: 'unsupported', reason: `no autochat hooks for ${a.name} yet` }
    return { name: a.name, ...a.planHooks(ctx) }
  })
}

/** Installed harnesses with hooks that setup doesn't install by default: it offers these. */
export const offeredHooks = (ctx = harnessContext()) => ADAPTERS.filter(a => a.planHooks && !DEFAULT_HOOKS.includes(a.id) && a.detect(ctx).installed).map(a => a.id)

/** What uninstall would remove: every adapter's hooks, installed or not. */
export const unplanHooks = (ctx = harnessContext()) => ADAPTERS.filter(a => a.unplanHooks).map(a => ({ name: a.name, ...a.unplanHooks(ctx) }))

/** Per harness with hooks, for doctor: {id, name, installed (the harness), hooks: {installed, file, …}}. */
export const hooksStatus = (ctx = harnessContext()) => ADAPTERS.filter(a => a.hookStatus).map(a => ({ id: a.id, name: a.name, installed: a.detect(ctx).installed, hooks: a.hookStatus(ctx) }))

/** `--harness a,b --harness c` → ['a', 'b', 'c']; `all` is every adapter with hooks. */
export function hookIds (values) {
  const ids = [values].flat().flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean)
  return [...new Set(ids.flatMap(id => id === 'all' ? ADAPTERS.filter(a => a.planHooks).map(a => a.id) : [id]))]
}

/** `autochat setup --harness <ids>`: show each change, then make it (or only show, with dryRun). */
export function setupHooks ({ ids, ctx = harnessContext(), dryRun = false, out = console.log } = {}) {
  const plans = planHooks(ids, ctx)
  out(`Installing autochat's hooks: ${short(`${ctx.node} ${ctx.bin} hook [--harness <id>] <event>`, ctx)}`)
  for (const p of plans) for (const l of describeHookPlan(p, ctx)) out('  ' + l)
  const failed = plans.filter(p => ['unknown', 'unsupported', 'manual'].includes(p.action)).map(p => p.id)
  const todo = plans.filter(p => p.apply)
  if (dryRun) {
    out(todo.length ? 'Dry run: nothing changed.' : 'Nothing to change.')
    return { plans, applied: [], failed }
  }
  const applied = []
  for (const p of todo) {
    try {
      p.apply()
      applied.push(p.id)
      out(`✔ ${p.id} hooks installed`)
    } catch (err) {
      failed.push(p.id)
      out(`✘ ${p.id}: ${err.message}`)
    }
  }
  if (applied.length) out('New sessions pick up the hooks; sessions that are already running keep the ones they started with.')
  else if (!failed.length) out('Nothing to change.')
  return { plans, applied, failed }
}

/**
 * `autochat uninstall`: remove every adapter's hooks. Copilot's lines are the ones uninstall has
 * always printed; other harnesses only say something when there was something to remove.
 */
export function removeHooks ({ ctx = harnessContext(), out = console.log } = {}) {
  const removed = []
  for (const p of unplanHooks(ctx)) {
    try {
      if (p.apply) { p.apply(); removed.push(p.id) }
      if (p.id === 'copilot') out(p.apply ? 'hooks removed.' : 'hooks were not installed.')
      else if (p.apply) out(`removed autochat's hooks from ${p.name} (${tilde(p.file, ctx)})`)
    } catch (err) {
      out(`✘ ${p.id}: ${err.message}`)
    }
  }
  return removed
}

/** Human-readable lines for one hook plan. */
export function describeHookPlan (p, ctx) {
  const label = p.id.padEnd(9)
  switch (p.action) {
    case 'unknown': return [`${label}unknown harness (${ADAPTERS.map(a => a.id).join(', ')})`]
    case 'unsupported': return [`${label}${p.reason}`]
    case 'none': return [`${label}hooks already installed (${tilde(p.file, ctx)})`]
    case 'manual': return [`${label}${p.reason}. Add this yourself:`, ...String(p.snippet).split('\n').map(l => ' '.repeat(9) + l)]
    case 'add':
    case 'update':
    case 'remove': {
      const verb = { add: 'add hooks to', update: 'update hooks in', remove: 'remove hooks from' }[p.action]
      const lines = [`${label}${verb} ${tilde(p.file, ctx)}`]
      for (const l of p.entries || []) lines.push(' '.repeat(9) + (p.action === 'remove' ? '- ' : '+ ') + short(l, ctx))
      return lines
    }
    default: return [`${label}${p.action}`]
  }
}

// --- MCP registration: `autochat setup --agents` ----------------------------------------------------

/** What `setup --agents` would do for each harness: installed ones get a plan. */
export function planAgents (ctx = harnessContext()) {
  return ADAPTERS.map((h) => {
    const det = h.detect(ctx)
    if (!det.installed) return { id: h.id, name: h.name, action: 'absent' }
    return { name: h.name, where: h.mcp.where(ctx), ...h.mcp.plan(ctx) }
  })
}

/** What `uninstall` would remove: every registration we find, installed or not. */
export function unplanAgents (ctx = harnessContext()) {
  return ADAPTERS.map(h => ({ name: h.name, where: h.mcp.where(ctx), ...h.mcp.unplan(ctx) }))
}

/** Per harness, for `autochat doctor`: installed, registered, command still valid. */
export function agentsStatus (ctx = harnessContext()) {
  return ADAPTERS.map((h) => {
    const det = h.detect(ctx)
    const st = det.installed || h.id !== 'claude' ? h.mcp.status(ctx) : { registered: false }
    return { id: h.id, name: h.name, installed: det.installed, where: h.mcp.where(ctx), ...st }
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
  else if (!failed.length && !plans.some(p => ['none', 'manual'].includes(p.action))) out('No agent harnesses found (Copilot CLI, Claude Code, Gemini CLI, opencode, Codex, pi).')
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

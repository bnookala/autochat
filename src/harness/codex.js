import fs from 'node:fs'
import path from 'node:path'
import { isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { readText, readJson, writeJson, writeFileSafely, planned, tilde, exists, isDir, isObj, same, shq } from './util.js'
import { argsFor, commandValid, SERVER } from './mcp-config.js'
import { byTrigger, modesOf, originFrom } from './event.js'

// Codex CLI. Hooks: $CODEX_HOME/hooks.json (~/.codex), one matcher group of ours per event, next
// to the user's own. MCP servers: [mcp_servers.autochat] in $CODEX_HOME/config.toml, a TOML table
// edited as text so comments and formatting survive.
//
// Written from Codex's hooks documentation (developers.openai.com/codex/hooks) and, where it's
// silent, the source and generated hook schemas of Codex rust-v0.166.0 (codex-rs/hooks,
// codex-rs/core/src/hook_runtime.rs). Not run against a live Codex: see docs/harnesses.md.
// - hooks.json is {"description"?, "hooks": {<Event>: [{matcher?, hooks: [{type: "command",
//   command, timeout?, async?, statusMessage?}]}]}}, and Codex rejects other top-level keys.
//   Commands run through the user's login shell, in the session's cwd, with the JSON on stdin.
// - Codex runs a hook only once the user has trusted its exact definition (/hooks in Codex), and
//   records that trust by file, event and position. A changed command needs trusting again.
// - Every payload has session_id, transcript_path, cwd and hook_event_name; all but SessionEnd
//   have permission_mode, which Codex computes from the approval policy alone: bypassPermissions
//   for `never` (codex exec's default, and -a never), default for every policy that asks.
// - Nothing in a payload says `codex exec`. The session's rollout file (transcript_path) does:
//   its first line is the session_meta, with source "exec" (originator "codex_exec").
// - Subagents' tool calls carry the parent's session_id, plus agent_id, and their own rollout.

const TOML_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:autochat|"autochat"|'autochat')\s*(\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_HEADER = /^\s*\[/
const tomlString = (s) => JSON.stringify(String(s))

function tomlBlocks (text) {
  // [start, end) line ranges of [mcp_servers.autochat] and its sub-tables.
  const lines = text.split('\n')
  const ranges = []
  for (let i = 0; i < lines.length; i++) {
    const m = TOML_HEADER.exec(lines[i])
    if (!m) continue
    let j = i + 1
    while (j < lines.length && !ANY_HEADER.test(lines[j])) j++
    ranges.push({ start: i, end: j, sub: !!m[1] })
    i = j - 1
  }
  return { lines, ranges }
}

function tomlValue (lines, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (const l of lines) {
    const m = re.exec(l)
    if (!m) continue
    try { return JSON.parse(m[1].replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))) } catch { return m[1] }
  }
  return undefined
}

const mcp = {
  file: (ctx) => path.join(ctx.codexHome, 'config.toml'),
  where (ctx) { return tilde(this.file(ctx), ctx) },
  read (ctx) {
    const text = readText(this.file(ctx)) ?? ''
    const { lines, ranges } = tomlBlocks(text)
    const main = ranges.find(r => !r.sub)
    const body = main ? lines.slice(main.start + 1, main.end) : null
    const inline = /^\s*autochat\s*=\s*\{/m.test(text) && /^\s*\[\s*mcp_servers\s*\]/m.test(text)
    return { text, lines, ranges, main, body, inline }
  },
  status (ctx) {
    const { body } = this.read(ctx)
    if (!body) return { registered: false }
    const command = tomlValue(body, 'command')
    const args = tomlValue(body, 'args')
    return { registered: true, valid: commandValid(command, args), command: [command, ...(Array.isArray(args) ? args : [])].join(' ') }
  },
  plan (ctx) { return planned((c) => this.compute(c), ctx) },
  compute (ctx) {
    const f = this.file(ctx)
    const { text, lines, main, body, inline } = this.read(ctx)
    const want = { command: ctx.node, args: argsFor('codex', ctx) }
    const block = [`command = ${tomlString(want.command)}`, `args = [${want.args.map(tomlString).join(', ')}]`]
    if (inline) return { id: 'codex', action: 'manual', file: f, reason: `${tilde(f, ctx)} defines autochat inline under [mcp_servers]`, snippet: `[mcp_servers.autochat]\n${block.join('\n')}` }
    if (body && same(tomlValue(body, 'command'), want.command) && same(tomlValue(body, 'args'), want.args)) return { id: 'codex', action: 'none', file: f }
    let next
    if (main) {
      // Rewrite command and args in place (args may span lines); keep the table's other settings.
      const kept = []
      let inArgs = false
      for (const l of body) {
        if (inArgs) { if (l.includes(']')) inArgs = false; continue }
        if (/^\s*command\s*=/.test(l)) continue
        if (/^\s*args\s*=/.test(l)) { inArgs = !l.includes(']'); continue }
        kept.push(l)
      }
      next = [...lines.slice(0, main.start + 1), ...block, ...kept, ...lines.slice(main.end)].join('\n')
    } else {
      const base = text.replace(/\n*$/, '')
      next = (base ? base + '\n\n' : '') + `[mcp_servers.autochat]\n${block.join('\n')}\n`
    }
    return { id: 'codex', action: main ? 'update' : 'add', file: f, entry: `[mcp_servers.autochat]\n${block.join('\n')}`, write: () => writeFileSafely(f, next) }
  },
  unplan (ctx) { return planned((c) => this.uncompute(c), ctx) },
  uncompute (ctx) {
    const f = this.file(ctx)
    const { lines, ranges } = this.read(ctx)
    if (!ranges.length) return { id: 'codex', action: 'none', file: f }
    const drop = new Set()
    for (const r of ranges) for (let i = r.start; i < r.end; i++) drop.add(i)
    const next = lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
    return { id: 'codex', action: 'remove', file: f, write: () => writeFileSafely(f, next) }
  }
}

// --- hooks ------------------------------------------------------------------------------------------

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']
// SessionEnd and Interrupt hooks get 1 s unless they ask for more, and 3 s at most.
const TIMEOUTS = { SessionEnd: 3, Interrupt: 3 }
export const hooksFile = (ctx) => path.join(ctx.codexHome, 'hooks.json')
const command = (ctx, event) => `${shq(ctx.node)} ${shq(ctx.bin)} hook --harness codex ${event} || true`
const group = (ctx, event) => ({ hooks: [{ type: 'command', command: command(ctx, event), timeout: TIMEOUTS[event] ?? 10 }] })
// Ours, wherever it is and whichever install it runs.
const OURS = /autochat\.js'?\s+hook\s+--harness\s+codex(\s|$)/
const ours = (h) => isObj(h) && typeof h.command === 'string' && OURS.test(h.command)
const hasOurs = (g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(ours)

function computeHooks (ctx) {
  const file = hooksFile(ctx)
  const { text, root } = readJson(file)
  const manual = (reason) => ({
    id: 'codex',
    action: 'manual',
    file,
    reason,
    snippet: JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, [group(ctx, e)]])) }, null, 2)
  })
  if (root === undefined) return manual(`${tilde(file, ctx)} isn't plain JSON, so autochat won't rewrite it`)
  const next = root ? structuredClone(root) : {}
  if (next.hooks !== undefined && !isObj(next.hooks)) return manual(`"hooks" in ${tilde(file, ctx)} isn't an object`)
  const hooks = next.hooks || {}
  const changed = []
  let had = false
  for (const event of HOOK_EVENTS) {
    const list = hooks[event] ?? []
    if (!Array.isArray(list)) return manual(`"hooks.${event}" in ${tilde(file, ctx)} isn't a list`)
    const want = group(ctx, event)
    const kept = []
    let placed = false
    for (const g of list) {
      if (!hasOurs(g)) { kept.push(g); continue }
      had = true
      const others = g.hooks.filter(h => !ours(h))
      if (!others.length) {
        // Our own group: replaced where it is (Codex keys trust by position), duplicates dropped.
        if (!placed) kept.push(want)
        placed = true
        continue
      }
      // Our handler, moved into one of the user's groups: updated there.
      const handlers = []
      for (const h of g.hooks) {
        if (!ours(h)) handlers.push(h)
        else if (!placed) { handlers.push(want.hooks[0]); placed = true }
      }
      kept.push({ ...g, hooks: handlers })
    }
    if (!placed) kept.push(want)
    if (JSON.stringify(kept) === JSON.stringify(list)) continue
    hooks[event] = kept
    changed.push(event)
  }
  if (!changed.length) return { id: 'codex', action: 'none', file }
  next.hooks = hooks
  return {
    id: 'codex',
    action: had ? 'update' : 'add',
    file,
    entries: changed.map(e => `${e}: ${command(ctx, e)}`),
    write: () => writeJson(file, text, next)
  }
}

// Is `stripped` (the file without our handlers, with the lists that emptied still there) what
// `before` (readJson of the one-time backup) held? Lists and a `hooks` object we created don't
// count; ones the user had, empty or not, do.
function asBefore (before, stripped, events) {
  if (before.text === null || before.root === undefined) return false
  const orig = before.root ?? {}
  const c = structuredClone(stripped)
  for (const e of events) if (!c.hooks[e].length && !(isObj(orig.hooks) && Object.hasOwn(orig.hooks, e))) delete c.hooks[e]
  if (!Object.keys(c.hooks).length && !Object.hasOwn(orig, 'hooks')) delete c.hooks
  return same(c, orig)
}

// Removes our handlers only, then whatever that leaves empty: our groups, event lists and a
// `hooks` object that held nothing else, and the file itself when nothing at all is left (an
// empty hooks.json does nothing). writeJson() re-serializes the file, so when what's left is
// what it held before autochat first wrote to it, uninstall puts back the backup's exact bytes,
// whatever their layout, line endings or empty lists.
function uncomputeHooks (ctx) {
  const file = hooksFile(ctx)
  const { text, root } = readJson(file)
  if (!root || !isObj(root.hooks)) return { id: 'codex', action: 'none', file }
  const stripped = structuredClone(root)
  const removed = []
  for (const [event, list] of Object.entries(stripped.hooks)) {
    if (!Array.isArray(list) || !list.some(hasOurs)) continue
    const kept = []
    for (const g of list) {
      if (!hasOurs(g)) { kept.push(g); continue }
      const others = g.hooks.filter(h => !ours(h))
      if (others.length) kept.push({ ...g, hooks: others })
    }
    stripped.hooks[event] = kept
    removed.push(event)
  }
  if (!removed.length) return { id: 'codex', action: 'none', file }
  const next = structuredClone(stripped)
  for (const event of removed) if (!next.hooks[event].length) delete next.hooks[event]
  if (!Object.keys(next.hooks).length) delete next.hooks
  const before = readJson(file + '.autochat.bak')
  const write = asBefore(before, stripped, removed)
    ? () => writeFileSafely(file, before.text)
    : Object.keys(next).length ? () => writeJson(file, text, next) : () => fs.rmSync(file, { force: true })
  return { id: 'codex', action: 'remove', file, entries: removed.map(e => `${e}: autochat hook --harness codex ${e}`), write }
}

const commandPaths = (cmd) => (/^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/.exec(cmd) || []).slice(1).map(p => p.replace(/'\\''/g, "'"))

// `hooks = false` under [features] in config.toml (or its old name, codex_hooks) turns every hook
// off. Returns where it's said, or null.
function hooksOff (ctx) {
  const file = mcp.file(ctx)
  const text = readText(file)
  if (!text) return null
  let table = ''
  for (const line of text.split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) { table = header[1].replace(/[\s"']/g, ''); continue }
    const m = /^\s*([\w.\-"' ]+?)\s*=\s*false\s*(?:#.*)?$/.exec(line)
    if (!m) continue
    const key = [table, m[1].replace(/[\s"']/g, '')].filter(Boolean).join('.')
    if (key === 'features.hooks' || key === 'features.codex_hooks') return `${m[1].trim()} = false under [features] in ${tilde(file, ctx)}`
  }
  return null
}

function hookStatus (ctx) {
  const file = hooksFile(ctx)
  const { root } = readJson(file)
  const all = root && isObj(root.hooks) ? root.hooks : {}
  const found = HOOK_EVENTS.map(e => (Array.isArray(all[e]) ? all[e] : []).flatMap(g => isObj(g) && Array.isArray(g.hooks) ? g.hooks : []).find(ours)).filter(Boolean)
  const off = hooksOff(ctx)
  return {
    installed: found.length === HOOK_EVENTS.length,
    partial: found.length > 0 && found.length < HOOK_EVENTS.length,
    // The node and autochat.js our hooks run still exist.
    valid: found.every(h => { const p = commandPaths(h.command); return p.length === 2 && p.every(exists) }),
    disabled: !!off,
    ...(off && { disabledBy: off }),
    file,
    // autochat can't see Codex's trust records.
    ...(found.length && { note: 'Codex runs new or changed hooks only once you trust them: /hooks in Codex' })
  }
}

// --- events -----------------------------------------------------------------------------------------

const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']
const HEAD = 64 * 1024

/**
 * How the session was started, from the first line of its rollout file (the session_meta):
 * {source, originator}, or null when there's no such file or line. Only the head of the file is
 * read; when the session_meta line is longer, its first fields are enough.
 */
export function sessionSource (file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null
  let head
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const line = head.split('\n')[0]
  try {
    const o = JSON.parse(line)
    if (o?.type !== 'session_meta' || !isObj(o.payload)) return null
    return { source: o.payload.source ?? null, originator: typeof o.payload.originator === 'string' ? o.payload.originator : null }
  } catch {}
  if (!/^\{[^{]{0,200}"type":"session_meta"/.test(line)) return null
  // source is a string ("exec", "cli", …) or an object ({"subagent": …}).
  const m = /"source":(?:"([\w-]+)"|(\{))/.exec(line)
  const originator = /"originator":"([\w.-]+)"/.exec(line)?.[1] ?? null
  return { source: m ? m[1] ?? {} : null, originator }
}

/** Nobody at Codex's prompt: `codex exec`. null when the rollout doesn't say (or has none). */
export function headless (transcriptPath) {
  const s = sessionSource(transcriptPath)
  if (!s) return null
  // A subagent, a custom client, an internal thread: the session that matters is another one.
  if (s.source !== null && typeof s.source !== 'string') return null
  if (s.source === 'exec') return true
  if (['cli', 'vscode', 'mcp'].includes(s.source)) return false
  if (s.source === null && s.originator === 'codex_exec') return true
  if (s.source === null && s.originator === 'codex_cli_rs') return false
  return null
}

const str = (v) => typeof v === 'string' ? v : ''

// apply_patch's input is the patch: `*** Add File: <path>` and so on.
function patchFiles (patch) {
  const out = []
  for (const m of str(patch).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const f = m[1].trim()
    if (f && !out.includes(f)) out.push(f)
  }
  return out.slice(0, 20)
}

function editedFiles (tool, input) {
  if (tool !== 'apply_patch' || !isObj(input)) return undefined
  const files = patchFiles(input.command).map(f => sanitize(f, 300))
  return files.length ? files : undefined
}

function describeTool (tool, input) {
  const i = isObj(input) ? input : {}
  const what = tool === 'apply_patch' ? patchFiles(i.command).join(', ') : str(i.command)
  const why = str(i.description)
  const text = [tool || 'a tool', what && `: ${what}`, why && ` (${why})`].filter(Boolean).join('')
  return sanitize(text, 600)
}

// request_user_input: questions, each with options.
function describeQuestions (input) {
  const qs = isObj(input) && Array.isArray(input.questions) ? input.questions.filter(isObj) : []
  return sanitize(qs.map((q) => {
    const choices = Array.isArray(q.options) ? q.options.map(o => isObj(o) ? str(o.label) : str(o)).filter(Boolean) : []
    return str(q.question) + (choices.length ? ` [${choices.join(' / ')}]` : '')
  }).filter(Boolean).join(' · '), 600)
}

/** A Codex hook payload as a SessionEvent (autonomy is decided by autonomy()). */
export function normalize (event, p, env) {
  if (!isObj(p) || !isValidSessionId(p.session_id)) return null
  const name = str(p.hook_event_name) || event
  const tool = str(p.tool_name)
  const ev = {
    harness: 'codex',
    sid: p.session_id,
    kind: 'notice',
    mode: MODES.includes(p.permission_mode) ? p.permission_mode : null,
    // A subagent's payload points at the subagent's rollout, which can't say.
    headless: p.agent_id ? null : headless(p.transcript_path),
    cwd: typeof p.cwd === 'string' ? sanitize(p.cwd, 300) : undefined,
    origin: originFrom(env)
  }
  switch (name) {
    case 'SessionStart':
      ev.kind = 'start'
      break
    case 'UserPromptSubmit':
    case 'SubagentStart':
    case 'SubagentStop':
      ev.kind = 'activity'
      break
    case 'PreToolUse':
    case 'PostToolUse':
      if (name === 'PreToolUse' && tool === 'request_user_input') {
        ev.kind = 'request'
        ev.request = { title: 'Codex has a question for you', message: describeQuestions(p.tool_input) }
      } else {
        ev.kind = 'activity'
      }
      ev.files = editedFiles(tool, p.tool_input)
      break
    case 'PermissionRequest':
      ev.kind = 'request'
      ev.request = { title: 'Permission needed', message: describeTool(tool, p.tool_input) }
      break
    case 'Stop':
      ev.kind = 'idle'
      if (str(p.last_assistant_message)) ev.summary = sanitize(p.last_assistant_message, 2000)
      break
    case 'Interrupt':
      // You stopped the turn: you're at the prompt now.
      ev.kind = 'waiting'
      break
    case 'SessionEnd':
      ev.kind = 'end'
      ev.reason = sanitize(String(p.reason || 'end'), 32)
      break
  }
  if (!ev.files) delete ev.files
  return ev
}

// `codex exec`, by default. When the rollout can't say whether anyone is there, a mode that
// doesn't count by itself leaves the session unknown, rather than ending it.
function autonomy (payload, session) {
  const a = byTrigger(modesOf(session), session.trigger)
  const headlessCounts = Array.isArray(session.trigger) && session.trigger.includes('headless')
  return a === 'interactive' && session.headless === null && headlessCounts ? 'unknown' : a
}

// --- the doorbell -----------------------------------------------------------------------------------

// From Codex's hooks documentation (not run live): hookSpecificOutput.additionalContext from a
// PostToolUse hook is added to the model's context as developer context. Our PostToolUse hook
// already runs for every tool. Codex runs hooks through a login shell, whose parent is Codex.
const ROOM_TOOL = new RegExp(`^mcp__${SERVER}__`)
const doorbell = {
  event: 'PostToolUse',
  skip: (p) => typeof p.tool_name === 'string' && ROOM_TOOL.test(p.tool_name),
  output: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

export default {
  id: 'codex',
  name: 'Codex',
  modes: [...MODES, 'headless'],
  trigger: ['headless'],
  detect (ctx) {
    const binary = ctx.which('codex')
    return { installed: !!binary || isDir(ctx.codexHome), binary, paths: { config: mcp.file(ctx), hooks: hooksFile(ctx) } }
  },
  hooksNote: 'Codex skips new or changed hooks until you trust them: open /hooks in Codex and trust autochat\'s.',
  planHooks: (ctx) => planned(computeHooks, ctx),
  unplanHooks: (ctx) => planned(uncomputeHooks, ctx),
  hookStatus,
  normalize,
  autonomy,
  doorbell,
  focus: focusOrigin,
  mcp
}

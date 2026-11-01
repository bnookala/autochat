import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-codex-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const H = await import('../src/harness/index.js')
const { headless, sessionSource, hooksFile, HOOK_EVENTS } = await import('../src/harness/codex.js')
const { hookMessage } = await import('../src/harness/event.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')

const codex = H.adapter('codex')
const CODEX_HOME = path.join(tmp, 'codex-home')

// Built from Codex's documentation and hook schemas (see each file's `note`), with each session's
// rollout written under a temp CODEX_HOME as Codex writes its first line.
function fixture (name) {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'codex', name + '.json'), 'utf8'))
  const real = (p) => p.replace('$CODEX_HOME', CODEX_HOME)
  for (const [p, meta] of Object.entries(f.rollouts)) {
    const file = real(p)
    const id = /([0-9a-f-]{36})\.jsonl$/.exec(file)[1]
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = { timestamp: '2026-10-31T17:15:00.000Z', type: 'session_meta', payload: { session_id: id, id, timestamp: '2026-10-31T17:15:00.000Z', cwd: '/Users/me/code/demo', originator: meta.originator, cli_version: '0.166.0', source: meta.source } }
    fs.writeFileSync(file, JSON.stringify(line) + '\n{"timestamp":"2026-10-31T17:15:01.000Z","type":"turn_context","payload":{}}\n')
  }
  return f.events.map(e => ({ ...e, payload: e.payload.transcript_path ? { ...e.payload, transcript_path: real(e.payload.transcript_path) } : e.payload }))
}
const replay = (events, config = {}) => events.map(e => H.sessionEvent(codex, e.event, e.payload, { env: e.env, config }))
const pick = (evs, k) => evs.map(e => e[k] ?? null)

// What the generated input schemas (codex-rs/hooks/schema/generated, rust-v0.166.0) require.
const COMMON = ['cwd', 'hook_event_name', 'model', 'permission_mode', 'session_id', 'transcript_path']
const REQUIRED = {
  SessionStart: [...COMMON, 'source'],
  UserPromptSubmit: [...COMMON, 'prompt', 'turn_id'],
  PreToolUse: [...COMMON, 'tool_input', 'tool_name', 'tool_use_id', 'turn_id'],
  PermissionRequest: [...COMMON, 'tool_input', 'tool_name', 'turn_id'],
  PostToolUse: [...COMMON, 'tool_input', 'tool_name', 'tool_response', 'tool_use_id', 'turn_id'],
  Stop: [...COMMON, 'last_assistant_message', 'stop_hook_active', 'turn_id'],
  Interrupt: [...COMMON, 'turn_id'],
  SessionEnd: ['cwd', 'hook_event_name', 'reason', 'session_id', 'transcript_path']
}
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']

test('fixtures match the documented hook inputs', () => {
  for (const name of ['exec', 'tui', 'tui-never', 'exec-subagent']) {
    for (const e of fixture(name)) {
      assert.equal(e.payload.hook_event_name, e.event)
      for (const k of REQUIRED[e.event]) assert.ok(k in e.payload, `${name} ${e.event}: ${k}`)
      if ('permission_mode' in e.payload) assert.ok(PERMISSION_MODES.includes(e.payload.permission_mode))
    }
  }
  assert.deepEqual(Object.keys(REQUIRED).sort(), [...HOOK_EVENTS].sort(), 'every event we install')
})

test('fixtures: codex exec is headless and autonomous throughout; edits name their files', () => {
  const evs = replay(fixture('exec'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'activity', 'activity', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), Array(8).fill('autonomous'), 'the rollout says source: exec')
  assert.deepEqual(pick(evs, 'mode'), [...Array(7).fill('bypassPermissions'), null], 'SessionEnd has no permission_mode')
  assert.ok(evs.every(e => e.harness === 'codex' && e.sid === evs[0].sid && e.headless === true && e.cwd === '/Users/me/code/demo'))
  assert.deepEqual(evs[4].files, ['src/greeting.js', 'test/greeting.test.js'], 'apply_patch: the files in the patch')
  assert.equal(evs[2].files, undefined, 'Bash names no files')
  assert.equal(evs[6].summary, 'greet now takes a name; tests pass.')
  assert.equal(evs[7].reason, 'other')
  assert.ok(replay(fixture('exec'), { trigger: { codex: 'never' } }).every(e => e.autonomy === 'interactive'))
})

test('fixtures: the TUI is interactive; approvals, questions and an interrupt map', () => {
  const evs = replay(fixture('tui'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'request', 'activity', 'request', 'idle', 'activity', 'waiting', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), [...Array(8).fill('interactive'), 'unknown'], 'source: cli, default approvals (SessionEnd has no permission_mode)')
  assert.deepEqual(evs[2].request, { title: 'Permission needed', message: 'Bash: npm install left-pad (Install the dependency the change needs)' })
  assert.deepEqual(evs[4].request, { title: 'Codex has a question for you', message: 'Which color should the button be? [Red / Blue]' })
  assert.equal(evs[5].summary, 'Done: left-pad is in, the button is blue.')

  // -a never in a terminal: an approval-bypass mode, so it only counts when you say so.
  const never = replay(fixture('tui-never'))
  assert.deepEqual(pick(never, 'autonomy'), Array(4).fill('interactive'))
  assert.deepEqual(pick(replay(fixture('tui-never'), { trigger: { codex: ['bypassPermissions', 'headless'] } }), 'autonomy'), Array(4).fill('autonomous'), 'autochat config trigger codex bypassPermissions,headless')
  assert.deepEqual(H.parseTrigger('codex', 'bypassPermissions,headless'), ['bypassPermissions', 'headless'])
  assert.throws(() => H.parseTrigger('codex', 'never-ask'), /codex modes: default, acceptEdits, plan, dontAsk, bypassPermissions, headless/)
})

test('fixtures: a subagent\'s calls point at its own rollout, which can\'t say: unknown, never interactive', () => {
  const evs = replay(fixture('exec-subagent'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'activity', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), ['autonomous', 'autonomous', 'autonomous', 'unknown', 'unknown', 'autonomous', 'autonomous'])
  assert.deepEqual(pick(evs, 'headless'), [true, true, true, null, null, true, true])
  assert.ok(evs.every(e => e.sid === evs[0].sid), 'one session: the parent\'s')
})

test('the headless signal: rollouts old and new, long, missing or odd', () => {
  const dir = path.join(tmp, 'rollouts')
  fs.mkdirSync(dir, { recursive: true })
  const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f }
  const meta = (payload) => JSON.stringify({ timestamp: 't', type: 'session_meta', payload }) + '\n'
  assert.equal(headless(file('exec.jsonl', meta({ id: 'x', originator: 'codex_exec', source: 'exec' }))), true)
  assert.equal(headless(file('cli.jsonl', meta({ id: 'x', originator: 'codex_cli_rs', source: 'cli' }))), false)
  assert.equal(headless(file('vscode.jsonl', meta({ id: 'x', source: 'vscode' }))), false)
  assert.equal(headless(file('mcp.jsonl', meta({ id: 'x', source: 'mcp' }))), false, 'codex mcp-server: another agent drives it')
  assert.equal(headless(file('old-exec.jsonl', meta({ id: 'x', originator: 'codex_exec' }))), true, 'before source: the originator')
  assert.equal(headless(file('old-cli.jsonl', meta({ id: 'x', originator: 'codex_cli_rs' }))), false)
  assert.equal(headless(file('sub.jsonl', meta({ id: 'x', source: { subagent: 'review' } }))), null)
  assert.equal(headless(file('custom.jsonl', meta({ id: 'x', source: { custom: 'my-app' } }))), null)
  assert.equal(headless(file('unknown.jsonl', meta({ id: 'x', source: 'unknown' }))), null)
  // A session_meta line longer than what's read (huge base instructions): its first fields do.
  const big = { session_id: 'x', id: 'x', timestamp: 't', cwd: '/w', originator: 'codex_exec', cli_version: '0.166.0', source: 'exec', base_instructions: { text: 'x'.repeat(200 * 1024) } }
  assert.equal(headless(file('long.jsonl', meta(big))), true)
  assert.equal(headless(file('long-sub.jsonl', meta({ ...big, source: { subagent: 'x' } }))), null)
  assert.deepEqual(sessionSource(file('long2.jsonl', meta({ ...big, source: 'cli', originator: 'codex_cli_rs' }))), { source: 'cli', originator: 'codex_cli_rs' })
  assert.equal(headless(file('other.jsonl', '{"timestamp":"t","type":"turn_context","payload":{"source":"exec"}}\n')), null)
  assert.equal(headless(file('garbage.jsonl', 'not json\n')), null)
  assert.equal(headless(file('empty.jsonl', '')), null)
  for (const p of [null, undefined, 3, '', 'relative.jsonl', path.join(dir, 'missing.jsonl'), dir]) assert.equal(headless(p), null)

  // With no rollout (codex exec --ephemeral) bypassPermissions alone leaves it unknown.
  const p = { session_id: 's-1', hook_event_name: 'PreToolUse', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: null }
  assert.equal(H.sessionEvent(codex, 'PreToolUse', p, { env: {} }).autonomy, 'unknown')
  assert.equal(H.sessionEvent(codex, 'PreToolUse', p, { env: {}, config: { trigger: { codex: ['bypassPermissions'] } } }).autonomy, 'autonomous')
  for (const bad of [null, [], 'x', {}, { session_id: '../x' }]) assert.equal(codex.normalize('Stop', bad, {}), null)
  assert.equal(codex.normalize('Stop', { session_id: 's-1' }, {}).kind, 'idle', 'the event from the command line when the payload has none')
  assert.equal(codex.normalize('PreCompact', { session_id: 's-1', hook_event_name: 'PreCompact', trigger: 'auto' }, {}).kind, 'notice')
  assert.equal(codex.normalize('PermissionRequest', { session_id: 's-1', hook_event_name: 'PermissionRequest', tool_name: 'mcp__fs__write', tool_input: { path: 'x' } }, {}).request.message, 'mcp__fs__write')
  assert.equal(codex.normalize('PermissionRequest', { session_id: 's-1', hook_event_name: 'PermissionRequest', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Delete File: old.js\n*** End Patch' } }, {}).request.message, 'apply_patch: old.js')
})

// --- install, rerun, uninstall ------------------------------------------------------------------

// A user's ~/.codex/hooks.json with hooks of their own on some of the same events (as the
// documentation shows them: two spaces, a description, a final newline).
const USER_HOOKS = {
  description: 'My hooks.',
  hooks: {
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/session_start.py', statusMessage: 'Loading session notes' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/python3 "$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py"', statusMessage: 'Checking Bash command' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/stop_continue.py', timeout: 30 }] }],
    PostCompact: [{ matcher: 'manual|auto', hooks: [{ type: 'mcp_tool', server: 'notes', tool: 'save' }] }]
  }
}
const userText = JSON.stringify(USER_HOOKS, null, 2) + '\n'
const USER_TOML = '# my codex config\nmodel = "gpt-5.1-codex"\n\n[features]\nweb_search = true\n'
const ours = (h) => /autochat\.js' hook --harness codex /.test(h.command)
const withoutOurs = (cfg) => {
  const c = structuredClone(cfg)
  for (const [e, list] of Object.entries(c.hooks || {})) {
    c.hooks[e] = list.map(g => ({ ...g, hooks: g.hooks.filter(h => !ours(h)) })).filter(g => g.hooks.length)
    if (!c.hooks[e].length) delete c.hooks[e]
  }
  if (c.hooks && !Object.keys(c.hooks).length) delete c.hooks
  return c
}
function user (name, hooks = userText, toml = USER_TOML) {
  const home = path.join(tmp, name)
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  if (hooks !== null) fs.writeFileSync(path.join(codexHome, 'hooks.json'), hooks)
  if (toml !== null) fs.writeFileSync(path.join(codexHome, 'config.toml'), toml)
  const node = path.join(home, 'node')
  const bin = path.join(home, 'autochat', 'bin', 'autochat.js')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(node, '')
  fs.writeFileSync(bin, '')
  const ctx = H.harnessContext({ env: { HOME: home, PATH: '' }, node, bin })
  const file = path.join(codexHome, 'hooks.json')
  return { home, codexHome, file, ctx, node, bin, read: () => fs.readFileSync(file, 'utf8'), toml: () => fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') }
}

test('install merges into hooks.json next to the user\'s hooks; rerun is a no-op; uninstall is byte-for-byte', () => {
  const u = user('merge')
  assert.equal(hooksFile(u.ctx), u.file)
  const plan = codex.planHooks(u.ctx)
  assert.deepEqual([plan.action, plan.file, plan.entries.length], ['add', u.file, 8])
  assert.match(plan.entries.find(e => e.startsWith('Interrupt')), /^Interrupt: '.*node' '.*autochat\.js' hook --harness codex Interrupt \|\| true$/)
  plan.apply()

  const cfg = JSON.parse(u.read())
  assert.equal(JSON.stringify(withoutOurs(cfg)), JSON.stringify(USER_HOOKS), 'every other hook and the description unchanged, in order')
  assert.deepEqual(Object.keys(cfg), ['description', 'hooks'], 'nothing else at the top: Codex rejects unknown keys')
  assert.deepEqual(Object.keys(cfg.hooks), ['SessionStart', 'PreToolUse', 'Stop', 'PostCompact', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Interrupt', 'SessionEnd'])
  assert.deepEqual(cfg.hooks.PreToolUse[0], USER_HOOKS.hooks.PreToolUse[0], 'theirs first, ours appended')
  assert.deepEqual(cfg.hooks.PreToolUse[1], { hooks: [{ type: 'command', command: `'${u.node}' '${u.bin}' hook --harness codex PreToolUse || true`, timeout: 10 }] }, 'no matcher: every tool')
  assert.equal(cfg.hooks.SessionEnd[0].hooks[0].timeout, 3, 'SessionEnd and Interrupt: 3 s, their maximum')
  assert.equal(cfg.hooks.Interrupt[0].hooks[0].timeout, 3)
  assert.ok(Object.values(cfg.hooks).flat().flatMap(g => g.hooks).filter(ours).every(h => Object.keys(h).join() === 'type,command,timeout'), 'synchronous, no status message')
  assert.equal(fs.readFileSync(u.file + '.autochat.bak', 'utf8'), userText, 'one-time backup')
  assert.equal(u.toml(), USER_TOML, 'config.toml untouched')
  assert.deepEqual(codex.hookStatus(u.ctx), { installed: true, partial: false, valid: true, disabled: false, file: u.file, note: 'Codex runs new or changed hooks only once you trust them: /hooks in Codex' })

  const mtime = fs.statSync(u.file).mtimeMs
  assert.equal(codex.planHooks(u.ctx).action, 'none')
  assert.equal(H.setupHooks({ ids: ['codex'], ctx: u.ctx, out: () => {} }).applied.length, 0)
  assert.equal(fs.statSync(u.file).mtimeMs, mtime, 'rerunning writes nothing, so Codex keeps trusting them')

  const un = codex.unplanHooks(u.ctx)
  assert.equal(un.action, 'remove')
  un.apply()
  assert.equal(u.read(), userText, 'uninstall leaves the file exactly as it was')
  assert.equal(codex.unplanHooks(u.ctx).action, 'none')
  assert.equal(fs.readFileSync(u.file + '.autochat.bak', 'utf8'), userText, 'the backup is never overwritten')
})

test('a moved install updates in place; ours inside a user group; a file of our own; not JSON; CODEX_HOME; hooks turned off', () => {
  const u = user('moved')
  codex.planHooks(u.ctx).apply()
  const moved = H.harnessContext({ env: { HOME: u.home, PATH: '' }, node: u.node, bin: path.join(u.home, 'new', 'bin', 'autochat.js') })
  const before = JSON.parse(u.read())
  const up = codex.planHooks(moved)
  assert.equal(up.action, 'update')
  up.apply()
  const after = JSON.parse(u.read())
  for (const e of Object.keys(after.hooks)) {
    const mine = after.hooks[e].flatMap(g => g.hooks).filter(ours)
    if (!before.hooks[e].flatMap(g => g.hooks).some(ours)) continue
    assert.equal(mine.length, 1, `${e}: one copy`)
    assert.match(mine[0].command, /new\/bin\/autochat\.js' hook --harness codex/)
    assert.equal(after.hooks[e].findIndex(g => g.hooks.some(ours)), before.hooks[e].findIndex(g => g.hooks.some(ours)), `${e}: same position (Codex keys trust by it)`)
  }
  assert.equal(codex.hookStatus(moved).valid, false, "the new path doesn't exist on disk")

  // The user moved our Stop handler into their own group: updated there; uninstall leaves theirs.
  const cfg = JSON.parse(u.read())
  cfg.hooks.Stop[0].hooks.push(cfg.hooks.Stop.pop().hooks[0])
  delete cfg.hooks.SessionEnd
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  assert.equal(codex.hookStatus(u.ctx).partial, true)
  codex.planHooks(u.ctx).apply()
  const fixed = JSON.parse(u.read())
  assert.equal(fixed.hooks.Stop.length, 1)
  assert.deepEqual(fixed.hooks.Stop[0].hooks.map(h => ours(h) ? 'ours' : h.command), ['python3 ~/.codex/hooks/stop_continue.py', 'ours'])
  codex.unplanHooks(u.ctx).apply()
  assert.deepEqual(JSON.parse(u.read()).hooks.Stop, USER_HOOKS.hooks.Stop)

  // No hooks.json yet: one of our own, gone again on uninstall.
  const fresh = user('fresh', null)
  codex.planHooks(fresh.ctx).apply()
  assert.deepEqual(Object.keys(JSON.parse(fresh.read())), ['hooks'])
  assert.ok(fresh.read().startsWith('{\n  "hooks": {\n'), 'two spaces')
  codex.unplanHooks(fresh.ctx).apply()
  assert.equal(fs.existsSync(fresh.file), false)
  assert.deepEqual(fs.readdirSync(fresh.codexHome).sort(), ['config.toml'])

  // Not plain JSON, or `hooks` isn't an object: shown, never rewritten.
  for (const [name, text, reason] of [['jsonc', '{\n  // mine\n  "hooks": {}\n}\n', /isn't plain JSON, so autochat won't rewrite it/], ['list', '{"hooks": []}\n', /"hooks" in ~\/\.codex\/hooks\.json isn't an object/], ['event', '{"hooks": {"Stop": {}}}\n', /"hooks\.Stop" .* isn't a list/]]) {
    const v = user(name, text)
    const manual = codex.planHooks(v.ctx)
    assert.equal(manual.action, 'manual', name)
    assert.equal(manual.apply, undefined)
    assert.match(H.describeHookPlan(manual, v.ctx).join('\n'), reason)
    assert.equal(codex.unplanHooks(v.ctx).action, 'none')
    assert.equal(v.read(), text)
  }
  assert.match(H.describeHookPlan(codex.planHooks(user('jsonc2', '{,}').ctx), u.ctx).join('\n'), /Add this yourself:\n\s+\{\n\s+"hooks": \{\n\s+"SessionStart": \[/)

  // CODEX_HOME moves it; `hooks = false` under [features] turns every hook off.
  const dir = path.join(tmp, 'codex-dir')
  const ctx = H.harnessContext({ env: { HOME: u.home, CODEX_HOME: dir, PATH: '' }, node: u.node, bin: u.bin })
  assert.equal(codex.planHooks(ctx).file, path.join(dir, 'hooks.json'))
  codex.planHooks(ctx).apply()
  assert.equal(codex.hookStatus(ctx).disabled, false)
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "x"\n\n[features]\nweb_search = true\nhooks = false # for now\n\n[mcp_servers.x]\ncommand = "y"\n')
  assert.deepEqual([codex.hookStatus(ctx).disabled, codex.hookStatus(ctx).disabledBy], [true, `hooks = false under [features] in ${path.join(dir, 'config.toml')}`])
  fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\ncodex_hooks = false\n')
  assert.equal(codex.hookStatus(ctx).disabled, true, 'its old name')
  fs.writeFileSync(path.join(dir, 'config.toml'), '[profiles.x.features]\nhooks = false\n[features]\nhooks = true\n')
  assert.equal(codex.hookStatus(ctx).disabled, false, 'only in a profile')
})

test('uninstall puts back the exact bytes autochat found, whatever their layout; edits made since are kept', () => {
  const layouts = {
    'one-line': '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "notify.sh", "timeout": 30.0}]}]}}',
    'crlf-inline': '{\r\n    "description": "caf\\u00e9",\r\n    "hooks": {\r\n        "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "check.sh" } ] } ],\r\n        "Stop": []\r\n    }\r\n}\r\n',
    'empty-hooks': '{"hooks":{}}\n',
    'empty-file': ''
  }
  for (const [name, text] of Object.entries(layouts)) {
    const u = user('layout-' + name, text)
    codex.planHooks(u.ctx).apply()
    assert.equal(codex.hookStatus(u.ctx).installed, true, name)
    codex.unplanHooks(u.ctx).apply()
    assert.equal(u.read(), text, `${name}: byte-for-byte`)
  }

  // Their own hooks changed meanwhile: theirs are kept as they are now, ours go.
  const u = user('layout-edited', layouts['one-line'])
  codex.planHooks(u.ctx).apply()
  const cfg = JSON.parse(u.read())
  cfg.hooks.Stop[0].hooks[0].command = 'notify.sh --loud'
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  codex.unplanHooks(u.ctx).apply()
  assert.deepEqual(JSON.parse(u.read()), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh --loud', timeout: 30 }] }] } })
})

test('hooks (hooks.json) and the agent room (config.toml) are separate, and uninstall removes both', () => {
  const u = user('both')
  codex.planHooks(u.ctx).apply()
  assert.deepEqual(H.setupAgents({ ctx: u.ctx, out: () => {} }).applied, ['codex'])
  assert.match(u.toml(), /^# my codex config\nmodel = "gpt-5\.1-codex"\n\n\[features\]\nweb_search = true\n\n\[mcp_servers\.autochat\]\n/)
  assert.equal(codex.hookStatus(u.ctx).installed, true)
  assert.deepEqual(H.removeHooks({ ctx: u.ctx, out: () => {} }), ['codex'])
  assert.equal(u.read(), userText)
  assert.equal(H.agentsStatus(u.ctx).find(h => h.id === 'codex').registered, true, 'the room stays')
  assert.deepEqual(H.removeAgents({ ctx: u.ctx, out: () => {} }), ['codex'])
  assert.equal(u.toml(), USER_TOML)
})

// The parent env minus anything that points at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT|CODEX|CLAUDE)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|TMUX|TMUX_PANE|TERM_PROGRAM|__CFBundleIdentifier)$/.test(k)))

test('CLI: setup offers Codex, setup --harness codex installs it and says to trust them, the hook delivers SessionEvents, uninstall', async () => {
  const u = user('cli')
  const bins = path.join(tmp, 'cli-bin')
  fs.mkdirSync(bins, { recursive: true })
  fs.writeFileSync(path.join(bins, 'codex'), '#!/bin/sh\nexit 1\n')
  fs.chmodSync(path.join(bins, 'codex'), 0o755)
  const env = { ...baseEnv, HOME: u.home, AUTOCHAT_HOME: path.join(tmp, 'cli-ac'), COPILOT_HOME: path.join(u.home, '.copilot'), AUTOCHAT_HARNESS_PATH: bins, AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'cli-launches.jsonl') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const plain = cli('setup')
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /Also found Codex\. To go to the lounge from it too: autochat setup --harness codex/)
  assert.equal(u.read(), userText, 'plain setup without a terminal never touches it')

  const dry = cli('setup', '--harness', 'codex', '--dry-run')
  assert.match(dry.stdout, /codex {4}add hooks to ~\/\.codex\/hooks\.json\n {11}\+ SessionStart: '/)
  assert.equal(u.read(), userText)
  const real = cli('setup', '--harness', 'codex')
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /✔ codex hooks installed\nCodex skips new or changed hooks until you trust them: open \/hooks in Codex and trust autochat's\./)
  assert.match(cli('setup', '--harness', 'codex').stdout, /codex {4}hooks already installed \(~\/\.codex\/hooks\.json\)\nNothing to change\./)

  // The documented payloads through `autochat hook --harness codex`, to a running core.
  const { serve } = await import('../src/ipc.js')
  process.env.AUTOCHAT_HOME = env.AUTOCHAT_HOME
  const got = []
  const server = await serve((m) => { got.push(m); return {} })
  try {
    for (const e of fixture('exec').slice(1, 5)) {
      await new Promise((resolve) => {
        const c = spawn(process.execPath, [BIN, 'hook', '--harness', 'codex', e.event], { env: { ...env, ...e.env, TMUX: '/t,1,0', TMUX_PANE: '%7' } })
        c.stdin.end(JSON.stringify(e.payload))
        c.on('exit', resolve)
      })
    }
  } finally {
    server.close()
    process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
  }
  assert.deepEqual(got.map(m => [m.type, m.harness, m.event, m.kind, m.mode, m.headless, m.autonomy]), [
    ['hook', 'codex', 'UserPromptSubmit', 'activity', 'bypassPermissions', true, 'autonomous'],
    ['hook', 'codex', 'PreToolUse', 'activity', 'bypassPermissions', true, 'autonomous'],
    ['hook', 'codex', 'PostToolUse', 'activity', 'bypassPermissions', true, 'autonomous'],
    ['hook', 'codex', 'PreToolUse', 'activity', 'bypassPermissions', true, 'autonomous']
  ])
  assert.equal(got[0].sessionId, '019a3f2e-6b1c-7d40-a3e2-1c9b7f4d2e10')
  assert.deepEqual(got[0].origin, { tmux: '/t,1,0', tmuxPane: '%7' })
  assert.deepEqual(got[3].files, ['src/greeting.js', 'test/greeting.test.js'])

  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /^hooks removed\.\nremoved autochat's hooks from Codex \(~\/\.codex\/hooks\.json\)\n$/)
  assert.equal(u.read(), userText)
})

test('Controller: a codex exec run puts you in the lounge until it ends; the TUI asks you, and never does', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-codex-' + Math.random().toString(36).slice(2, 12), idleMs: 300, announce: false, countdownSeconds: 30 },
    bootstrap: testnet.bootstrap,
    roomOpts: { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 },
    focus: () => {},
    notify: () => {},
    watchLogs: false
  })
  t.after(() => c.shutdown())
  const send = (e, config) => c.handle(hookMessage(H.sessionEvent(codex, e.event, e.payload, { env: e.env, config }), e.event))

  const run = fixture('exec')
  assert.equal(send(run[0]).tracked, false, 'SessionStart alone tracks nothing')
  send(run[1])
  assert.equal(c.phase, 'room')
  const sid = run[0].payload.session_id
  assert.deepEqual(c.snapshot().sessions, [{ sid, state: 'running', cwd: '/Users/me/code/demo', harness: 'codex' }])
  for (const e of run.slice(2, 7)) send(e)
  send(run[7])
  assert.equal(c.sessions.size, 0)
  assert.deepEqual([c.countdown?.reason, c.countdown?.summary], ['end', 'greet now takes a name; tests pass.'])

  // A subagent's calls neither end the run nor start one.
  const sub = fixture('exec-subagent')
  for (const e of sub.slice(0, 4)) send(e)
  assert.equal(c.sessions.get(`codex:${sub[0].payload.session_id}`).state, 'running')
  send(sub[4])
  assert.equal(c.sessions.get(`codex:${sub[0].payload.session_id}`).state, 'running', 'unknown keeps it as it is')
  send(sub[6])

  // The TUI with `autochat config trigger codex default`: an approval is a request card; an
  // interrupt means you're back.
  const tui = fixture('tui')
  const counts = { trigger: { codex: ['default'] } }
  send(tui[1], counts)
  send(tui[2], counts)
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message], ['Permission needed', 'Bash: npm install left-pad (Install the dependency the change needs)'])
  send(tui[3], counts)
  assert.equal(c.currentRequest().resolved, true, 'approved: the tool ran')
  send(tui[6], counts)
  send(tui[7], counts)
  assert.equal(c.sessions.size, 0, 'Interrupt: you stopped it, it waits for you')
  for (const e of tui) send(e)
  assert.equal(c.sessions.size, 0, 'by default the TUI never counts')
})

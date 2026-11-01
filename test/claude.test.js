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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-claude-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const H = await import('../src/harness/index.js')
const { headless } = await import('../src/harness/claude.js')
const { hookMessage } = await import('../src/harness/event.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')

// Recorded from the real Claude Code 2.1.273 (see each file's `how`).
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'claude', name + '.json'), 'utf8')).events
const claude = H.adapter('claude')
const replay = (events, config = {}) => events.map(e => H.sessionEvent(claude, e.event, e.payload, { env: e.env, config }))
const pick = (evs, k) => evs.map(e => e[k] ?? null)

test('fixtures: a headless auto run is autonomous throughout; Stop carries the last message', () => {
  const evs = replay(fixture('headless-auto'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), Array(6).fill('autonomous'), 'CLAUDE_CODE_SESSION_ATTENDED=0')
  assert.deepEqual(pick(evs, 'mode'), [null, 'auto', 'auto', 'auto', 'auto', null], 'SessionStart and SessionEnd have no permission_mode')
  assert.ok(evs.every(e => e.harness === 'claude' && e.sid === evs[0].sid && e.headless === true && e.cwd === '/Users/me/code/demo'))
  assert.equal(evs[4].summary, 'Done with bash.')
  assert.equal(evs[5].reason, 'other')
})

test('fixtures: in a terminal, manual mode is interactive; requests and the idle prompt map', () => {
  const evs = replay(fixture('interactive-manual'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'request', 'request', 'activity', 'idle', 'waiting'])
  assert.deepEqual(pick(evs, 'autonomy'), ['unknown', 'interactive', 'interactive', 'interactive', 'unknown', 'interactive', 'interactive', 'unknown'], 'Notification has no permission_mode')
  assert.deepEqual(pick(evs, 'mode'), [null, 'manual', 'manual', 'manual', null, 'manual', 'manual', null], 'payloads say "default" for manual')
  assert.deepEqual(evs[3].request, { title: 'Permission needed', message: 'Bash: touch perm-test.txt' })
  assert.deepEqual(evs[4].request, { title: 'Permission needed', message: '' }, 'permission_prompt only repeats the PermissionRequest')
  assert.equal(evs[0].headless, false)

  // `autochat config trigger claude manual,headless`: now manual mode counts.
  const counted = replay(fixture('interactive-manual'), { trigger: { claude: ['manual', 'headless'] } })
  assert.deepEqual(pick(counted, 'autonomy'), ['unknown', 'autonomous', 'autonomous', 'autonomous', 'unknown', 'autonomous', 'autonomous', 'unknown'])
  assert.ok(replay(fixture('headless-auto'), { trigger: { claude: 'never' } }).every(e => e.autonomy === 'interactive'))
})

test('fixtures: AskUserQuestion is a request with its choices; auto mode in a terminal counts', () => {
  const evs = replay(fixture('interactive-auto-question'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'request', 'request', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), ['unknown', 'autonomous', 'autonomous', 'autonomous', 'autonomous', 'autonomous', 'unknown'])
  const q = { title: 'Claude has a question for you', message: 'Which color should the button be? [Red / Blue]' }
  assert.deepEqual(evs[2].request, q, 'PreToolUse(AskUserQuestion)')
  assert.deepEqual(evs[3].request, q, 'PermissionRequest(AskUserQuestion): the same question')
  assert.equal(evs[6].reason, 'prompt_input_exit')
})

test('fixtures: background sessions are unattended, attached or not; edits name their files; mode names', () => {
  const bg = replay(fixture('background'))
  assert.ok(bg.every(e => e.headless === true && e.autonomy === 'autonomous'), 'claude --bg: entrypoint cli, attended 0')
  assert.equal(bg.find(e => e.kind === 'activity').mode, 'manual')

  const edits = replay(fixture('headless-accept-edits'))
  assert.deepEqual(edits.filter(e => e.files).map(e => [e.mode, e.files]), [['acceptEdits', ['/Users/me/code/demo/a.txt']], ['acceptEdits', ['/Users/me/code/demo/a.txt']]])
  assert.ok(replay(fixture('headless-accept-edits'), { trigger: { claude: ['auto'] } }).filter(e => e.mode).every(e => e.autonomy === 'interactive'), 'acceptEdits alone does not count')
  assert.deepEqual(pick(replay(fixture('permission-modes')), 'mode'), ['dontAsk', 'plan', 'bypassPermissions'])
  assert.ok(replay(fixture('headless-permission')).some(e => e.kind === 'request' && e.request.message === 'Bash: touch perm-test.txt'), 'PermissionRequest fires in -p too')
})

test('the headless signal, and no signal at all', () => {
  assert.equal(headless({ CLAUDE_CODE_SESSION_ATTENDED: '0', CLAUDE_CODE_ENTRYPOINT: 'cli' }), true)
  assert.equal(headless({ CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), false)
  assert.equal(headless({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), true, 'older versions: -p')
  assert.equal(headless({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false)
  assert.equal(headless({}), null)
  const p = { session_id: 's-1', hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Read', tool_input: {} }
  assert.equal(H.sessionEvent(claude, 'PreToolUse', p, { env: {} }).autonomy, 'unknown', 'manual mode, and nothing says whether anyone is there')
  assert.equal(H.sessionEvent(claude, 'PreToolUse', { ...p, permission_mode: 'auto' }, { env: {} }).autonomy, 'autonomous')
  for (const bad of [null, [], 'x', {}, { session_id: '../x' }]) assert.equal(claude.normalize('Stop', bad, {}), null)
  assert.equal(claude.normalize('Whatever', { session_id: 's-1', hook_event_name: 'SubagentStop' }, {}).kind, 'notice')
  assert.equal(claude.normalize('Stop', { session_id: 's-1' }, {}).kind, 'idle', 'the event name from the command line when the payload has none')
})

// A user's ~/.claude/settings.json with hooks of their own on the same events (as Claude Code
// writes it: two spaces, final newline).
const USER_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'], deny: [] },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/sidepulse/start.sh' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rex check-bash', timeout: 5 }] }, { matcher: '*', hooks: [{ type: 'command', command: 'context-mode hook pre' }] }],
    Stop: [{ hooks: [{ type: 'command', command: '~/.claude/sidepulse/stop.sh' }, { type: 'command', command: 'say done' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'context-mode hook compact' }] }]
  },
  enabledPlugins: { 'rex@local': true },
  statusLine: { type: 'command', command: 'sidepulse status' }
}
const userText = JSON.stringify(USER_SETTINGS, null, 2) + '\n'
const ours = (h) => /autochat\.js' hook --harness claude /.test(h.command)
const withoutOurs = (cfg) => {
  const c = structuredClone(cfg)
  for (const [e, list] of Object.entries(c.hooks || {})) {
    c.hooks[e] = list.map(g => ({ ...g, hooks: g.hooks.filter(h => !ours(h)) })).filter(g => g.hooks.length)
    if (!c.hooks[e].length) delete c.hooks[e]
  }
  if (c.hooks && !Object.keys(c.hooks).length) delete c.hooks
  return c
}
function user (name, settings = userText) {
  const home = path.join(tmp, name)
  const file = path.join(home, '.claude', 'settings.json')
  if (settings !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, settings)
  }
  const node = path.join(home, 'node')
  const bin = path.join(home, 'autochat', 'bin', 'autochat.js')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(node, '')
  fs.writeFileSync(bin, '')
  const ctx = H.harnessContext({ env: { HOME: home, PATH: '' }, node, bin })
  return { home, file, ctx, node, bin, read: () => fs.readFileSync(file, 'utf8') }
}

test('install merges into settings.json next to the user\'s hooks; rerun is a no-op; uninstall is byte-for-byte', () => {
  const u = user('merge')
  const plan = claude.planHooks(u.ctx)
  assert.equal(plan.action, 'add')
  assert.equal(plan.file, u.file)
  assert.equal(plan.entries.length, 8)
  assert.match(plan.entries.find(e => e.startsWith('Notification')), /^Notification \(permission_prompt\|idle_prompt\|elicitation_dialog\): '.*node' '.*autochat\.js' hook --harness claude Notification \|\| true$/)
  plan.apply()

  const cfg = JSON.parse(u.read())
  assert.equal(JSON.stringify(withoutOurs(cfg)), JSON.stringify(USER_SETTINGS), 'every other setting and hook unchanged, in order')
  assert.deepEqual(Object.keys(cfg.hooks), ['SessionStart', 'PreToolUse', 'Stop', 'PreCompact', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'SessionEnd'])
  assert.deepEqual(cfg.hooks.PreToolUse.slice(0, 2), USER_SETTINGS.hooks.PreToolUse, 'theirs first, ours appended')
  assert.deepEqual(cfg.hooks.PreToolUse[2], { hooks: [{ type: 'command', command: `'${u.node}' '${u.bin}' hook --harness claude PreToolUse || true`, timeout: 10 }] })
  assert.equal(cfg.hooks.Notification[0].matcher, 'permission_prompt|idle_prompt|elicitation_dialog')
  assert.equal(fs.readFileSync(u.file + '.autochat.bak', 'utf8'), userText, 'one-time backup')
  assert.deepEqual(claude.hookStatus(u.ctx), { installed: true, partial: false, valid: true, disabled: false, file: u.file })

  const mtime = fs.statSync(u.file).mtimeMs
  assert.equal(claude.planHooks(u.ctx).action, 'none')
  assert.equal(H.setupHooks({ ids: ['claude'], ctx: u.ctx, out: () => {} }).applied.length, 0)
  assert.equal(fs.statSync(u.file).mtimeMs, mtime, 'rerunning writes nothing')

  const un = claude.unplanHooks(u.ctx)
  assert.equal(un.action, 'remove')
  un.apply()
  assert.equal(u.read(), userText, 'uninstall leaves the file exactly as it was')
  assert.equal(claude.unplanHooks(u.ctx).action, 'none')
  assert.equal(fs.readFileSync(u.file + '.autochat.bak', 'utf8'), userText, 'the backup is never overwritten')
})

test('a moved install updates our hooks in place; ours inside a user group; no file, no hooks key, comments', () => {
  const u = user('moved')
  claude.planHooks(u.ctx).apply()
  const moved = H.harnessContext({ env: { HOME: u.home, PATH: '' }, node: u.node, bin: path.join(u.home, 'new', 'bin', 'autochat.js') })
  const before = JSON.parse(u.read())
  const up = claude.planHooks(moved)
  assert.equal(up.action, 'update')
  up.apply()
  const after = JSON.parse(u.read())
  for (const e of Object.keys(after.hooks)) {
    const mine = after.hooks[e].flatMap(g => g.hooks).filter(ours)
    if (!before.hooks[e].flatMap(g => g.hooks).some(ours)) continue
    assert.equal(mine.length, 1, `${e}: one copy`)
    assert.match(mine[0].command, /new\/bin\/autochat\.js' hook --harness claude/)
    assert.equal(after.hooks[e].findIndex(g => g.hooks.some(ours)), before.hooks[e].findIndex(g => g.hooks.some(ours)), `${e}: same place`)
  }
  assert.equal(claude.hookStatus(moved).valid, false, "the new path doesn't exist on disk")

  // The user moved our Stop handler into their own group: updated there, and uninstall leaves theirs.
  const cfg = JSON.parse(u.read())
  const oursStop = cfg.hooks.Stop.pop().hooks[0]
  cfg.hooks.Stop[0].hooks.push(oursStop)
  delete cfg.hooks.SessionEnd
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  assert.equal(claude.hookStatus(u.ctx).partial, true)
  claude.planHooks(u.ctx).apply()
  const fixed = JSON.parse(u.read())
  assert.equal(fixed.hooks.Stop.length, 1)
  assert.deepEqual(fixed.hooks.Stop[0].hooks.map(h => ours(h) ? 'ours' : h.command), ['~/.claude/sidepulse/stop.sh', 'say done', 'ours'])
  assert.equal(fixed.hooks.SessionEnd.length, 1)
  claude.unplanHooks(u.ctx).apply()
  assert.deepEqual(JSON.parse(u.read()).hooks.Stop, USER_SETTINGS.hooks.Stop)

  // No settings.json yet; then one without hooks.
  const fresh = user('fresh', null)
  claude.planHooks(fresh.ctx).apply()
  assert.deepEqual(Object.keys(JSON.parse(fresh.read())), ['hooks'])
  const plain = user('plain', '{\n  "model": "opus"\n}\n')
  claude.planHooks(plain.ctx).apply()
  claude.unplanHooks(plain.ctx).apply()
  assert.equal(plain.read(), '{\n  "model": "opus"\n}\n')

  // JSON with comments: shown, never rewritten.
  const jsonc = user('jsonc', '{\n  // mine\n  "model": "opus"\n}\n')
  const manual = claude.planHooks(jsonc.ctx)
  assert.equal(manual.action, 'manual')
  assert.equal(manual.apply, undefined)
  assert.match(H.describeHookPlan(manual, jsonc.ctx).join('\n'), /isn't plain JSON \(comments\?\), so autochat won't rewrite it\. Add this yourself:\n\s+\{\n\s+"hooks": \{/)
  assert.equal(claude.unplanHooks(jsonc.ctx).action, 'none')

  // CLAUDE_CONFIG_DIR moves the settings; disableAllHooks is reported.
  const dir = path.join(tmp, 'claude-config-dir')
  const ctx = H.harnessContext({ env: { HOME: u.home, CLAUDE_CONFIG_DIR: dir, PATH: '' }, node: u.node, bin: u.bin })
  assert.equal(claude.planHooks(ctx).file, path.join(dir, 'settings.json'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"disableAllHooks": true}')
  claude.planHooks(ctx).apply()
  assert.deepEqual(claude.hookStatus(ctx), { installed: true, partial: false, valid: true, disabled: true, file: path.join(dir, 'settings.json') })
  assert.ok(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').endsWith('}'), 'no final newline added')
})

// The parent env minus anything that points at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT|CLAUDE)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDECODE|TMUX|TMUX_PANE|TERM_PROGRAM|__CFBundleIdentifier)$/.test(k)))

test('CLI: setup offers Claude Code, setup --harness claude installs it, the hook delivers SessionEvents, uninstall removes ours', async () => {
  const home = path.join(tmp, 'cli')
  const bins = path.join(tmp, 'cli-bin')
  fs.mkdirSync(bins, { recursive: true })
  fs.writeFileSync(path.join(bins, 'claude'), '#!/bin/sh\nexit 1\n')
  fs.chmodSync(path.join(bins, 'claude'), 0o755)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), userText)
  const env = { ...baseEnv, HOME: home, AUTOCHAT_HOME: path.join(tmp, 'cli-ac'), COPILOT_HOME: path.join(home, '.copilot'), AUTOCHAT_HARNESS_PATH: bins, AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'cli-launches.jsonl') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const plain = cli('setup')
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /Also found Claude Code\. To go to the lounge from it too: autochat setup --harness claude/)
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), userText, 'plain setup without a terminal never touches it')

  const dry = cli('setup', '--harness', 'claude', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /claude {3}add hooks to ~\/\.claude\/settings\.json\n {11}\+ SessionStart: '/)
  assert.match(dry.stdout, /Dry run: nothing changed\./)
  const real = cli('setup', '--harness', 'claude')
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /✔ claude hooks installed/)
  assert.match(cli('setup', '--harness', 'claude').stdout, /claude {3}hooks already installed \(~\/\.claude\/settings\.json\)\nNothing to change\./)

  // The recorded Claude Code payloads through `autochat hook --harness claude`, to a running core.
  const { serve } = await import('../src/ipc.js')
  process.env.AUTOCHAT_HOME = env.AUTOCHAT_HOME
  const got = []
  const server = await serve((m) => { got.push(m); return {} })
  try {
    for (const e of fixture('interactive-auto-question').slice(1, 4)) {
      await new Promise((resolve) => {
        const c = spawn(process.execPath, [BIN, 'hook', '--harness', 'claude', e.event], { env: { ...env, ...e.env, TMUX: '/t,1,0', TMUX_PANE: '%7' } })
        c.stdin.end(JSON.stringify(e.payload))
        c.on('exit', resolve)
      })
    }
  } finally {
    server.close()
    process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
  }
  assert.deepEqual(got.map(m => [m.type, m.harness, m.event, m.kind, m.mode, m.autonomy]), [
    ['hook', 'claude', 'UserPromptSubmit', 'activity', 'auto', 'autonomous'],
    ['hook', 'claude', 'PreToolUse', 'request', 'auto', 'autonomous'],
    ['hook', 'claude', 'PermissionRequest', 'request', 'auto', 'autonomous']
  ])
  assert.equal(got[0].sessionId, '7f6889e0-60a3-4688-9f0f-aaa32bde0001')
  assert.deepEqual(got[0].origin, { tmux: '/t,1,0', tmuxPane: '%7' })
  assert.equal(got[1].request.message, 'Which color should the button be? [Red / Blue]')

  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /^hooks removed\.\nremoved autochat's hooks from Claude Code \(~\/\.claude\/settings\.json\)\n$/)
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), userText)
})

test('Controller: a Claude Code session from its recorded hooks, with the permission notification 6 s late', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-claude-' + Math.random().toString(36).slice(2, 12), idleMs: 300, announce: false, countdownSeconds: 30 },
    bootstrap: testnet.bootstrap,
    roomOpts: { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 },
    focus: () => {},
    notify: () => {},
    watchLogs: false
  })
  t.after(() => c.shutdown())
  const send = (e) => c.handle(hookMessage(H.sessionEvent(claude, e.event, e.payload, { env: e.env }), e.event))

  const q = fixture('interactive-auto-question')
  assert.equal(send(q[0]).tracked, false, 'SessionStart alone tracks nothing')
  send(q[1])
  assert.equal(c.phase, 'room')
  const sid = q[0].payload.session_id
  assert.deepEqual(c.snapshot().sessions, [{ sid, state: 'running', cwd: '/Users/me/code/demo', harness: 'claude' }])
  send(q[2])
  send(q[3])
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message], ['Claude has a question for you', 'Which color should the button be? [Red / Blue]'])
  send(q[4])
  assert.equal(c.currentRequest().resolved, true, 'answered: the agent moved on')
  send(q[5])
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.deepEqual([c.countdown?.reason, c.countdown?.summary], ['idle', 'Done with ask.'], 'Stop, then nothing for idleMs')
  assert.equal(send(q[6]).tracked, false, 'already done')

  // In auto mode a permission prompt: the bare notification 6 s later keeps the detail.
  const m = fixture('interactive-manual').map(e => ({ ...e, payload: { ...e.payload, permission_mode: e.payload.permission_mode && 'auto' } }))
  send(m[1])
  send(m[3])
  c.sessions.get(`claude:${m[0].payload.session_id}`).request.at -= 6000
  send(m[4])
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message], ['Permission needed', 'Bash: touch perm-test.txt'])
  send(m[7])
  assert.equal(c.sessions.size, 0, 'idle_prompt: waiting at its prompt, done')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-harness-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const H = await import('../src/harness/index.js')
const E = await import('../src/harness/event.js')
const copilot = await import('../src/harness/copilot.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')
const { saveConfig } = await import('../src/config.js')

// The parent env minus anything pointing at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|TMUX|TMUX_PANE)$/.test(k)))
const env = {
  ...baseEnv,
  HOME: path.join(tmp, 'home'),
  AUTOCHAT_HOME: process.env.AUTOCHAT_HOME,
  COPILOT_HOME: process.env.COPILOT_HOME,
  AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'launches.jsonl'),
  AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'),
  AUTOCHAT_HARNESS_PATH: path.join(tmp, 'no-harnesses'),
  AUTOCHAT_DEBUG: '1'
}
const cli = (args, input, extra = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { input, env: { ...env, ...extra }, encoding: 'utf8' })
  const last = r.stderr.trim().split('\n').pop()
  let result = null
  try { result = JSON.parse(last) } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result }
}
const copilotSession = (sid, mode) => {
  const dir = path.join(process.env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'session.mode_changed', data: { newMode: mode } }) + '\n')
}

test('registry: every adapter has the interface, in the order setup lists them', () => {
  assert.deepEqual(H.ADAPTERS.map(a => a.id), ['copilot', 'claude', 'gemini', 'opencode', 'codex', 'pi'])
  for (const a of H.ADAPTERS) {
    assert.equal(H.adapter(a.id), a)
    assert.equal(typeof a.name, 'string')
    for (const fn of ['detect', 'normalize', 'autonomy']) assert.equal(typeof a[fn], 'function', `${a.id}.${fn}`)
    for (const fn of ['where', 'status', 'plan', 'unplan']) assert.equal(typeof a.mcp[fn], 'function', `${a.id}.mcp.${fn}`)
    assert.ok(Array.isArray(a.modes) && a.modes.length, `${a.id}.modes`)
    assert.ok(a.trigger.every(m => a.modes.includes(m)), `${a.id}: its default trigger names its own modes`)
    if (a.planHooks) for (const fn of ['unplanHooks', 'hookStatus']) assert.equal(typeof a[fn], 'function', `${a.id}.${fn}`)
  }
  assert.equal(H.adapter('nope'), null)
  assert.deepEqual(H.DEFAULT_HOOKS, ['copilot'], 'setup is Copilot-only by default')
})

test('the autonomy rule: modes against the trigger list; config overrides it per harness', () => {
  assert.equal(E.byTrigger(['autopilot'], ['autopilot']), 'autonomous')
  assert.equal(E.byTrigger(['plan'], ['autopilot']), 'interactive')
  assert.equal(E.byTrigger([], ['autopilot']), 'unknown', 'nothing says')
  assert.equal(E.byTrigger(['auto'], 'never'), 'interactive')
  assert.deepEqual(E.modesOf({ mode: 'acceptEdits', headless: true }), ['acceptEdits', 'headless'])
  assert.deepEqual(E.modesOf({ mode: null }), [])
  assert.equal(E.defaultAutonomy({}, { mode: 'acceptEdits', headless: true, trigger: ['auto', 'headless'] }), 'autonomous', 'a headless run counts')

  // Defaults from the epic: Copilot autopilot, Claude auto + headless, the rest headless runs.
  assert.deepEqual(H.triggers({}), { copilot: ['autopilot'], claude: ['auto', 'headless'], gemini: ['headless'], opencode: ['headless'], codex: ['headless'], pi: ['headless'] })
  const cfg = { trigger: { copilot: ['autopilot', 'plan'], claude: 'never' } }
  assert.deepEqual(H.triggerFor(cfg, 'copilot'), ['autopilot', 'plan'])
  assert.equal(H.triggerFor(cfg, 'claude'), 'never')
  assert.deepEqual(H.triggerFor({ trigger: 'garbage' }, 'copilot'), ['autopilot'])

  assert.deepEqual(H.parseTrigger('copilot', 'plan, autopilot,plan'), ['plan', 'autopilot'])
  assert.equal(H.parseTrigger('claude', 'never'), 'never')
  assert.equal(H.parseTrigger('claude', 'default'), null)
  assert.throws(() => H.parseTrigger('copilot', 'auto'), /copilot modes: interactive, plan, autopilot/)
  assert.throws(() => H.parseTrigger('copilot', ''), /usage/)
  assert.throws(() => H.parseTrigger('nope', 'x'), /usage: autochat config trigger <copilot\|claude\|gemini\|opencode\|codex\|pi>/)
  assert.deepEqual(H.withTrigger(cfg, 'copilot', null), { claude: 'never' })
  assert.deepEqual(H.withTrigger({}, 'gemini', ['headless']), { gemini: ['headless'] })
})

test('SessionEvents travel as hook messages older daemons read; sessions are keyed harness:sid', () => {
  const ev = { harness: 'claude', sid: 'c-1', kind: 'idle', autonomy: 'autonomous', mode: 'auto', cwd: '/w', files: ['/w/a.js'], summary: 'did it' }
  const msg = E.hookMessage(ev, 'Stop', 5)
  assert.deepEqual(msg, { type: 'hook', event: 'Stop', sessionId: 'c-1', harness: 'claude', autonomy: 'autonomous', mode: 'auto', cwd: '/w', files: ['/w/a.js'], summary: 'did it', kind: 'stop', ts: 5 })
  const back = E.fromHookMessage(JSON.parse(JSON.stringify(msg)))
  for (const k of Object.keys(ev)) assert.deepEqual(back[k], ev[k], k)

  // From before adapters: no harness (Copilot), no autonomy (derived from mode by the core).
  const legacy = E.fromHookMessage({ type: 'hook', event: 'agentStop', sessionId: 's-1', kind: 'stop', mode: 'autopilot', ts: 1 })
  assert.deepEqual([legacy.harness, legacy.kind, legacy.autonomy, legacy.mode], [null, 'idle', null, 'autopilot'])
  assert.equal(E.fromHookMessage({ type: 'hook', sessionId: '../x' }), null)
  assert.equal(E.fromHookMessage({ type: 'hook', sessionId: 's', harness: 'Not An Id' }).harness, null)

  const m = new E.SessionMap()
  m.set(E.sessionKey('claude', 'same'), 'claude session')
  m.set(E.sessionKey(null, 'same'), 'copilot session')
  assert.deepEqual([...m.keys()], ['claude:same', 'copilot:same'])
  assert.equal(m.get('same'), 'copilot session', 'a bare sid is a Copilot session')
  assert.equal(m.get('claude:same'), 'claude session')
  assert.equal(m.has('copilot:same'), true)
  m.delete('same')
  assert.deepEqual([...m.keys()], ['claude:same'])
})

test('Copilot adapter: hook payloads map to SessionEvents, with the mode from its session log', () => {
  copilotSession('cp-auto', 'autopilot')
  copilotSession('cp-plan', 'plan')
  const a = H.adapter('copilot')
  const e = { TMUX: '/t,1,0', TMUX_PANE: '%4', TERM_PROGRAM: 'ghostty' }
  const ev = (event, payload, config = {}) => H.sessionEvent(a, event, payload, { env: e, config })

  assert.equal(ev('preToolUse', { cwd: '/x' }), null, 'no session id')
  assert.deepEqual(ev('preToolUse', { sessionId: 'cp-auto', cwd: '/w', toolCalls: [{ name: 'bash', args: {} }] }), {
    harness: 'copilot', sid: 'cp-auto', kind: 'activity', mode: 'autopilot', autonomy: 'autonomous', cwd: '/w', origin: { tmux: '/t,1,0', tmuxPane: '%4', termProgram: 'ghostty', bundleId: undefined }
  })
  const kinds = [
    ['userPromptSubmitted', {}, 'activity'],
    ['postToolUse', { toolName: 'task_complete', toolArgs: { summary: 'ok' } }, 'complete'],
    ['preToolUse', { toolCalls: [{ name: 'ask_user', args: { question: 'Which?', choices: ['a', 'b'] } }] }, 'request'],
    ['notification', { notificationType: 'permission_prompt', message: 'Run it?' }, 'request'],
    ['notification', { notification_type: 'shell_completed' }, 'notice'],
    ['agentStop', {}, 'idle'],
    ['sessionEnd', { reason: 'exit' }, 'end'],
    ['somethingNew', {}, 'notice']
  ]
  for (const [event, p, kind] of kinds) assert.equal(ev(event, { sessionId: 'cp-auto', ...p }).kind, kind, event)
  assert.equal(ev('postToolUse', { sessionId: 'cp-auto', toolName: 'task_complete', toolArgs: { summary: 'ok' } }).summary, 'ok')
  assert.deepEqual(ev('preToolUse', { sessionId: 'cp-auto', toolCalls: [{ name: 'ask_user', args: { question: 'Which?', choices: ['a', 'b'] } }] }).request, { title: 'Copilot has a question for you', message: 'Which? [a / b]' })

  assert.equal(ev('preToolUse', { sessionId: 'cp-plan' }).autonomy, 'interactive')
  assert.equal(ev('preToolUse', { sessionId: 'cp-none' }).autonomy, 'unknown', 'no session log: mode unknown')
  assert.equal(ev('preToolUse', { sessionId: 'cp-plan' }, { trigger: { copilot: ['autopilot', 'plan'] } }).autonomy, 'autonomous', 'trigger config')
  assert.equal(ev('preToolUse', { sessionId: 'cp-auto' }, { trigger: { copilot: 'never' } }).autonomy, 'interactive')

  assert.equal(a.continues({ sid: 'cp-auto' }), false)
  fs.writeFileSync(path.join(process.env.COPILOT_HOME, 'session-state', 'cp-auto', 'autopilot-objective.json'), JSON.stringify({ current: { status: 'active' } }))
  assert.equal(a.continues({ sid: 'cp-auto' }), true, 'an active objective keeps a stopped session')
  const log = a.follow('cp-auto')
  assert.equal(typeof log.start, 'function')
  assert.deepEqual(Object.keys(a.detect(H.harnessContext({ env }))).sort(), ['binary', 'installed', 'paths'])
})

test('autochat hook --harness: the old form is copilot; unknown harnesses are ignored quietly; the trigger config applies', () => {
  copilotSession('h-plan', 'plan')
  const payload = JSON.stringify({ sessionId: 'h-plan', toolName: 'bash', cwd: '/x' })
  assert.equal(cli(['hook', 'preToolUse'], payload).result.action, 'ignored', 'plan mode does not count by default')
  assert.equal(cli(['hook', '--harness', 'copilot', 'preToolUse'], payload).result.action, 'ignored')
  assert.equal(cli(['hook', '--harness=copilot', 'preToolUse'], payload).result.action, 'ignored')

  const quiet = spawnSync(process.execPath, [BIN, 'hook', '--harness', 'nope', 'Stop'], { input: payload, env: { ...env, AUTOCHAT_DEBUG: '' }, encoding: 'utf8' })
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', ''])
  assert.equal(cli(['hook', '--harness', 'nope', 'Stop'], payload).result.action, 'unknown-harness')
  assert.equal(cli(['hook', '--harness'], payload).result.action, 'unknown-harness')
  assert.equal(cli(['hook', '--harness', 'claude', 'Stop'], payload).result.action, 'no-session', 'no claude session id in it')

  // `autochat config trigger copilot autopilot,plan`: now plan mode opens autochat.
  const set = cli(['config', 'trigger', 'copilot', 'autopilot,plan'])
  assert.equal(set.code, 0, set.stderr)
  assert.deepEqual(JSON.parse(set.stdout).copilot, ['autopilot', 'plan'])
  assert.deepEqual(JSON.parse(cli(['config', 'trigger', 'copilot']).stdout), ['autopilot', 'plan'])
  const r = cli(['hook', 'preToolUse'], payload, { TMUX: '/x/tmux,1,0', TMUX_PANE: '%1' })
  assert.equal(r.result.action, 'launched')
  assert.equal(r.stdout, '')
  const spooled = fs.readdirSync(path.join(env.AUTOCHAT_HOME, 'run')).filter(f => f.startsWith('spool-'))
  const msg = JSON.parse(fs.readFileSync(path.join(env.AUTOCHAT_HOME, 'run', spooled[0]), 'utf8'))
  assert.deepEqual([msg.type, msg.harness, msg.sessionId, msg.kind, msg.mode, msg.autonomy], ['hook', 'copilot', 'h-plan', 'activity', 'plan', 'autonomous'])

  assert.equal(cli(['config', 'trigger', 'copilot', 'never']).code, 0)
  fs.rmSync(path.join(env.AUTOCHAT_HOME, 'run'), { recursive: true, force: true })
  copilotSession('h-auto', 'autopilot')
  assert.equal(cli(['hook', 'preToolUse'], JSON.stringify({ sessionId: 'h-auto' })).result.action, 'ignored', 'never: not even autopilot')
  assert.equal(cli(['config', 'trigger', 'copilot', 'default']).code, 0)
  assert.deepEqual(JSON.parse(cli(['config', 'trigger']).stdout).copilot, ['autopilot'])
  const bad = cli(['config', 'trigger', 'copilot', 'yolo'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /copilot modes: interactive, plan, autopilot/)
  assert.equal(cli(['config', 'trigger', 'nope']).code, 1)
})

test('setup and uninstall go through the adapters; doctor-facing status per harness', () => {
  const home = path.join(tmp, 'u-setup')
  const copilotHome = path.join(home, '.copilot')
  const ctx = H.harnessContext({ env: { HOME: home, COPILOT_HOME: copilotHome, PATH: '' }, node: '/n/node', bin: '/a/bin/autochat.js' })
  const [plan] = H.planHooks(['copilot'], ctx)
  assert.deepEqual([plan.id, plan.action, plan.file], ['copilot', 'add', path.join(copilotHome, 'hooks', 'autochat.json')])
  plan.apply()
  const hooks = JSON.parse(fs.readFileSync(plan.file, 'utf8'))
  assert.equal(hooks.hooks.preToolUse[0].bash, "'/n/node' '/a/bin/autochat.js' hook preToolUse || true", 'Copilot keeps `hook <event>`: no --harness means copilot')
  assert.equal(H.planHooks(['copilot'], ctx)[0].action, 'none', 'idempotent')
  assert.deepEqual(H.hooksStatus(ctx).find(h => h.id === 'copilot').hooks, { installed: true, file: plan.file, legacy: null })

  assert.deepEqual(H.hookIds(['copilot,claude', ' gemini ', 'copilot']), ['copilot', 'claude', 'gemini'])
  assert.deepEqual(H.hookIds(['all']), H.ADAPTERS.filter(a => a.planHooks).map(a => a.id))
  const lines = []
  const r = H.setupHooks({ ids: ['copilot', 'nope'], ctx, out: (l) => lines.push(l) })
  assert.deepEqual([r.applied, r.failed], [[], ['nope']])
  assert.match(lines.join('\n'), /copilot {2}hooks already installed \(~\/\.copilot\/hooks\/autochat\.json\)\n {2}nope {5}unknown harness/)

  fs.writeFileSync(path.join(copilotHome, 'hooks', 'lolchat.json'), '{}')
  const out = []
  assert.deepEqual(H.removeHooks({ ctx, out: (l) => out.push(l) }), ['copilot'])
  assert.deepEqual(out, ['hooks removed.'])
  assert.deepEqual(fs.readdirSync(path.join(copilotHome, 'hooks')), [])
  out.length = 0
  H.removeHooks({ ctx, out: (l) => out.push(l) })
  assert.deepEqual(out, ['hooks were not installed.'])
})

test('observers: each adapter fallback watcher feeds adopt(live, harness)', async () => {
  const got = []
  const stop = H.observeAll({ idleMs: 1000, intervalMs: 20, trigger: () => ['autopilot'] }, (live, harness) => got.push([harness, live.length]))
  await new Promise(resolve => setTimeout(resolve, 70))
  stop()
  const n = got.length
  assert.ok(n >= 2 && got.every(([h]) => h === 'copilot'), JSON.stringify(got))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(got.length, n, 'stopped')
  assert.deepEqual(copilot.liveSessions({ trigger: 'never' }).filter(l => l.running), [])
})

const FAST = { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 }
function mk (testnet, config = {}) {
  const focused = []
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-harness-' + Math.random().toString(36).slice(2, 12), idleMs: 300, announce: false, countdownSeconds: 30, ...config },
    bootstrap: testnet.bootstrap,
    roomOpts: FAST,
    focus: (o, harness) => focused.push([o, harness]),
    notify: () => {},
    bannerMs: 300,
    requestLingerMs: 500,
    watchLogs: false
  })
  c.focused = focused
  return c
}
const hook = (harness, sid, kind, extra = {}) => ({ type: 'hook', harness, sessionId: sid, kind, autonomy: 'autonomous', cwd: '/w/' + sid, ts: Date.now(), origin: { tmuxPane: '%' + sid }, ...extra })

test('Controller: sessions keyed by harness:sid, harness in the snapshot, autonomy decides presence', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet)
  t.after(() => c.shutdown())

  assert.equal(c.handle(hook('claude', 'same', 'activity', { autonomy: 'interactive' })).tracked, false, 'interactive sessions never count')
  assert.equal(c.handle(hook('claude', 'same', 'activity', { autonomy: 'unknown' })).tracked, false)
  assert.equal(c.handle(hook('claude', 'same', 'start')).tracked, false, 'starting is not working')
  c.handle(hook('claude', 'same', 'activity'))
  c.handle(hook('copilot', 'same', 'activity'))
  assert.equal(c.phase, 'room')
  assert.deepEqual([...c.sessions.keys()], ['claude:same', 'copilot:same'])
  assert.deepEqual(c.snapshot().sessions, [
    { sid: 'same', state: 'running', cwd: '/w/same', harness: 'claude' },
    { sid: 'same', state: 'running', cwd: '/w/same', harness: 'copilot' }
  ])
  assert.deepEqual(c.handle({ type: 'status' }).sessions.map(s => s.harness), ['claude', 'copilot'])

  // A request from one harness's session, then that session leaves autonomy.
  c.handle(hook('claude', 'same', 'request', { request: { title: 'Permission needed', message: 'Bash: npm test' } }))
  assert.deepEqual([c.currentRequest().sid, c.currentRequest().key, c.currentRequest().message], ['same', 'claude:same', 'Bash: npm test'])
  c.jumpToCopilot()
  assert.deepEqual(c.focused.at(-1), [{ tmuxPane: '%same' }, 'claude'], 'focus goes through the harness adapter')
  c.handle(hook('claude', 'same', 'activity', { autonomy: 'interactive' }))
  assert.equal(c.sessions.has('claude:same'), false, 'switching to an interactive mode retires the session')
  assert.equal(c.sessions.get('same').harness, 'copilot', 'the Copilot session with the same id is untouched')

  // Another harness's observer never releases Copilot's adopted sessions.
  c.adopt([], 'claude')
  assert.equal(c.sessions.size, 1)

  // waiting (at its prompt) ends autonomy right away; idle carries the last message as summary.
  c.handle(hook('gemini', 'g1', 'activity'))
  c.handle(hook('gemini', 'g1', 'waiting'))
  assert.equal(c.sessions.has('gemini:g1'), false)
  c.handle(hook('copilot', 'same', 'idle', { summary: 'all tests pass' }))
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(c.countdown.reason, 'idle')
  assert.equal(c.countdown.summary, 'all tests pass')
})

test('Controller: hook messages from before adapters still work, and their snapshot entries look as before', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet)
  t.after(() => c.shutdown())
  assert.equal(c.handle({ type: 'hook', sessionId: 'old', kind: 'activity', mode: 'plan', ts: Date.now() }).tracked, false)
  assert.equal(c.handle({ type: 'hook', sessionId: 'old', kind: 'activity', mode: 'autopilot', cwd: '/w/old', ts: Date.now() }).tracked, true)
  assert.deepEqual(c.snapshot().sessions, [{ sid: 'old', state: 'running', cwd: '/w/old' }])
  c.handle({ type: 'hook', sessionId: 'old', kind: 'activity', harness: 'copilot', autonomy: 'autonomous', ts: Date.now() })
  assert.deepEqual(c.snapshot().sessions, [{ sid: 'old', state: 'running', cwd: '/w/old', harness: 'copilot' }], 'the same session, now tagged')

  // The trigger config also decides for messages that only carry Copilot's mode.
  saveConfig({ trigger: { copilot: ['autopilot', 'plan'] } })
  t.after(() => saveConfig({ trigger: {} }))
  assert.equal(c.handle({ type: 'hook', sessionId: 'old2', kind: 'activity', mode: 'plan', ts: Date.now() }).tracked, true)
  c.handle({ type: 'hook', sessionId: 'old2', kind: 'stop', mode: 'interactive', ts: Date.now() })
  assert.equal(c.sessions.has('old2'), false, 'stop in a mode that does not count: retired')
})

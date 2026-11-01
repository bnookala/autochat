import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-harness-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const H = await import('../src/harness/index.js')
const E = await import('../src/harness/event.js')
const copilot = await import('../src/harness/copilot.js')

// The parent env minus anything pointing at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|TMUX|TMUX_PANE)$/.test(k)))
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

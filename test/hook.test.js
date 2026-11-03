import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './helpers/tmp.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = tmpDir()
const env = {
  ...process.env,
  COPILOT_HOME: path.join(tmp, 'copilot'),
  AUTOCHAT_HOME: path.join(tmp, 'lc'),
  AUTOCHAT_DEBUG: '1',
  AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'),
  TMUX: '', TMUX_PANE: ''
}
process.env.COPILOT_HOME = env.COPILOT_HOME
process.env.AUTOCHAT_HOME = env.AUTOCHAT_HOME

const writeSession = (sid, mode) => {
  const dir = path.join(env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'session.mode_changed', data: { newMode: mode } }) + '\n')
}

const hook = (event, payload, extraEnv = {}) => {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [BIN, 'hook', event], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, result: r.stderr ? JSON.parse(r.stderr.trim().split('\n').pop()) : null, ms: Date.now() - t0 }
}

test('hook never fails or prints, even on garbage input', () => {
  for (const input of ['', 'not json', '{"sessionId": "../../etc"}', '[]']) {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'preToolUse'], { input, env: { ...env, AUTOCHAT_DEBUG: '' }, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  }
})

test('with no core running, a hook does nothing and exits at once: no launch, spool or notification', () => {
  writeSession('s-auto', 'autopilot')
  // Keys from before always-on (AutoChat.app, tmux) are ignored, even with the app installed.
  const apps = path.join(tmp, 'apps')
  fs.mkdirSync(path.join(apps, 'AutoChat.app', 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(apps, 'AutoChat.app', 'Contents', 'Info.plist'), '<plist><string>com.bnookala.autochat</string></plist>')
  fs.mkdirSync(env.AUTOCHAT_HOME, { recursive: true })
  fs.writeFileSync(path.join(env.AUTOCHAT_HOME, 'config.json'), JSON.stringify({ launch: 'app', tmuxSplit: 'h', idleMs: 1000, countdownSeconds: 5, focus: 'always' }))
  const inTmux = { AUTOCHAT_APP_DIRS: apps, TMUX: '/x/tmux,1,0', TMUX_PANE: '%1' }
  for (const [event, payload] of [
    ['userPromptSubmitted', { sessionId: 's-auto', prompt: 'go' }],
    ['preToolUse', { sessionId: 's-auto', toolCalls: [{ name: 'bash', args: {} }] }],
    ['notification', { sessionId: 's-auto', notificationType: 'permission_prompt', title: 'Permission needed', message: 'go?' }],
    ['postToolUse', { sessionId: 's-auto', toolName: 'task_complete', toolArgs: { summary: 'done' } }]
  ]) {
    const r = hook(event, payload, inTmux)
    assert.deepEqual([r.code, r.stdout, r.result.action], [0, '', 'not-running'], event)
    assert.ok(r.ms < 2500, `${event}: ${r.ms} ms`)
  }
  // Copilot's mode cache is all it writes: no spool, launch lock, opt-out or notification stamp.
  assert.deepEqual(fs.readdirSync(env.AUTOCHAT_HOME).sort(), ['cache', 'config.json'])
  fs.rmSync(path.join(env.AUTOCHAT_HOME, 'config.json'))
})

test('hook delivers to a running UI and maps requests', async () => {
  const { serve } = await import('../src/ipc.js')
  fs.rmSync(path.join(env.AUTOCHAT_HOME, 'run'), { recursive: true, force: true })
  const got = []
  const server = await serve((m) => { got.push(m); return {} })
  try {
    const run = (event, payload) => new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const c = spawn(process.execPath, [BIN, 'hook', event], { env })
        c.stdin.end(JSON.stringify(payload))
        c.on('exit', resolve)
      })
    })
    // Payload shapes below are copied from a real Copilot CLI 1.0.97 autopilot session.
    await run('notification', { sessionId: 's-auto', notificationType: 'permission_prompt', title: 'Permission needed', message: 'Run \x1b[31mrm -rf build\x1b[0m?' })
    await run('preToolUse', { sessionId: 's-auto', cwd: '/w', toolCalls: [{ id: 't1', name: 'ask_user', args: { message: 'What is your favorite color?', requestedSchema: { properties: { favorite_color: { type: 'string', title: 'Favorite Color', enum: ['red', 'blue'] } } } } }] })
    await run('postToolUse', { sessionId: 's-auto', toolName: 'task_complete', toolArgs: { summary: 'All done' } })
    await run('notification', { sessionId: 's-auto', notification_type: 'shell_completed', message: 'x' })
    await run('preToolUse', { sessionId: 's-auto', toolCalls: [{ id: 't2', name: 'task_complete', args: { summary: 'x' } }] })
    const hooks = got.filter(m => m.type === 'hook')
    assert.equal(hooks.length, 5)
    assert.equal(hooks[0].kind, 'request')
    assert.equal(hooks[0].request.message, 'Run rm -rf build?', 'escape sequences stripped')
    assert.equal(hooks[0].mode, 'autopilot')
    assert.equal(hooks[1].kind, 'request')
    assert.equal(hooks[1].request.message, 'What is your favorite color? (Favorite Color: red / blue)')
    assert.equal(hooks[2].kind, 'complete')
    assert.equal(hooks[2].summary, 'All done')
    assert.equal(hooks[3].kind, 'notice')
    assert.equal(hooks[4].kind, 'activity', 'completion is only taken from postToolUse')
    // The doorbell rings on preToolUse, but never after task_complete, which ends the run.
    assert.deepEqual(got.filter(m => m.type === 'doorbell').map(m => [m.harness, m.sessionId]), [['copilot', 's-auto']])
    assert.equal(got.length, 6)
  } finally {
    server.close()
  }
})

test('appInstalled finds AutoChat.app by its bundle id', async () => {
  const { appInstalled, APP_BUNDLE_ID } = await import('../src/launcher.js')
  const apps = path.join(tmp, 'apps-check')
  const app = path.join(apps, 'AutoChat.app')
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  const e = { AUTOCHAT_APP_DIRS: path.join(tmp, 'nowhere') + path.delimiter + apps }
  assert.equal(appInstalled(e), null, 'a bundle without Info.plist is not the app')
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>')
  assert.equal(appInstalled(e), null, 'some other app named AutoChat.app')
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>${APP_BUNDLE_ID}</string></dict></plist>`)
  assert.equal(appInstalled(e), app)
})

test('setup writes fail-safe hooks for the right events', async () => {
  const { buildHooksConfig } = await import('../src/setup.js')
  const cfg = buildHooksConfig()
  assert.equal(cfg.version, 1)
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['agentStop', 'notification', 'postToolUse', 'preToolUse', 'sessionEnd', 'userPromptSubmitted'])
  assert.equal(cfg.hooks.preToolUse[0].matcher, undefined, 'preToolUse sees every tool: requests, and the doorbell')
  assert.equal(cfg.hooks.postToolUse[0].matcher, 'task_complete')
  for (const [, entries] of Object.entries(cfg.hooks)) assert.match(entries[0].bash, /\|\| true$/)
})

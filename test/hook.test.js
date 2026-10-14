import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lolchat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lolchat-hook-'))
const env = {
  ...process.env,
  COPILOT_HOME: path.join(tmp, 'copilot'),
  LOLCHAT_HOME: path.join(tmp, 'lc'),
  LOLCHAT_LAUNCH_RECORD: path.join(tmp, 'launches.jsonl'),
  LOLCHAT_DEBUG: '1',
  TMUX: '', TMUX_PANE: ''
}
process.env.COPILOT_HOME = env.COPILOT_HOME
process.env.LOLCHAT_HOME = env.LOLCHAT_HOME

const writeSession = (sid, mode) => {
  const dir = path.join(env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'session.mode_changed', data: { newMode: mode } }) + '\n')
}

const hook = (event, payload, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [BIN, 'hook', event], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, result: r.stderr ? JSON.parse(r.stderr.trim().split('\n').pop()) : null }
}

const launches = () => { try { return fs.readFileSync(env.LOLCHAT_LAUNCH_RECORD, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }

test('hook never fails or prints, even on garbage input', () => {
  for (const input of ['', 'not json', '{"sessionId": "../../etc"}', '[]']) {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'preToolUse'], { input, env: { ...env, LOLCHAT_DEBUG: '' }, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  }
})

test('hook launches the UI only for sessions in autopilot', () => {
  writeSession('s-interactive', 'interactive')
  writeSession('s-auto', 'autopilot')
  let r = hook('postToolUse', { sessionId: 's-interactive', toolName: 'bash', cwd: '/x' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.equal(r.result.action, 'ignored')
  assert.equal(launches().length, 0)

  r = hook('agentStop', { sessionId: 's-auto' })
  assert.equal(r.result.action, 'ignored', 'stop events never launch')

  r = hook('postToolUse', { sessionId: 's-auto', toolName: 'bash', cwd: '/x' })
  assert.equal(r.result.action, 'launched')
  assert.equal(r.stdout, '')
  const l = launches()
  assert.equal(l.length, 1)
  assert.ok(l[0].cmd.includes('ui') && l[0].cmd.includes('--auto'))

  // A second hook while the first launch is still pending waits instead of launching twice.
  r = hook('postToolUse', { sessionId: 's-auto', toolName: 'view' })
  assert.equal(r.result.action, 'dropped')
  assert.equal(launches().length, 1)
  const spool = fs.readdirSync(path.join(env.LOLCHAT_HOME, 'run')).filter(f => f.startsWith('spool-'))
  assert.equal(spool.length, 1)
})

test('hook picks tmux when inside tmux', () => {
  fs.rmSync(path.join(env.LOLCHAT_HOME, 'run'), { recursive: true, force: true })
  fs.rmSync(env.LOLCHAT_LAUNCH_RECORD, { force: true })
  const r = hook('userPromptSubmitted', { sessionId: 's-auto', prompt: 'go' }, { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3' })
  assert.equal(r.result.method, 'tmux')
})

test('hook delivers to a running UI and maps requests', async () => {
  const { serve } = await import('../src/ipc.js')
  fs.rmSync(path.join(env.LOLCHAT_HOME, 'run'), { recursive: true, force: true })
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
    await run('notification', { sessionId: 's-auto', notification_type: 'permission_prompt', title: 'Permission needed', message: 'Run \x1b[31mrm -rf build\x1b[0m?' })
    await run('preToolUse', { sessionId: 's-auto', toolName: 'ask_user', toolArgs: { message: 'Which DB?', requestedSchema: { properties: { db: { title: 'Database' } } } } })
    await run('postToolUse', { sessionId: 's-auto', toolName: 'task_complete', toolArgs: { summary: 'All done' } })
    await run('notification', { sessionId: 's-auto', notification_type: 'shell_completed', message: 'x' })
    assert.equal(got.length, 4)
    assert.equal(got[0].kind, 'request')
    assert.equal(got[0].request.message, 'Run rm -rf build?', 'escape sequences stripped')
    assert.equal(got[0].mode, 'autopilot')
    assert.equal(got[1].kind, 'request')
    assert.match(got[1].request.message, /Which DB\? \(Database\)/)
    assert.equal(got[2].kind, 'complete')
    assert.equal(got[2].summary, 'All done')
    assert.equal(got[3].kind, 'notice')
  } finally {
    server.close()
  }
})

test('setup writes fail-safe hooks for the right events', async () => {
  const { buildHooksConfig } = await import('../src/setup.js')
  const cfg = buildHooksConfig()
  assert.equal(cfg.version, 1)
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['agentStop', 'notification', 'postToolUse', 'preToolUse', 'sessionEnd', 'userPromptSubmitted'])
  assert.equal(cfg.hooks.preToolUse[0].matcher, 'ask_user')
  for (const [, entries] of Object.entries(cfg.hooks)) assert.match(entries[0].bash, /\|\| true$/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-scan-'))
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
process.env.AUTOCHAT_HOME = path.join(tmp, 'lc')
const { liveSessions, processStartMs } = await import('../src/scan.js')

const at = (type, data, ms) => JSON.stringify({ type, data, timestamp: new Date(ms).toISOString() }) + '\n'

function session (sid, pid, lines, cwd = '/w/' + sid) {
  const dir = path.join(process.env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join(''))
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${sid}\ncwd: ${cwd}\n`)
  if (pid) fs.writeFileSync(path.join(dir, `inuse.${pid}.lock`), String(pid))
  return dir
}

test('liveSessions finds running autopilot sessions without any hook having run', async (t) => {
  const child = spawn('sleep', ['30'])
  t.after(() => child.kill())
  const dead = 999999
  const now = Date.now()
  const auto = at('session.mode_changed', { newMode: 'autopilot' }, now - 60000)
  session('running', child.pid, [auto, at('session.task_complete', {}, now - 50000), at('user.message', {}, now - 3000), at('assistant.turn_start', {}, now - 2900)])
  session('finished', child.pid, [auto, at('user.message', {}, now - 9000), at('assistant.turn_end', {}, now - 8000), at('session.task_complete', {}, now - 7000)])
  session('interactive', child.pid, [at('session.mode_changed', { newMode: 'interactive' }, now - 9000), at('user.message', {}, now - 3000)])
  session('dead-process', dead, [auto, at('user.message', {}, now - 3000)])
  session('no-lock', null, [auto, at('user.message', {}, now - 3000)])
  const idleDir = session('idle', child.pid, [auto, at('user.message', {}, now - 120000), at('assistant.turn_start', {}, now - 119000), at('assistant.turn_end', {}, now - 100000)])
  fs.utimesSync(path.join(idleDir, 'events.jsonl'), new Date(now - 100000), new Date(now - 100000))

  const live = Object.fromEntries(liveSessions({ idleMs: 45000, now }).map(l => [l.sid, l]))
  assert.deepEqual(Object.keys(live).sort(), ['finished', 'idle', 'interactive', 'running'], 'only sessions with a live process')
  assert.equal(live.running.running, true)
  assert.equal(live.running.cwd, '/w/running')
  assert.equal(live.finished.running, false, 'task_complete after the last turn')
  assert.equal(live.interactive.running, false, 'not in autopilot')
  assert.equal(live.idle.running, false, 'turn ended and quiet for longer than idleMs')
})

test('processStartMs reports when a process started', { skip: process.platform === 'win32' }, () => {
  const started = processStartMs(process.pid)
  assert.ok(started && Math.abs(started - (Date.now() - process.uptime() * 1000)) < 3000)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lolchat-session-'))
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
process.env.LOLCHAT_HOME = path.join(tmp, 'lolchat')
const { quickMode, SessionLog, scanEvents, objectiveStatus } = await import('../src/session.js')

const sid = 'abc-123'
const dir = path.join(process.env.COPILOT_HOME, 'session-state', sid)
const file = path.join(dir, 'events.jsonl')
fs.mkdirSync(dir, { recursive: true })
const ev = (type, data = {}) => JSON.stringify({ type, data, id: 'x', timestamp: new Date().toISOString() }) + '\n'

test('quickMode tracks mode incrementally and skips huge lines', () => {
  assert.equal(quickMode('missing-session'), null)
  assert.equal(quickMode('../etc'), null)
  fs.writeFileSync(file, ev('session.start') + ev('model.messages_snapshot', { blob: 'x'.repeat(3 * 1024 * 1024) }))
  assert.equal(quickMode(sid), null)
  fs.appendFileSync(file, ev('session.mode_changed', { previousMode: 'interactive', newMode: 'autopilot' }))
  assert.equal(quickMode(sid), 'autopilot')
  // A partially-written line must not be consumed.
  const line = ev('session.mode_changed', { newMode: 'interactive' })
  fs.appendFileSync(file, line.slice(0, 30))
  assert.equal(quickMode(sid), 'autopilot')
  fs.appendFileSync(file, line.slice(30))
  assert.equal(quickMode(sid), 'interactive')
})

test('scanEvents handles lines spanning chunk boundaries', () => {
  const f = path.join(tmp, 'span.jsonl')
  fs.writeFileSync(f, ev('pad', { x: 'y'.repeat(1024 * 1024 - 60) }) + ev('session.mode_changed', { newMode: 'autopilot' }))
  const seen = []
  scanEvents(f, 0, (t) => t === 'session.mode_changed', (e) => seen.push(e.data.newMode))
  assert.deepEqual(seen, ['autopilot'])
})

test('SessionLog emits lifecycle events appended after start', async () => {
  fs.writeFileSync(file, ev('session.mode_changed', { newMode: 'autopilot' }) + ev('session.task_complete', { summary: 'old' }))
  const log = new SessionLog(sid, { pollMs: 20 }).start()
  assert.equal(log.mode, 'autopilot')
  const got = []
  log.on('task-complete', (x) => got.push(['done', x.summary]))
  log.on('activity', (t) => got.push(['activity', t]))
  log.on('mode', (m) => got.push(['mode', m]))
  log.on('abort', () => got.push(['abort']))
  fs.appendFileSync(file, ev('assistant.turn_start') + ev('session.task_complete', { summary: 'new' }) + ev('abort', { reason: 'user_initiated' }) + ev('session.mode_changed', { newMode: 'interactive' }))
  await new Promise(resolve => setTimeout(resolve, 120))
  log.stop()
  assert.deepEqual(got, [['activity', 'assistant.turn_start'], ['done', 'new'], ['abort'], ['mode', 'interactive']])
})

test('objectiveStatus reads autopilot-objective.json', () => {
  assert.equal(objectiveStatus(sid), null)
  fs.writeFileSync(path.join(dir, 'autopilot-objective.json'), JSON.stringify({ current: { status: 'active' } }))
  assert.equal(objectiveStatus(sid), 'active')
})

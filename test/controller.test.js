import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'

// These wait for a second peer to join over the Hyperswarm testnet, which on busy CI runners
// sometimes takes longer than the wait (#100). They still run locally.
const p2pJoinOnCI = process.env.CI ? 'flaky on CI runners: a peer join over the testnet (#100)' : false

process.env.AUTOCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-ctl-'))
process.env.COPILOT_HOME = path.join(process.env.AUTOCHAT_HOME, 'copilot')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')
const { loadConfig, saveConfig } = await import('../src/config.js')
const { Room } = await import('../src/room.js')
const { parseRoom } = await import('../src/protocol.js')

const FAST = { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000, helloMs: 2000 }

function waitFor (fn, ms = 15000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      let v
      try { v = fn() } catch {}
      if (v) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for ' + label))
      setTimeout(tick, 50)
    }
    tick()
  })
}

// A testnet for one test. When the test ends, pass or fail, its cores and rooms leave, and then
// it goes (a swarm left behind on a dead testnet takes seconds to close).
async function testnetFor (t) {
  const testnet = await createTestnet(3)
  testnet.cores = []
  testnet.rooms = []
  t.after(async () => {
    await Promise.allSettled([...testnet.cores.map(c => c.shutdown()), ...testnet.rooms.map(r => r.leave())])
    await testnet.destroy()
  })
  return testnet
}

const hook = (sessionId, kind, extra = {}) => ({ type: 'hook', sessionId, kind, mode: 'autopilot', cwd: '/w/' + sessionId, ts: Date.now(), origin: { tmuxPane: '%' + sessionId }, ...extra })
const code = (words) => `lc1-${words}-${Math.random().toString(36).slice(2, 12)}`

function mk (testnet, room, opts = {}) {
  const focused = []
  const notes = []
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room, announce: false },
    bootstrap: testnet?.bootstrap,
    roomOpts: FAST,
    focus: (o) => focused.push(o),
    notify: (title, text) => notes.push(text),
    requestLingerMs: 500,
    idleMs: 400,
    watchLogs: false,
    ...opts
  })
  c.focused = focused
  c.notes = notes
  testnet?.cores.push(c)
  return c
}

test('the core joins the lounge at start and stays: chat, and hook events never change the phase', { skip: p2pJoinOnCI, timeout: 90000 }, async (t) => {
  const testnet = await testnetFor(t)
  const room = code('ctl-test')
  const host = mk(testnet, room)
  const guest = mk(testnet, room)
  assert.equal(host.phase, 'lounge', 'nothing before start()')

  host.start()
  assert.equal(host.phase, 'room')
  assert.equal(host.room.status, 'active')
  await waitFor(() => host.room.isHost, 10000, 'host owns the room')
  assert.match(host.messages.at(-1).text, /^you're the host/)
  guest.start()
  await waitFor(() => guest.room.hostHandle === host.identity.handle && host.room.members.size === 1, 20000, 'guest joins host room')
  assert.ok(host.messages.some(m => m.kind === 'sys' && m.text === `${guest.identity.handle} joined`))

  assert.equal(guest.say('hi from the guest'), true)
  await waitFor(() => host.messages.some(m => m.kind === 'chat' && m.text === 'hi from the guest'), 5000, 'chat delivered')
  const snap = host.snapshot()
  assert.deepEqual([snap.phase, snap.lounge, snap.countdown, snap.banner], ['room', 'on', null, null])
  assert.deepEqual(snap.members.map(m => [m.handle, m.status, m.you]), [[host.identity.handle, 'active', true], [guest.identity.handle, 'active', false]])

  // Agents come and go; you stay where you are, always active.
  guest.handle(hook('g1', 'activity'))
  guest.handle(hook('g1', 'request', { request: { title: 'Permission needed', message: 'run tests?' } }))
  assert.equal(guest.currentRequest().message, 'run tests?')
  assert.deepEqual(guest.snapshot().attention.map(a => [a.kind, a.sid]), [['blocked', 'g1']])
  guest.handle(hook('g1', 'activity'))
  assert.equal(guest.currentRequest().resolved, true, 'auto-answered request lingers so it can be read')
  await waitFor(() => guest.currentRequest() === null, 3000, 'lingering request clears')
  guest.handle(hook('g1', 'complete', { summary: 'done' }))
  assert.deepEqual([guest.phase, guest.room.status, guest.sessions.size], ['room', 'active', 0])
  assert.deepEqual(guest.snapshot().attention.map(a => [a.kind, a.summary]), [['finished', 'done']])
  assert.deepEqual(guest.focused, [], 'focus stays put')
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal([...host.room.members.values()][0].status, 'active', 'never needed or away')

  // A peer on an older version still says needed while its copilot asks it something.
  const old = new Room({ room: parseRoom(room), identity: ephemeralIdentity(), bootstrap: testnet.bootstrap, status: 'needed', ...FAST })
  testnet.rooms.push(old)
  await old.join()
  await waitFor(() => host.snapshot().members.some(m => m.handle === old.identity.handle && m.needed), 20000, 'an older peer, needed')
})

test('lounge off leaves and on joins again, saved to config.json; leaveRoom turns it off; returnNow and joinNow are gone', { timeout: 60000 }, async (t) => {
  const testnet = await testnetFor(t)
  saveConfig({ room: code('ctl-lounge'), lounge: 'on' })
  const c = mk(testnet, loadConfig().room, { config: loadConfig(), loadConfig, saveConfig })
  c.start()
  const first = c.room
  assert.equal(c.phase, 'room')

  await c.command({ cmd: 'lounge', on: false })
  assert.deepEqual([c.phase, c.lounge, c.snapshot().lounge, c.room], ['lounge', 'off', 'off', null])
  assert.equal(first.left, true, 'it left the room')
  assert.equal(loadConfig().lounge, 'off')
  assert.equal(c.say('anyone?'), false)
  await assert.rejects(c.command({ cmd: 'say', text: 'anyone?' }), /not in a room/)
  await c.command({ cmd: 'lounge', on: false })
  assert.equal(c.phase, 'lounge', 'already off: nothing to do')

  await c.command({ cmd: 'lounge', on: true })
  assert.deepEqual([c.phase, c.snapshot().lounge, loadConfig().lounge], ['room', 'on', 'on'])
  assert.notEqual(c.room, first, 'a new room')
  await waitFor(() => c.room.swarm, 5000, 'joins once the old room has left')

  await c.command({ cmd: 'leaveRoom' })
  assert.deepEqual([c.phase, loadConfig().lounge], ['lounge', 'off'], 'leaveRoom: the lounge is off until you turn it on')
  await assert.rejects(c.command({ cmd: 'returnNow' }), /unknown command/)
  await assert.rejects(c.command({ cmd: 'joinNow' }), /unknown command/)
  await assert.rejects(c.command({ cmd: 'lounge', on: 'yes' }), /on must be true or false/)
  assert.equal(c.phase, 'lounge')

  // With the lounge off, the core starts outside the room; hooks still feed the attention queue.
  const d = mk(testnet, loadConfig().room, { config: loadConfig(), loadConfig, saveConfig })
  d.start()
  assert.equal(d.phase, 'lounge')
  d.handle(hook('o1', 'activity'))
  d.handle(hook('o1', 'complete', { summary: 'ok' }))
  assert.deepEqual(d.snapshot().attention.map(a => [a.kind, a.sid]), [['finished', 'o1']])
  assert.equal(d.phase, 'lounge')
  saveConfig({ lounge: 'on' })
})

test('autochat join/host/leave while the core runs: reload leaves the old room, then joins the new one, right away', { skip: p2pJoinOnCI, timeout: 60000 }, async (t) => {
  const testnet = await testnetFor(t)
  const [first, second, third] = [code('ctl-first'), code('ctl-second'), code('ctl-third')]
  saveConfig({ room: first, lounge: 'on' })
  const c = mk(testnet, first, { config: loadConfig(), loadConfig, saveConfig })
  c.start()
  assert.equal(c.snapshot().room.display, 'private:ctl-first')
  const old = c.room
  assert.deepEqual(c.handle({ type: 'reload' }), { reloaded: true, room: 'private:ctl-first' })
  assert.equal(c.room, old, 'the same room: nothing to do')

  // `autochat join`: the old room goes first, then the core joins the new one.
  const peer = new Room({ room: parseRoom(second), identity: ephemeralIdentity(), bootstrap: testnet.bootstrap, ...FAST })
  testnet.rooms.push(peer)
  await peer.join()
  saveConfig({ room: second })
  assert.deepEqual(c.handle({ type: 'reload' }), { reloaded: true, room: 'private:ctl-second' })
  assert.equal(old.left, true)
  assert.equal(c.room.room.code, second)
  assert.equal(c.room.swarm, null, 'not joined while the old room is still leaving')
  assert.match(c.messages.at(-1).text, /^entering private:ctl-second/)
  await waitFor(() => [...c.room.members.values()].some(m => m.from === peer.me), 20000, 'a peer in the new room')
  assert.equal(c.snapshot().room.display, 'private:ctl-second')

  // `autochat config lounge off`, then on in another room.
  saveConfig({ lounge: 'off' })
  assert.deepEqual(c.handle({ type: 'reload' }), { reloaded: true, room: 'private:ctl-second' })
  assert.equal(c.phase, 'lounge')
  await waitFor(() => peer.members.size === 0, 10000, 'the peer sees it leave')
  saveConfig({ room: third, lounge: 'on' })
  c.handle({ type: 'reload' })
  assert.equal(c.room.room.code, third)
  assert.equal(c.snapshot().room.display, 'private:ctl-third')
})

test('adopts unhooked autopilot sessions from the session scan, without flip-flopping', () => {
  const c = mk(null, code('ctl-adopt'))
  const now = Date.now()
  const live = (over = {}) => [{ sid: 'u1', pid: 1, mode: 'autopilot', cwd: '/w/u1', running: true, lastStart: now - 1000, scannedAt: now, ...over }]

  c.adopt(live({ running: false }))
  assert.equal(c.sessions.size, 0, 'idle sessions are not adopted')
  c.adopt(live())
  assert.equal(c.sessions.get('u1').adopted, true)
  assert.equal(c.sessions.get('u1').state, 'running')

  c.adopt(live({ running: false }))
  assert.equal(c.sessions.size, 0, 'released once the scan says it stopped')
  assert.deepEqual(c.snapshot().attention.map(a => [a.sid, a.title]), [['u1', 'Copilot CLI is waiting for you']])
  c.adopt(live())
  assert.equal(c.sessions.size, 0, 'no re-adoption without new activity')
  c.adopt(live({ lastStart: Date.now() + 1 }))
  assert.equal(c.sessions.get('u1').state, 'running', 'new user message → tracked again')

  c.adopt([])
  assert.equal(c.sessions.size, 0, 'process exited')

  // Hooks win: a hooked session isn't released by the scanner.
  c.handle(hook('h9', 'activity'))
  c.adopt([{ sid: 'h9', mode: 'autopilot', running: false, lastStart: 0, scannedAt: Date.now() }])
  assert.equal(c.sessions.get('h9').state, 'running')
  assert.equal(c.phase, 'lounge', 'sessions never move you in or out of a room')
})

test('late non-autopilot requests and log-only completions end the session', () => {
  const c = mk(null, code('ctl-late'))
  c.handle(hook('r1', 'activity'))
  assert.equal(c.sessions.get('r1').state, 'running')
  c.handle(hook('r1', 'request', { mode: 'interactive', request: { title: 'x', message: 'y' } }))
  assert.equal(c.sessions.size, 0, 'finished sessions are retired')
  assert.deepEqual(c.snapshot().attention, [], 'switched out of autopilot: you took over')
  assert.equal(c.handle(hook('x', 'activity', { mode: 'interactive' })).tracked, false, 'sessions you take turns with are ignored')
})

test('completion logged before the core tracked the session is not missed', () => {
  const sid = 'race-' + Math.random().toString(36).slice(2, 8)
  const dir = path.join(process.env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  const trigger = Date.now() - 2000
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ type: 'session.mode_changed', data: { newMode: 'autopilot' }, timestamp: new Date(trigger - 1000).toISOString() }) + '\n' +
    JSON.stringify({ type: 'session.task_complete', data: { summary: 'raced' }, timestamp: new Date(trigger + 500).toISOString() }) + '\n')
  const c = mk(null, code('ctl-race'), { watchLogs: true })
  c.handle({ ...hook(sid, 'activity'), ts: trigger })
  assert.equal(c.sessions.size, 0)
  assert.deepEqual(c.snapshot().attention.map(a => [a.kind, a.summary]), [['finished', 'raced']])
  return c.shutdown()
})

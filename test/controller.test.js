import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'

process.env.AUTOCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-ctl-'))
process.env.COPILOT_HOME = path.join(process.env.AUTOCHAT_HOME, 'copilot')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')

const FAST = { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 }

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

const hook = (sessionId, kind, extra = {}) => ({ type: 'hook', sessionId, kind, mode: 'autopilot', cwd: '/w/' + sessionId, ts: Date.now(), origin: { tmuxPane: '%' + sessionId }, ...extra })

// countdownSeconds: 0 keeps the original "pulled back immediately" behavior.
function mk (testnet, room, auto = true, config = {}) {
  const focused = []
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room, idleMs: 400, announce: false, countdownSeconds: 0, ...config },
    auto,
    bootstrap: testnet.bootstrap,
    roomOpts: FAST,
    focus: (o) => focused.push(o),
    notify: () => {},
    bannerMs: 300,
    requestLingerMs: 500,
    watchLogs: false
  })
  c.focused = focused
  c.exited = false
  c.on('exit', () => { c.exited = true })
  return c
}

test('autopilot drives room membership, requests, pull-back, spectating and death', { timeout: 90000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const room = 'lc1-ctl-test-' + Math.random().toString(36).slice(2, 12)
  const host = mk(testnet, room)
  const guest = mk(testnet, room)
  t.after(() => Promise.all([host.shutdown(), guest.shutdown()]))

  // Non-autopilot sessions are ignored entirely.
  assert.equal(host.handle(hook('x', 'activity', { mode: 'interactive' })).tracked, false)
  assert.equal(host.phase, 'lounge')

  host.handle(hook('h1', 'activity'))
  assert.equal(host.phase, 'room')
  await waitFor(() => host.room.isHost, 10000, 'host owns the room')

  guest.handle(hook('g1', 'activity'))
  await waitFor(() => guest.room?.hostHandle === host.identity.handle && host.room.members.size === 1, 20000, 'guest joins host room')

  // The model asks the guest something: modal + "needed" visible to others.
  guest.handle(hook('g1', 'request', { request: { title: 'Permission needed', message: 'run tests?' } }))
  assert.equal(guest.currentRequest().message, 'run tests?')
  await waitFor(() => [...host.room.members.values()][0]?.status === 'needed', 5000, 'needed visible')
  guest.handle(hook('g1', 'activity'))
  assert.equal(guest.currentRequest().resolved, true, 'auto-answered request lingers so it can be read')
  await waitFor(() => guest.currentRequest() === null, 3000, 'lingering request clears')

  // Host's autopilot finishes: host is pulled back to reality but keeps watching.
  host.handle(hook('h1', 'complete', { summary: 'done' }))
  assert.equal(host.phase, 'spectating')
  assert.deepEqual(host.focused.at(-1), { tmuxPane: '%h1' }, 'focus returns to the copilot pane')
  assert.equal(host.say('hi'), false, 'spectators are read-only')
  await waitFor(() => [...guest.room.members.values()][0]?.status === 'away', 5000, 'guest sees host away')
  assert.equal(guest.phase, 'room', 'room survives the host leaving')

  // Guest stops without task_complete: idle timeout pulls them back; room dies.
  guest.handle(hook('g1', 'stop'))
  await waitFor(() => guest.phase === 'reality', 5000, 'guest pulled back after idle')
  assert.equal(guest.banner.reason, 'idle')
  await waitFor(() => host.phase === 'dead', 8000, 'room dies for the spectating host')
  await waitFor(() => host.exited && guest.exited, 5000, 'auto-launched UIs exit after the banner')
})

test('ctrl-c leave opts the session out; a new session brings you back', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet, 'lc1-ctl-optout-' + Math.random().toString(36).slice(2, 12), false)
  t.after(() => c.shutdown())
  c.handle(hook('a1', 'activity'))
  assert.equal(c.phase, 'room')
  await c.leaveRoom()
  assert.equal(c.phase, 'left')
  c.handle(hook('a1', 'activity'))
  assert.equal(c.phase, 'left', 'opted-out session does not pull you back in')
  await waitFor(() => c.phase === 'lounge', 3000, 'manual UI returns to the lounge')
  c.handle(hook('a2', 'activity'))
  assert.equal(c.phase, 'room')
})

test('adopts unhooked autopilot sessions from the session scan, without flip-flopping', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet, 'lc1-ctl-adopt-' + Math.random().toString(36).slice(2, 12), false)
  t.after(() => c.shutdown())
  const now = Date.now()
  const live = (over = {}) => [{ sid: 'u1', pid: 1, mode: 'autopilot', cwd: '/w/u1', running: true, lastStart: now - 1000, scannedAt: now, ...over }]

  c.adopt(live({ running: false }))
  assert.equal(c.phase, 'lounge', 'idle sessions are not adopted')
  c.adopt(live())
  assert.equal(c.phase, 'room')
  assert.equal(c.sessions.get('u1').adopted, true)

  c.adopt(live({ running: false }))
  assert.equal(c.phase, 'reality', 'released once the scan says it stopped')
  await waitFor(() => c.phase === 'lounge', 3000, 'back to lounge')
  c.adopt(live())
  assert.equal(c.phase, 'lounge', 'no re-adoption without new activity')
  c.adopt(live({ lastStart: Date.now() + 1 }))
  assert.equal(c.phase, 'room', 'new user message → back in')

  c.adopt([])
  assert.equal(c.phase, 'reality', 'process exited')

  // Hooks win: a hooked session isn't released by the scanner.
  await waitFor(() => c.phase === 'lounge', 3000, 'lounge again')
  c.handle(hook('h9', 'activity'))
  c.adopt([{ sid: 'h9', mode: 'autopilot', running: false, lastStart: 0, scannedAt: Date.now() }])
  assert.equal(c.phase, 'room')
})

test('late non-autopilot requests and log-only completions pull you out', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet, 'lc1-ctl-late-' + Math.random().toString(36).slice(2, 12))
  t.after(() => c.shutdown())
  c.handle(hook('r1', 'activity'))
  assert.equal(c.phase, 'room')
  c.handle(hook('r1', 'request', { mode: 'interactive', request: { title: 'x', message: 'y' } }))
  assert.equal(c.phase, 'reality', 'request after autopilot ended does not keep you in')
  assert.equal(c.sessions.size, 0, 'finished sessions are retired')
})

test('completion logged before the UI tracked the session is not missed', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const sid = 'race-' + Math.random().toString(36).slice(2, 8)
  const dir = path.join(process.env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  const trigger = Date.now() - 2000
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ type: 'session.mode_changed', data: { newMode: 'autopilot' }, timestamp: new Date(trigger - 1000).toISOString() }) + '\n' +
    JSON.stringify({ type: 'session.task_complete', data: { summary: 'raced' }, timestamp: new Date(trigger + 500).toISOString() }) + '\n')
  const c = new Controller({ identity: ephemeralIdentity(), config: { room: 'lc1-ctl-race-' + sid, idleMs: 400, announce: false, countdownSeconds: 0 }, auto: true, bootstrap: testnet.bootstrap, roomOpts: FAST, focus: () => {}, notify: () => {}, bannerMs: 300 })
  t.after(() => c.shutdown())
  c.handle({ ...hook(sid, 'activity'), ts: trigger })
  assert.equal(c.phase, 'reality')
  assert.equal(c.banner.summary, 'raced')
})

test('exit countdown: you stay in the room and keep chatting; new autopilot cancels it; returnNow skips it', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet, 'lc1-ctl-count-' + Math.random().toString(36).slice(2, 12), true, { countdownSeconds: 30 })
  t.after(() => c.shutdown())
  assert.equal(c.countdownMs, 30000)
  c.handle(hook('c1', 'activity'))
  c.handle(hook('c1', 'request', { request: { title: 'Permission needed', message: 'go?' } }))
  assert.equal(c.room.status, 'needed')

  c.handle(hook('c1', 'complete', { summary: 'shipped it' }))
  assert.equal(c.phase, 'room', 'not pulled back yet')
  assert.equal(c.countdown.total, 30)
  assert.equal(c.countdown.reason, 'complete')
  assert.equal(c.countdown.summary, 'shipped it')
  assert.equal(c.countdown.cwd, '/w/c1')
  assert.ok(Math.abs(c.countdown.endsAt - Date.now() - 30000) < 1000)
  assert.equal(c.room.status, 'active', 'still counts as active in the room')
  assert.equal(c.focused.length, 0, 'focus stays put while counting down')
  const snap = c.snapshot().countdown
  assert.deepEqual(Object.keys(snap).sort(), ['cwd', 'endsAt', 'reason', 'remaining', 'summary', 'total'])
  assert.equal(snap.remaining, 30)

  assert.equal(c.say('one sec, finishing my thought'), true, 'chat works during the countdown')
  assert.equal(c.messages.at(-1).text, 'one sec, finishing my thought')
  await c.command({ cmd: 'say', text: 'and another' })

  // Another session goes autopilot: cancel and stay.
  c.handle(hook('c2', 'activity'))
  assert.equal(c.countdown, null)
  assert.equal(c.phase, 'room')
  assert.match(c.messages.at(-1).text, /back on autopilot/)

  c.handle(hook('c2', 'complete', { summary: 'second' }))
  assert.equal(c.countdown.summary, 'second')
  await c.command({ cmd: 'returnNow' })
  assert.equal(c.countdown, null)
  assert.equal(c.phase, 'reality', 'returnNow is the existing pull-back')
  assert.deepEqual(c.focused.at(-1), { tmuxPane: '%c2' })
  assert.equal(c.banner.summary, 'second')
  assert.equal(c.returnNow(), false)
  await assert.rejects(c.command({ cmd: 'returnNow' }), /no countdown running/)
  await waitFor(() => c.exited, 3000, 'auto UI exits after the banner')
})

test('countdown ticks every second, keeps the room alive for others, and expires into the pull-back', { timeout: 90000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const room = 'lc1-ctl-tick-' + Math.random().toString(36).slice(2, 12)
  const host = mk(testnet, room)
  process.env.AUTOCHAT_COUNTDOWN_MS = '2500'
  const guest = mk(testnet, room, true, { countdownSeconds: 30 })
  delete process.env.AUTOCHAT_COUNTDOWN_MS
  t.after(() => Promise.all([host.shutdown(), guest.shutdown()]))
  assert.equal(guest.countdownMs, 2500, 'AUTOCHAT_COUNTDOWN_MS overrides the config')

  host.handle(hook('h1', 'activity'))
  await waitFor(() => host.room.isHost, 10000, 'host owns the room')
  guest.handle(hook('g1', 'activity'))
  await waitFor(() => guest.room?.hostHandle === host.identity.handle && host.room.members.size === 1, 20000, 'guest joins')

  // The guest finishes and counts down: the host still sees them on autopilot.
  const ticks = []
  guest.on('change', () => { if (guest.countdown) ticks.push(guest.countdownRemaining()) })
  guest.handle(hook('g1', 'complete', { summary: 'guest done' }))
  assert.equal(guest.phase, 'room')
  assert.equal(guest.countdown.total, 2.5)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal([...host.room.members.values()][0].status, 'active', 'the counting-down guest still counts as active')
  await waitFor(() => guest.phase === 'reality', 5000, 'countdown expires')
  assert.ok(ticks.includes(2) && ticks.includes(1), 'a change every second: ' + ticks.join(','))
  assert.equal(guest.countdown, null)
  assert.equal(guest.banner.summary, 'guest done')
  assert.deepEqual(guest.focused.at(-1), { tmuxPane: '%g1' })
  await waitFor(() => host.room.members.size === 0, 5000, 'host sees the guest leave')
  assert.equal(host.phase, 'room')
})

test('leaving during the countdown behaves like ctrl-c always did', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet, 'lc1-ctl-cleave-' + Math.random().toString(36).slice(2, 12), false, { countdownSeconds: 30 })
  t.after(() => c.shutdown())
  c.handle(hook('l1', 'activity'))
  c.handle(hook('l1', 'end'))
  assert.equal(c.countdown.reason, 'end')
  await c.command({ cmd: 'leaveRoom' })
  assert.equal(c.phase, 'left')
  assert.equal(c.countdown, null)
  assert.equal(c.focused.length, 0)
  await waitFor(() => c.phase === 'lounge', 3000, 'back to the lounge')
})

test('autochat join/host/leave while the core runs: the room is re-read on entering one, never under an open room', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const { saveConfig, loadConfig } = await import('../src/config.js')
  const { Room } = await import('../src/room.js')
  const { parseRoom } = await import('../src/protocol.js')
  const code = (words) => `lc1-${words}-${Math.random().toString(36).slice(2, 12)}`
  const [first, second, third, fourth] = [code('ctl-first'), code('ctl-second'), code('ctl-third'), code('ctl-fourth')]
  saveConfig({ room: first })
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { ...loadConfig(), idleMs: 400, announce: false, countdownSeconds: 0 },
    loadConfig,
    bootstrap: testnet.bootstrap,
    roomOpts: FAST,
    focus: () => {},
    notify: () => {},
    bannerMs: 300,
    watchLogs: false
  })
  t.after(() => c.shutdown())
  assert.equal(c.snapshot().room.display, 'private:ctl-first')

  // `autochat join` in the lounge, then autopilot: the core enters the new room.
  saveConfig({ room: second })
  c.handle(hook('j1', 'activity'))
  assert.equal(c.phase, 'room')
  assert.equal(c.room.room.code, second)
  assert.equal(c.snapshot().room.display, 'private:ctl-second')
  const peer = new Room({ room: parseRoom(second), identity: ephemeralIdentity(), bootstrap: testnet.bootstrap, ...FAST })
  t.after(() => peer.leave())
  await peer.join()
  await waitFor(() => [...c.room.members.values()].some(m => m.from === peer.me), 20000, 'a peer in the new room')

  // A reload while the room is open changes nothing until the next room.
  saveConfig({ room: third })
  assert.deepEqual(c.handle({ type: 'reload' }), { reloaded: false, room: 'private:ctl-second' })
  assert.equal(c.room.room.code, second)
  assert.equal(c.snapshot().room.display, 'private:ctl-second')

  // Back in the lounge it shows the configured room; a reload there applies at once.
  await c.leaveRoom()
  await waitFor(() => c.phase === 'lounge', 3000, 'back to the lounge')
  assert.equal(c.snapshot().room.display, 'private:ctl-third')
  saveConfig({ room: fourth })
  assert.deepEqual(c.handle({ type: 'reload' }), { reloaded: true, room: 'private:ctl-fourth' })
  assert.equal(c.snapshot().room.display, 'private:ctl-fourth')
  c.handle(hook('j2', 'activity'))
  assert.equal(c.room.room.code, fourth)
})

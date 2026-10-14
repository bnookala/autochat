import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'

process.env.LOLCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lolchat-ctl-'))
process.env.COPILOT_HOME = path.join(process.env.LOLCHAT_HOME, 'copilot')
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

function mk (testnet, room, auto = true) {
  const focused = []
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room, idleMs: 400, announce: false },
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

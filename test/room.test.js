import { test } from 'node:test'
import assert from 'node:assert/strict'
import createTestnet from 'hyperdht/testnet.js'
import { Room, olderInst } from '../src/room.js'
import { parseRoom } from '../src/protocol.js'
import { ephemeralIdentity } from '../src/identity.js'

const FAST = { graceMs: 1500, heartbeatMs: 400, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 }

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

const mk = (testnet, room, extra = {}) => {
  const r = new Room({ room, identity: ephemeralIdentity(), bootstrap: testnet.bootstrap, ...FAST, ...extra })
  r.chats = []
  r.on('chat', (m) => r.chats.push(m))
  r.died = false
  r.on('dead', () => { r.died = true })
  return r
}

const statusOf = (room, other) => room.members.get(other.key)?.status

test('olderInst prefers earlier createdAt then lower iid', () => {
  assert.equal(olderInst({ createdAt: 1, iid: 'b' }, { createdAt: 2, iid: 'a' }), true)
  assert.equal(olderInst({ createdAt: 2, iid: 'a' }, { createdAt: 2, iid: 'b' }), true)
  assert.equal(olderInst({ createdAt: 3, iid: 'a' }, { createdAt: 2, iid: 'b' }), false)
})

test('room lifecycle: host spectates, room survives, dies with last active member', { timeout: 90000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const room = parseRoom('lc1-test-room-' + Math.random().toString(36).slice(2, 12))

  const host = mk(testnet, room)
  await host.join()
  await waitFor(() => host.inst, 10000, 'host creates instance')
  assert.equal(host.isHost, true)

  const b = mk(testnet, room)
  await b.join()
  await waitFor(() => statusOf(host, b) === 'active' && statusOf(b, host) === 'active', 20000, 'host and b see each other')
  await waitFor(() => b.inst, 5000, 'b adopts instance')
  assert.equal(b.inst.iid, host.inst.iid, 'joiner adopts the existing instance')
  assert.equal(b.isHost, false)
  assert.equal(b.hostHandle, host.identity.handle)

  assert.equal(host.say('hello from host'), true)
  await waitFor(() => b.chats.some(m => m.text === 'hello from host'), 5000, 'chat delivered')

  // Host gets pulled back to reality: becomes a spectator; room stays alive.
  host.setStatus('away')
  await waitFor(() => statusOf(b, host) === 'away', 5000, 'b sees host away')
  assert.equal(host.died, false)
  assert.equal(host.say('spectators cannot talk'), false)
  b.say('still here')
  await waitFor(() => host.chats.some(m => m.text === 'still here'), 5000, 'spectator still sees chat')

  // A third person arrives later and joins the same live instance.
  const c = mk(testnet, room)
  await c.join()
  await waitFor(() => c.inst && c.inst.iid === host.inst.iid && statusOf(c, b) === 'active', 20000, 'c joins same instance')
  assert.equal(c.hostHandle, host.identity.handle)

  // Status "needed" (copilot asking a question) still counts as in the room.
  c.setStatus('needed')
  await waitFor(() => statusOf(host, c) === 'needed', 5000, 'needed propagates')

  await b.leave('pulled-back')
  await waitFor(() => !host.members.has(b.key), 5000, 'b gone')
  assert.equal(host.died, false, 'room alive while c is active')

  await c.leave('pulled-back')
  await waitFor(() => host.died, 5000, 'room dies when last active member leaves')

  await host.leave('dead')
})

test('lone host being pulled back kills the room immediately', { timeout: 30000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const room = parseRoom('solo-' + Math.random().toString(36).slice(2, 10))
  const host = mk(testnet, room, { announce: false })
  await host.join()
  await waitFor(() => host.inst, 10000, 'instance')
  host.setStatus('away')
  assert.equal(host.died, true)
  await host.leave('dead')
})

test('simultaneous joiners converge on a single instance', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const room = parseRoom('lc1-race-room-' + Math.random().toString(36).slice(2, 12))
  const a = mk(testnet, room, { graceMs: 50 })
  const b = mk(testnet, room, { graceMs: 50 })
  await Promise.all([a.join(), b.join()])
  await waitFor(() => a.inst && b.inst && statusOf(a, b) && statusOf(b, a), 20000, 'both connected')
  await waitFor(() => a.inst.iid === b.inst.iid, 5000, 'converged')
  assert.equal(a.isHost !== b.isHost, true, 'exactly one host')
  await Promise.all([a.leave(), b.leave()])
})

test('forged and tampered messages are ignored', async () => {
  const { seal, open } = await import('../src/protocol.js')
  const id = ephemeralIdentity()
  const line = seal(id, { t: 'chat', from: id.publicKey, text: 'hi' })
  assert.equal(open(JSON.parse(line)).text, 'hi')
  const obj = JSON.parse(line)
  obj.p = obj.p.replace('hi', 'yo')
  assert.equal(open(obj), null)
  const other = ephemeralIdentity()
  const forged = JSON.parse(seal(other, { t: 'chat', from: id.publicKey, text: 'i am you' }))
  assert.equal(open(forged), null)
})

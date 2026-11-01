// Lounge rooms: the host hands off when leaving, or its successor takes over after a timeout.
import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'

process.env.AUTOCHAT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-succession-'))
process.env.COPILOT_HOME = path.join(process.env.AUTOCHAT_HOME, 'copilot')
const { Room, betterSuccession } = await import('../src/room.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')
const {
  parseRoom, roomTagFor, randomId, seal, open, signInst, verifyInst, MAX_LINE,
  MAX_SUCCESSION, hostOf, signHandoff, signTimeout, verifySuccession
} = await import('../src/protocol.js')

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

// An autochat (or lolchat) from before host succession: its state has no `since` or
// `succession`, it ignores both when they arrive, and it never hands off or claims the room.
class OldRoom extends Room {
  get hostId () { return this.inst ? this.inst.hostId : null }
  _stateBody () {
    const { since, succession, ...body } = super._stateBody()
    return body
  }

  _considerSuccession () {}
  _checkSuccession () {}
  _handOff () {}
}

const mk = (testnet, room, Kind = Room) => {
  const r = new Kind({ room, identity: ephemeralIdentity(), bootstrap: testnet.bootstrap, ...FAST })
  r.hosts = []
  r.on('host', (h) => r.hosts.push(h))
  r.chats = []
  r.on('chat', (m) => r.chats.push(m.text))
  return r
}

const privateRoom = () => parseRoom('lc1-succession-test-' + Math.random().toString(36).slice(2, 12))
const knows = (a, b) => [...a.members.values()].some(m => m.from === b.me && m.iid === a.inst?.iid && (m.since !== null || b instanceof OldRoom))
const direct = (a, b) => [...a.conns].some(c => c.mate && c.remoteKey === b.key)

// Everyone knows everyone in the same instance, `since` included.
const settled = (rooms) => rooms.every(a => a.inst && a.inst.iid === rooms[0].inst?.iid && rooms.every(b => a === b || knows(a, b)))

async function joinAll (rooms) {
  for (const r of rooms) {
    await r.join()
    if (r === rooms[0]) await waitFor(() => r.inst, 10000, 'the first peer creates the instance')
    // One at a time, so the join order (and with it `since`) is known.
    await waitFor(() => settled(rooms.slice(0, rooms.indexOf(r) + 1)), 20000, 'peers settle')
  }
}

// Gone without a word: no handoff, no bye (kill -9, a crash, a dropped network).
async function crash (r) {
  r.left = true
  for (const t of r.timers) { clearTimeout(t); clearInterval(t) }
  r.timers = []
  await r.swarm.destroy()
}

test('succession chains: forged handoffs, broken epochs, other rooms and over-long chains are rejected', () => {
  const tag = roomTagFor(parseRoom('lc1-aaaa-bbbb-cccccccc'))
  const ids = Array.from({ length: MAX_SUCCESSION + 2 }, () => ephemeralIdentity())
  const [a, b, c] = ids
  const t = Date.now()
  const inst = signInst(a, tag, { iid: randomId(8), createdAt: t - 1000, hostId: a.publicKey })
  const e1 = signHandoff(a, tag, inst, [], b.publicKey, t)
  const e2 = signHandoff(b, tag, inst, [e1], c.publicKey, t + 1)
  assert.equal(verifySuccession(tag, inst, []), true)
  assert.equal(verifySuccession(tag, inst, [e1, e2]), true)
  assert.equal(hostOf(inst, []), a.publicKey)
  assert.equal(hostOf(inst, [e1, e2]), c.publicKey)

  // Only the current host can hand off.
  assert.equal(verifySuccession(tag, inst, [signHandoff(b, tag, inst, [], c.publicKey, t)]), false, 'signed by a non-host')
  assert.equal(verifySuccession(tag, inst, [{ ...signHandoff(b, tag, inst, [], c.publicKey, t), by: a.publicKey }]), false, 'forged in the host\'s name')
  assert.equal(verifySuccession(tag, inst, [e1, signHandoff(a, tag, inst, [e1], c.publicKey, t)]), false, 'the old host after handing off')
  assert.equal(verifySuccession(tag, inst, [{ ...e1, hostId: c.publicKey }]), false, 'tampered')
  assert.equal(verifySuccession(tag, inst, [signHandoff(a, tag, inst, [], a.publicKey, t)]), false, 'to itself')

  // Epochs count up from 1, one per entry.
  assert.equal(verifySuccession(tag, inst, [e2]), false, 'starts at epoch 2')
  assert.equal(verifySuccession(tag, inst, [e1, e1]), false, 'repeats an epoch')
  assert.equal(verifySuccession(tag, inst, [e1, signHandoff(b, tag, inst, [e1, e1], c.publicKey, t)]), false, 'skips an epoch')

  // Bound to the room and the instance.
  assert.equal(verifySuccession(roomTagFor(parseRoom('lc1-other-room-dddddddd')), inst, [e1]), false)
  assert.equal(verifySuccession(tag, { ...inst, iid: randomId(8) }, [e1]), false)

  // A timeout claim is signed by the claimant, `since` included.
  const claim = signTimeout(b, tag, inst, [], t - 500, t)
  assert.deepEqual([claim.by, claim.hostId, claim.kind, claim.epoch], [a.publicKey, b.publicKey, 'timeout', 1])
  assert.equal(verifySuccession(tag, inst, [claim]), true)
  assert.equal(verifySuccession(tag, inst, [{ ...claim, since: t - 900 }]), false, 'since is signed')
  assert.equal(verifySuccession(tag, inst, [{ ...signTimeout(c, tag, inst, [], t - 500, t), hostId: b.publicKey }]), false, 'claimed for someone else')
  const { since, ...noSince } = claim
  assert.equal(verifySuccession(tag, inst, [noSince]), false)

  // At most MAX_SUCCESSION entries.
  const chain = []
  for (let i = 0; i <= MAX_SUCCESSION; i++) chain.push(signHandoff(ids[i], tag, inst, chain, ids[i + 1].publicKey, t + i))
  assert.equal(verifySuccession(tag, inst, chain.slice(0, MAX_SUCCESSION)), true)
  assert.equal(verifySuccession(tag, inst, chain), false, 'over-long')

  for (const junk of [null, {}, 'x', [null], [{}], [{ ...e1, kind: 'coup' }], [{ ...e1, ts: 'now' }]]) {
    assert.equal(verifySuccession(tag, inst, junk), false, JSON.stringify(junk))
  }
})

test('choosing between chains: extensions win; a handoff beats any timeout claim; then the earliest since', () => {
  const tag = roomTagFor(parseRoom('lc1-aaaa-bbbb-cccccccc'))
  const [h, b, c, x] = Array.from({ length: 4 }, () => ephemeralIdentity())
  const t = Date.now()
  const inst = signInst(h, tag, { iid: randomId(8), createdAt: t - 1000, hostId: h.publicKey })
  const handoff = signHandoff(h, tag, inst, [], b.publicKey, t)
  const byB = signTimeout(b, tag, inst, [], t - 500, t)
  const byC = signTimeout(c, tag, inst, [], t - 800, t)

  assert.equal(betterSuccession([handoff], []), true)
  assert.equal(betterSuccession([], [handoff]), false)
  assert.equal(betterSuccession([handoff], [handoff]), false)

  // The host's own word beats a timeout claim, however long the chain built on it.
  const padded = [byC]
  for (let holder = c, i = 0; i < 5; i++) {
    const next = ephemeralIdentity()
    padded.push(signHandoff(holder, tag, inst, padded, next.publicKey, t))
    holder = next
  }
  assert.equal(betterSuccession(padded, [handoff]), false)
  assert.equal(betterSuccession([handoff], padded), true)

  // Two timeout claims: the claimant who entered first wins, then the lower key.
  assert.equal(betterSuccession([byC], [byB]), true)
  assert.equal(betterSuccession([byB, signHandoff(b, tag, inst, [byB], x.publicKey, t)], [byC]), false)
  const twin = signTimeout(x, tag, inst, [], t - 800, t)
  assert.equal(betterSuccession([twin], [byC]), x.publicKey < c.publicKey)

  // A host that signed two handoffs: the longer chain, then the lower hash.
  const other = signHandoff(h, tag, inst, [], c.publicKey, t)
  assert.notEqual(betterSuccession([handoff], [other]), betterSuccession([other], [handoff]))
  assert.equal(betterSuccession([other, signHandoff(c, tag, inst, [other], x.publicKey, t)], [handoff]), true)
})

test('a timeout claim holds only once the host is gone, and only from its successor; forged handoffs never', () => {
  let clock = Date.now()
  const me = ephemeralIdentity()
  const r = new Room({ room: parseRoom('lc1-aaaa-bbbb-cccccccc'), identity: me, expireMs: 3000, now: () => clock })
  r.conns.add({ mate: true, conn: { write () {} } })
  const hosts = []
  r.on('host', (h) => hosts.push(h))
  const [host, b, c] = [ephemeralIdentity(), ephemeralIdentity(), ephemeralIdentity()]
  const inst = signInst(host, r.roomTag, { iid: randomId(8), createdAt: clock - 60000, hostId: host.publicKey })
  // b and c were in the room before us: b first.
  const since = { [host.publicKey]: inst.createdAt, [b.publicKey]: clock - 50000, [c.publicKey]: clock - 40000 }
  let ts = clock
  const state = (who, extra = {}) => {
    ts = Math.max(ts + 1, clock)
    const line = seal(who, { t: 'state', v: 1, room: r.roomTag, from: who.publicKey, tag: 'aaaaaaaa', mid: randomId(), ts, status: 'active', inst, since: since[who.publicKey], ...extra })
    r._onSigned([...r.conns][0], open(JSON.parse(line)), line)
  }
  for (const who of [host, b, c]) state(who)
  assert.equal(r.hostId, host.publicKey)
  assert.equal(r.since, clock)

  const claimBy = (who, chain = [], s = since[who.publicKey]) => [...chain, signTimeout(who, r.roomTag, inst, chain, s, ts)]
  state(b, { succession: claimBy(b) })
  assert.equal(r.hostId, host.publicKey, 'not while the host is here')
  state(c, { succession: [{ ...signHandoff(c, r.roomTag, inst, [], c.publicKey, ts), by: host.publicKey }] })
  assert.equal(r.hostId, host.publicKey, 'a handoff forged by a member')
  state(c, { succession: [{ ...signHandoff(host, r.roomTag, inst, [], c.publicKey, ts), epoch: 2 }] })
  assert.equal(r.hostId, host.publicKey, 'a broken epoch')

  // The host goes quiet; b and c don't. After expireMs the host has timed out.
  clock += 4000
  state(b)
  state(c)
  r._expire()
  assert.equal(r.members.size, 2)
  assert.equal(r.hostId, host.publicKey, 'we are not the successor, so we claim nothing')
  state(c, { succession: claimBy(c) })
  assert.equal(r.hostId, host.publicKey, 'c is not the successor: b entered first')
  state(b, { succession: claimBy(b, [], since[b.publicKey] - 1) })
  assert.equal(r.hostId, host.publicKey, 'claims a since it never told us')
  const byB = claimBy(b)
  state(b, { succession: byB })
  assert.equal(r.hostId, b.publicKey)
  assert.deepEqual(hosts.map(h => h.text), [`${b.handle} is now host (${host.handle} timed out)`])

  // A later, competing claim (even padded with handoffs) doesn't win against it.
  const padded = claimBy(c)
  padded.push(signHandoff(c, r.roomTag, inst, padded, me.publicKey, ts))
  state(c, { succession: padded })
  assert.equal(r.hostId, b.publicKey)

  // b hands off to c; a chain over the cap is ignored, the next handoff isn't.
  const toC = [...byB, signHandoff(b, r.roomTag, inst, byB, c.publicKey, ts)]
  state(b, { succession: toC })
  assert.equal(r.hostId, c.publicKey)
  assert.equal(hosts.at(-1).text, `${c.handle} is now host (handed off by ${b.handle})`)
  const long = [...toC]
  let holder = c
  while (long.length <= MAX_SUCCESSION) {
    const next = holder === c ? b : c
    long.push(signHandoff(holder, r.roomTag, inst, long, next.publicKey, ts))
    holder = next
  }
  state(holder, { succession: long })
  assert.equal(r.succession.length, 2, 'over-long')
  state(holder, { succession: long.slice(0, MAX_SUCCESSION) })
  assert.equal(r.succession.length, MAX_SUCCESSION)
  // Everyone else times out: we'd be the successor, but a full chain stays as it is.
  clock += 4000
  r._expire()
  assert.equal(r.members.size, 0)
  assert.equal(r.hostId, long[MAX_SUCCESSION - 1].hostId)

  // Even a full chain of the longest entries fits in one line.
  const big = Number.MAX_SAFE_INTEGER
  const worst = { epoch: MAX_SUCCESSION, hostId: 'f'.repeat(64), by: 'f'.repeat(64), kind: 'timeout', since: big, ts: big, sig: 'f'.repeat(128) }
  const line = seal(me, { ...r._stateBody(), ts: big, since: big, succession: Array(MAX_SUCCESSION).fill(worst) })
  assert.ok(line.length <= MAX_LINE, `${line.length} bytes`)
})

// Each test runs its own testnet and rooms; they take a while to connect, so run them side by side.
describe('on a local testnet', { concurrency: true }, () => {
  it('the host leaves: everyone agrees on its successor, and a later peer sees the same host', { timeout: 90000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const room = privateRoom()
    const [host, b, c] = [mk(testnet, room), mk(testnet, room), mk(testnet, room)]
    t.after(() => Promise.all([host, b, c].map(r => r.leave())))
    await joinAll([host, b, c])
    assert.equal(host.isHost, true)

    await host.leave('left')
    await waitFor(() => b.isHost && c.hostId === b.me, 10000, 'b is host for everyone')
    assert.equal(c.hostHandle, b.identity.handle)
    assert.deepEqual(b.hosts.map(h => [h.kind, h.by, h.self, h.text]), [['handoff', host.me, true, `you're now host (handed off by ${host.identity.handle})`]])
    assert.deepEqual(c.hosts.map(h => h.text), [`${b.identity.handle} is now host (handed off by ${host.identity.handle})`])
    assert.equal(c.memberList().find(m => m.from === b.me).host, true)
    assert.equal(b.memberList()[0].host, true)

    const d = mk(testnet, room)
    t.after(() => d.leave())
    await d.join()
    await waitFor(() => d.inst?.iid === b.inst.iid && knows(d, b), 20000, 'd joins the same room')
    assert.equal(d.hostHandle, b.identity.handle, 'a handoff needs no waiting')
    assert.deepEqual(d.hosts, [], 'history is not news')
    assert.equal(d.succession.length, 1)
  })

  it('a spectating host leaves: the room passes to the earliest-joined active member', { timeout: 90000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const room = privateRoom()
    const [host, b, c] = [mk(testnet, room), mk(testnet, room), mk(testnet, room)]
    t.after(() => Promise.all([host, b, c].map(r => r.leave())))
    await joinAll([host, b, c])
    host.setStatus('away')
    b.setStatus('needed')
    await waitFor(() => [b, c].every(r => [...r.members.values()].find(m => m.from === host.me)?.status === 'away'), 5000, 'host spectating')
    await waitFor(() => [...host.members.values()].find(m => m.from === b.me)?.status === 'needed', 5000, 'b needed')
    assert.equal(host.isHost, true, 'still the host while spectating')

    await host.leave('left')
    await waitFor(() => b.isHost && c.hostId === b.me, 10000, 'b is host for everyone')
    assert.equal(b.dead || c.dead, false)
  })

  it('the host crashes: every peer picks the same successor, and a later peer follows', { timeout: 120000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const room = privateRoom()
    const [host, b, c] = [mk(testnet, room), mk(testnet, room), mk(testnet, room)]
    t.after(() => Promise.all([b, c].map(r => r.leave())))
    await joinAll([host, b, c])
    assert.ok(b.since < c.since)
    // Once the host is gone it relays nothing, so b's claim has to reach c directly.
    await waitFor(() => direct(b, c), 45000, 'b and c connected')

    await crash(host)
    await waitFor(() => b.isHost && c.hostId === b.me, 15000, 'b takes over')
    assert.deepEqual(b.hosts.map(h => [h.kind, h.by, h.text]), [['timeout', host.me, `you're now host (${host.identity.handle} timed out)`]])
    assert.deepEqual(c.hosts.map(h => h.text), [`${b.identity.handle} is now host (${host.identity.handle} timed out)`])
    await new Promise(resolve => setTimeout(resolve, 1500))
    assert.equal(b.succession.length, 1, 'one claim, no flip-flopping')
    assert.equal(c.succession.length, 1)

    const d = mk(testnet, room)
    t.after(() => d.leave())
    await d.join()
    await waitFor(() => d.hostId === b.me, 20000, 'd follows once it has been around for an expiry period')
    assert.equal(d.succession.length, 1)
  })

  it('an older peer ignores succession: it still verifies the instance and stays in the room; the new peers hand off', { timeout: 120000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const room = privateRoom()
    const [host, old, b] = [mk(testnet, room), mk(testnet, room, OldRoom), mk(testnet, room)]
    t.after(() => Promise.all([host, old, b].map(r => r.leave())))
    await joinAll([host, old, b])
    await waitFor(() => direct(old, b), 45000, 'old and new peer connected')
    await host.leave('left')
    await waitFor(() => b.isHost, 10000, 'the new peer is host')
    await waitFor(() => !old.members.has(host.key), 5000, 'the old peer saw the host leave')
    // Long enough for either side to have dropped the other if it didn't accept its states.
    await new Promise(resolve => setTimeout(resolve, FAST.expireMs + 1000))
    assert.ok(knows(old, b) && knows(b, old), 'still in the room together')
    assert.equal(old.hostHandle, host.identity.handle, 'a stale label, as before')
    assert.equal(old.inst.iid, b.inst.iid)
    assert.equal(verifyInst(old.roomTag, old.inst), true)
    assert.equal(old.dead, false)
    old.say('old here')
    b.say('new here')
    await waitFor(() => b.chats.includes('old here') && old.chats.includes('new here'), 5000, 'chat both ways')
    assert.equal([...b.members.values()].find(m => m.from === old.me).status, 'active')
    assert.equal([...old.members.values()].find(m => m.from === b.me).status, 'active')
  })

  it('an older host leaves without a handoff: the new peers time it out and agree on a successor', { timeout: 120000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const room = privateRoom()
    const [oldHost, n1, n2] = [mk(testnet, room, OldRoom), mk(testnet, room), mk(testnet, room)]
    t.after(() => Promise.all([oldHost, n1, n2].map(r => r.leave())))
    await joinAll([oldHost, n1, n2])
    assert.equal(n1.hostId, oldHost.me)
    await oldHost.leave('left')
    await waitFor(() => n1.isHost && n2.hostId === n1.me, 10000, 'n1 takes over')
    assert.equal(n2.hosts.at(-1).text, `${n1.identity.handle} is now host (${oldHost.identity.handle} timed out)`)
  })

  it('the lounge follows the current host: sys line, snapshot, and spectating after the pull-back', { timeout: 90000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const room = privateRoom()
    const core = () => new Controller({
      identity: ephemeralIdentity(),
      config: { room: room.code, idleMs: 400, announce: false, countdownSeconds: 0 },
      bootstrap: testnet.bootstrap,
      roomOpts: FAST,
      focus: () => {},
      notify: () => {},
      bannerMs: 300,
      watchLogs: false
    })
    const hook = (sessionId, kind, extra = {}) => ({ type: 'hook', sessionId, kind, mode: 'autopilot', cwd: '/w/' + sessionId, ts: Date.now(), ...extra })
    const [host, guest] = [core(), core()]
    const other = mk(testnet, room)
    t.after(() => Promise.all([host.shutdown(), guest.shutdown(), other.leave()]))

    host.handle(hook('h1', 'activity'))
    await waitFor(() => host.room.isHost, 10000, 'host owns the room')
    guest.handle(hook('g1', 'activity'))
    await waitFor(() => settled([host.room, guest.room]), 20000, 'guest joins')
    await other.join()
    await waitFor(() => settled([host.room, guest.room, other]), 20000, 'a third peer joins')
    assert.equal(guest.snapshot().room.hostHandle, host.identity.handle)

    await host.leaveRoom()
    await waitFor(() => guest.snapshot().room.isHost, 10000, 'guest is host')
    const snap = guest.snapshot()
    assert.equal(snap.room.hostHandle, guest.identity.handle)
    assert.equal(snap.members.find(m => m.you).isHost, true)
    assert.ok(guest.messages.some(m => m.kind === 'sys' && m.text === `you're now host (handed off by ${host.identity.handle})`))
    await waitFor(() => other.hostId === guest.identity.publicKey, 5000, 'the third peer agrees')

    // As host, the guest now stays to watch when its autopilot ends while others are still on it.
    guest.handle(hook('g1', 'complete', { summary: 'done' }))
    assert.equal(guest.phase, 'spectating')
  })
})

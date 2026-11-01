import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, client, agent, start, ok, texts } from './helpers/agents.js'

test('presence: close → away → left (card lingers, then goes); resume within the window keeps id, name and cursor', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 300, lingerMs: 500 } })
  const human = client()
  human.send({ type: 'subscribe', v: 1, stream: 'agents' })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('status', { summary: 'reading' })) // active, so its leaving is announced
  ok(await b.cmd('post', { text: 'hi', to: ['copilot-repo'] }))
  ok(await a.cmd('read'))
  const cursor = room.agents.get(a.welcome.agent.id).cursor

  a.close()
  await a.closed
  await human.next(m => m.type === 'agents' && m.agents.some(c => c.name === 'copilot-repo' && !c.present), 2000, 'away card')
  const back = await agent({ harness: 'copilot', resume: a.welcome.resume })
  assert.deepEqual(back.welcome.agent, a.welcome.agent, 'same id and name')
  assert.equal(back.welcome.resume, a.welcome.resume)
  assert.equal(room.agents.get(a.welcome.agent.id).cursor, cursor, 'same cursor')
  assert.equal(room.snapshot().agents.find(c => c.name === 'copilot-repo').present, true)
  assert.ok(!room.snapshot().messages.some(m => m.text === 'copilot-repo left'), 'a quick reconnect is seamless')

  back.close()
  await back.closed
  await sleep(400)
  const snap = room.snapshot()
  assert.equal(snap.messages.at(-1).text, 'copilot-repo left')
  assert.equal(snap.messages.at(-1).kind, 'sys')
  assert.deepEqual(snap.agents.find(c => c.name === 'copilot-repo').present, false, 'the card stays visible')
  const late = await agent({ harness: 'copilot', resume: a.welcome.resume })
  assert.notEqual(late.welcome.agent.id, a.welcome.agent.id, 'too late to resume: a new agent')
  assert.equal(late.name, 'copilot-repo', 'the name is free again')
  await sleep(600)
  assert.deepEqual(room.snapshot().agents.map(c => c.id).sort(), [b.welcome.agent.id, late.welcome.agent.id].sort(), 'then the card goes')
  for (const x of [human, b, late]) x.close()
})

test('a resume replaces the old connection and its wait; a stale `since` cannot park the cursor in the future', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const pending = a.cmd('wait', { timeoutMs: 5000 })
  await sleep(50)
  // A second connection with the token takes over while the first is still open.
  const a2 = await agent({ harness: 'copilot', resume: a.welcome.resume })
  assert.equal(a2.welcome.agent.id, a.welcome.agent.id)
  await a.closed
  ok(await b.cmd('post', { kind: 'question', text: 'still there?', to: ['copilot-repo'] }))
  assert.deepEqual(texts(ok(await a2.cmd('read')).messages), ['still there?'], 'the message reaches the new connection')
  await assert.rejects(Promise.race([pending, sleep(300).then(() => { throw new Error('no reply on a closed connection') })]))

  // A cursor from before a daemon restart (or a timestamp) as `since`.
  const r = ok(await a2.cmd('read', { since: 1730400000000 }))
  assert.equal(r.cursor, room.seq)
  ok(await b.cmd('post', { text: 'after that, @copilot-repo' }))
  assert.deepEqual(texts(ok(await a2.cmd('read')).messages), ['after that, @copilot-repo'])
  a2.close()
  b.close()
})

const until = async (fn, label, ms = 3000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(20)
  }
}

test('cards: presence here → away → left, with leftAt; present is presence == "here"; a left card lingers 10 minutes by default', async (t) => {
  assert.equal((await import('../src/agents.js')).LIMITS.lingerMs, 10 * 60 * 1000)
  const { room } = await start(t, { limits: { resumeMs: 200, lingerMs: 300 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const card = () => room.snapshot().agents.find(c => c.id === a.welcome.agent.id)
  const seen = (c) => c && [c.presence, c.present, c.leftAt === null]
  assert.deepEqual(seen(card()), ['here', true, true])
  assert.deepEqual(seen(ok(await a.cmd('catchUp')).you), ['here', true, true])
  assert.deepEqual(Object.keys(card()).slice(-6), ['present', 'joinedAt', 'updatedAt', 'presence', 'leftAt', 'overlaps'])

  const t0 = Date.now()
  a.close()
  await a.closed
  await until(() => card().presence === 'away', 'away')
  assert.deepEqual(seen(card()), ['away', false, true])
  assert.deepEqual(seen(ok(await b.cmd('catchUp')).board.find(c => c.name === 'copilot-repo')), ['away', false, true], 'boards show it too')
  await until(() => card().presence === 'left', 'left')
  assert.deepEqual(seen(card()), ['left', false, false])
  assert.ok(card().leftAt >= t0 + 150 && card().leftAt <= Date.now(), 'leftAt: when the resume window ended')
  assert.ok(room.snapshot().messages.some(m => m.kind === 'sys' && m.text === 'copilot-repo left'))
  await until(() => !card(), 'the card goes after lingerMs')
  b.close()
})

test('bye: the agent leaves at once, the reply is the last line and the daemon closes the connection; nothing after it counts', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 60000 } })
  const events = []
  room.on('presence', (event, card) => events.push(`${card.name} ${event} ${card.presence}`))
  const human = client()
  human.send({ type: 'subscribe', v: 1, stream: 'agents' })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await b.cmd('post', { text: 'for you', to: ['copilot-repo'] }))
  // A wait pending on the connection (it would return at once with an unread message, so read first).
  ok(await a.cmd('read'))
  a.send({ type: 'cmd', id: 500, cmd: 'wait', timeoutMs: 5000 })
  await sleep(30)

  const t0 = Date.now()
  const bye = a.cmd('bye')
  a.send({ type: 'cmd', id: 999, cmd: 'post', text: 'after bye' })
  const r = await bye
  assert.deepEqual(r, { type: 'reply', id: r.id, ok: true, result: {}, inbox: { unread: 0, mentions: 0 } })
  await a.closed
  assert.ok(Date.now() - t0 < 1000, 'closed at once, not after the resume window')
  assert.deepEqual(a.lines, [], 'the reply was the last line: no reply to the wait, nor to the post after bye')

  const snap = room.snapshot()
  assert.ok(!snap.messages.some(m => m.text === 'after bye'), 'a line after bye is ignored')
  assert.equal(snap.messages.at(-1).text, 'copilot-repo left')
  assert.equal(snap.messages.at(-1).kind, 'sys')
  const card = snap.agents.find(c => c.id === a.welcome.agent.id)
  assert.deepEqual([card.presence, card.present], ['left', false])
  assert.ok(card.leftAt >= t0 && card.leftAt <= Date.now())
  await human.next(m => m.type === 'agents' && m.agents.some(c => c.id === a.welcome.agent.id && c.presence === 'left'), 2000, 'the agents stream shows left')
  assert.deepEqual(events.filter(e => e.startsWith('copilot-repo')), ['copilot-repo joined here', 'copilot-repo left left'], 'never away')
  assert.equal(room.agents.get(a.welcome.agent.id).unread.size, 0)

  // Its token no longer resumes, and its name is free again.
  const again = await agent({ harness: 'copilot', resume: a.welcome.resume })
  assert.notEqual(again.welcome.agent.id, a.welcome.agent.id)
  assert.equal(again.name, 'copilot-repo')
  assert.equal(ok(await b.cmd('catchUp')).board.filter(c => c.name === 'copilot-repo').map(c => c.presence).sort().join(), 'here,left')
  for (const x of [human, b, again]) x.close()
})

test('overlaps: an away agent keeps them (it may resume); a left one has none, and the other cards drop theirs with it', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 200 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  for (const x of [a, b, c]) ok(await x.cmd('status', { state: 'editing', focus: { paths: ['src/shared.js'] } }))
  const overlaps = (name) => room.snapshot().agents.find(x => x.name === name).overlaps
  assert.deepEqual(overlaps('claude-repo'), ['copilot-repo', 'codex-repo'])

  a.close()
  await a.closed
  await until(() => room.snapshot().agents.find(x => x.name === 'copilot-repo').presence === 'away', 'away')
  assert.deepEqual(overlaps('copilot-repo'), ['claude-repo', 'codex-repo'], 'away: keeps its overlaps')
  assert.deepEqual(overlaps('claude-repo'), ['copilot-repo', 'codex-repo'])

  // Left by bye, and left when the resume window ends: no overlaps either way.
  ok(await c.cmd('bye'))
  await c.closed
  assert.deepEqual(overlaps('codex-repo'), [])
  assert.deepEqual(overlaps('claude-repo'), ['copilot-repo'], 'b drops c at once')
  await until(() => room.snapshot().agents.find(x => x.name === 'copilot-repo').presence === 'left', 'a left')
  assert.deepEqual(overlaps('copilot-repo'), [])
  assert.deepEqual(overlaps('claude-repo'), [])
  assert.deepEqual(ok(await b.cmd('catchUp')).you.overlaps, [])
  b.close()
})

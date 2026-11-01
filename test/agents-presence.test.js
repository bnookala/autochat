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

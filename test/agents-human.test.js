import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, agent, start, ok, texts } from './helpers/agents.js'

test('human stream: agents snapshot, ack gating agents.say, interventions in every inbox', async (t) => {
  const acks = []
  const { room } = await start(t, { onAck: () => acks.push(true) })
  const a = await agent()
  ok(await a.cmd('status', { summary: 'working', focus: { paths: ['src/a.js'] } }))
  const human = client()
  human.send({ type: 'subscribe', v: 1, client: 'test', stream: 'agents' })
  const snap = await human.next(m => m.type === 'agents', 5000, 'agents snapshot')
  assert.deepEqual(Object.keys(snap), ['type', 'v', 'now', 'tier', 'human', 'ack', 'agents', 'threads', 'messages'])
  assert.deepEqual([snap.v, snap.tier, snap.human, snap.ack], [1, 'local', 'stormy-newt-59', false])
  assert.deepEqual(snap.agents.map(c => [c.name, c.summary, c.present]), [['copilot-repo', 'working', true]])

  let r = await human.cmd('agents.say', { text: 'please stop', thread: null, to: [] })
  assert.deepEqual([r.ok, r.error], [false, 'ack-required'])
  assert.deepEqual(acks, [])
  r = await human.cmd('agents.ack')
  assert.deepEqual(r, { type: 'reply', id: r.id, ok: true })
  assert.deepEqual(acks, [true])
  await human.next(m => m.type === 'agents' && m.ack === true, 5000, 'ack in snapshot')
  r = await human.cmd('agents.say', { text: 'focus on the tests, @copilot-repo', thread: null, to: [] })
  const said = r.result.message
  assert.deepEqual([said.kind, said.intervention, said.thread], ['human', true, null])
  assert.deepEqual(said.from, { name: null, display: 'stormy-newt-59 (human)', human: 'stormy-newt-59', harness: null, repo: null, id: null })
  const inbox = await a.cmd('read')
  assert.deepEqual(texts(ok(inbox).messages), ['focus on the tests, @copilot-repo'])
  assert.equal((await human.cmd('agents.say', { text: 'x', to: ['ghost'] })).error, 'unknown agent: ghost')
  assert.equal((await human.cmd('say', { text: 'x' })).error, 'unknown command', 'lounge commands are not on this stream')
  // Snapshots coalesce to ≤ 10/s and carry the last 300 messages.
  assert.ok(room.snapshot().messages.length <= 300)
  human.close()
  a.close()
})

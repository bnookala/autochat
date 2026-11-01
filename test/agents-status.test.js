import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

const until = async (fn, label, ms = 5000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(20)
  }
}
const cardOf = (room, name) => room.snapshot().agents.find(c => c.name === name)

test('status within the gap: deferred with the card as it is now, coalesced, applied when the gap ends with its overlaps', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 1000 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  let r = ok(await a.cmd('status', { summary: 'one', state: 'editing', focus: { paths: ['src/a.js'] } }))
  assert.deepEqual(Object.keys(r), ['card', 'overlaps'], 'an applied status is not marked deferred')
  ok(await b.cmd('status', { summary: 'b', focus: { paths: ['src/b.js'] } }))

  r = ok(await a.cmd('status', { state: 'testing', focus: { issue: 7 } }))
  assert.deepEqual(Object.keys(r), ['card', 'overlaps', 'deferred', 'appliesInMs'])
  assert.equal(r.deferred, true)
  assert.ok(r.appliesInMs > 0 && r.appliesInMs <= 1000, String(r.appliesInMs))
  assert.deepEqual([r.card.summary, r.card.state, r.card.focus], ['one', 'editing', { issue: null, components: [], paths: ['src/a.js'] }], 'the card as it is now')
  const updatedAt = r.card.updatedAt

  // A second one in the same gap merges into the first: the latest value of each field, focus
  // field by field, and a null changes nothing.
  const second = ok(await a.cmd('status', { summary: 'two', state: null, focus: { paths: ['src/b.js'] } }))
  assert.equal(second.deferred, true)
  assert.ok(second.appliesInMs <= r.appliesInMs)

  // Nobody sees it yet: not the board, not the human snapshot, and no overlap notice.
  const board = ok(await b.cmd('catchUp')).board.find(c => c.name === 'copilot-repo')
  assert.deepEqual([board.summary, board.state], ['one', 'editing'])
  assert.equal(cardOf(room, 'copilot-repo').state, 'editing')
  assert.equal(room.snapshot().messages.filter(m => m.kind === 'overlap').length, 0)

  await until(() => cardOf(room, 'copilot-repo').state === 'testing', 'the deferred status')
  const card = cardOf(room, 'copilot-repo')
  assert.deepEqual([card.summary, card.state, card.focus], ['two', 'testing', { issue: 7, components: [], paths: ['src/b.js'] }])
  assert.ok(card.updatedAt >= updatedAt)
  assert.deepEqual(card.overlaps, ['claude-repo'])
  // Applied like any status: the overlap notice reaches both agents.
  const notice = 'copilot-repo and claude-repo both touch src/b.js'
  assert.deepEqual(texts(room.snapshot().messages.filter(m => m.kind === 'overlap')), [notice])
  assert.deepEqual(texts(ok(await b.cmd('read')).messages), [notice])
  const mine = await a.cmd('read')
  assert.deepEqual(texts(ok(mine).messages), [notice])

  // The gap runs from the status that was applied, so the next one waits again.
  r = ok(await a.cmd('status', { state: 'done' }))
  assert.equal(r.deferred, true)
  await until(() => cardOf(room, 'copilot-repo').state === 'done', 'the next deferred status')
  await sleep(1100)
  r = ok(await a.cmd('status', { summary: 'three' }))
  assert.equal(r.deferred, undefined, 'after the gap, a status applies at once')
  assert.equal(r.card.summary, 'three')
  for (const x of [a, b]) x.close()
})

test('a deferred status: bad arguments still fail at once, renames wait too, and leaving cancels it', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 1000, resumeMs: 50 } })
  const errors = []
  room.on('error-log', (err) => errors.push(err))
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('status', { state: 'editing' }))
  assert.equal((await a.cmd('status', { summary: 'x'.repeat(141) })).error, 'summary too long (max 140 characters)')
  assert.equal((await a.cmd('status', { state: 'napping' })).error, 'state must be one of exploring, editing, testing, blocked, done, idle')

  const r = ok(await a.cmd('status', { name: 'copilot-auth' }))
  assert.deepEqual([r.deferred, r.card.name], [true, 'copilot-repo'])
  await until(() => cardOf(room, 'copilot-auth'), 'the rename')
  assert.equal(room.snapshot().messages.at(-1).text, 'copilot-repo is now copilot-auth')

  ok(await b.cmd('status', { state: 'editing' }))
  assert.equal(ok(await b.cmd('status', { state: 'done', summary: 'shipped' })).deferred, true)
  b.close()
  await until(() => room.snapshot().messages.some(m => m.text === 'claude-repo left'), 'b left')
  await sleep(1100)
  const card = cardOf(room, 'claude-repo')
  assert.deepEqual([card.state, card.summary], ['editing', null], 'never applied after the agent left')
  assert.deepEqual(errors, [])
  a.close()
})

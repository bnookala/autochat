import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agent, start, ok, texts } from './helpers/agents.js'
const { overlapOn } = await import('../src/agents.js')

test('status → overlap notices once per pair, until the overlap clears and comes back', async (t) => {
  let clock = 1_000_000
  const { room } = await start(t, { now: () => clock })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const other = await agent({ harness: 'gemini', repo: 'owner/elsewhere' })
  ok(await other.cmd('status', { focus: { paths: ['src/room.js'], issue: 17 } }))

  let r = ok(await a.cmd('status', { summary: 'room refactor', state: 'editing', focus: { issue: 17, components: ['Room'], paths: ['src/room.js', 'test/room.test.js'] } }))
  assert.deepEqual(r.overlaps, [], 'a different repo never overlaps')
  assert.equal(r.card.state, 'editing')
  assert.equal(r.card.summary, 'room refactor')
  assert.deepEqual(r.card.focus, { issue: 17, components: ['Room'], paths: ['src/room.js', 'test/room.test.js'] })

  r = ok(await b.cmd('status', { focus: { components: ['room'], paths: ['./src/'] } }))
  assert.deepEqual(r.overlaps, [{ agent: 'copilot-repo', on: { components: ['room'], paths: ['src/room.js'] } }])
  assert.deepEqual(r.card.overlaps, ['copilot-repo'])
  assert.deepEqual(r.card.focus.paths, ['src'], 'paths are normalized')
  const notice = room.snapshot().messages.filter(m => m.kind === 'overlap')
  assert.equal(notice.length, 1)
  assert.equal(notice[0].text, 'claude-repo and copilot-repo both touch component room, src/room.js')
  assert.deepEqual([notice[0].from, notice[0].thread, notice[0].to], [null, null, ['claude-repo', 'copilot-repo']])
  // One message, in both agents' inboxes.
  const aInbox = ok(await a.cmd('read'))
  assert.deepEqual(texts(aInbox.messages), [notice[0].text])
  assert.deepEqual(texts(ok(await b.cmd('read')).messages), [notice[0].text])

  // Still overlapping: no repeat.
  clock += 5000
  r = ok(await a.cmd('status', { focus: { paths: ['src/room.js', 'src/ipc.js'] } }))
  assert.deepEqual(r.overlaps.map(o => o.agent), ['claude-repo'])
  assert.equal(room.snapshot().messages.filter(m => m.kind === 'overlap').length, 1)
  assert.deepEqual(room.snapshot().agents.find(c => c.name === 'claude-repo').overlaps, ['copilot-repo'])

  // Clears (no shared component, path or issue), then comes back: notified again.
  clock += 5000
  ok(await b.cmd('status', { focus: { components: [], paths: ['docs'] } }))
  assert.deepEqual(room.snapshot().agents.find(c => c.name === 'copilot-repo').overlaps, [])
  clock += 5000
  r = ok(await b.cmd('status', { focus: { issue: 17 } }))
  assert.deepEqual(r.overlaps, [{ agent: 'copilot-repo', on: { issue: 17 } }])
  const notices = room.snapshot().messages.filter(m => m.kind === 'overlap')
  assert.equal(notices.length, 2)
  assert.equal(notices[1].text, 'claude-repo and copilot-repo both touch issue #17')
  for (const x of [a, b, other]) x.close()
})

test('path overlap: equal, or a directory prefix on segment boundaries', () => {
  const card = (repo, paths, extra = {}) => ({ repo, focus: { issue: null, components: [], paths, ...extra }, pathIndex: { paths, set: new Set(paths), dirs: new Set(paths.flatMap(p => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))) } })
  assert.deepEqual(overlapOn(card('o/r', ['src/room.js']), card('o/r', ['src/room.js'])), { paths: ['src/room.js'] })
  assert.deepEqual(overlapOn(card('o/r', ['src']), card('o/r', ['src/room.js', 'src/a/b.js'])), { paths: ['src/a/b.js', 'src/room.js'] })
  assert.equal(overlapOn(card('o/r', ['src/ro']), card('o/r', ['src/room.js'])), null, 'not a segment boundary')
  assert.equal(overlapOn(card('O/R', ['a']), card('o/r', ['a'])).paths[0], 'a', 'repos compare case-insensitively')
  assert.equal(overlapOn(card(null, ['a']), card(null, ['a'])), null, 'repo must be non-null')
  assert.deepEqual(overlapOn(card('o/r', [], { components: ['IPC'] }), card('o/r', [], { components: ['ipc', 'x'] })), { components: ['IPC'] })
})

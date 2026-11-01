import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agent, start, ok, texts } from './helpers/agents.js'

test('catchUp: you, tier, board, threads, last decisions, recent main stream, unread inbox, cursor', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('status', { summary: 'auth', state: 'exploring' }))
  for (let i = 0; i < 3; i++) ok(await a.cmd('post', { text: 'note ' + i }))
  ok(await a.cmd('post', { kind: 'decision', text: 'use the lock' }))
  ok(await a.cmd('post', { text: 'for you', to: ['claude-repo'] }))
  const reply = await b.cmd('catchUp')
  const r = ok(reply)
  assert.deepEqual(Object.keys(r), ['you', 'tier', 'board', 'threads', 'relevant', 'decisions', 'recent', 'inbox', 'cursor'])
  assert.equal(r.you.name, 'claude-repo')
  assert.equal(r.tier, 'local')
  assert.deepEqual(r.board.map(c => [c.name, c.summary, c.state, c.present]), [['copilot-repo', 'auth', 'exploring', true]])
  assert.deepEqual(texts(r.inbox), ['use the lock', 'for you'], 'unread inbox; decisions count')
  assert.deepEqual(r.decisions, [], 'not repeated when already in the inbox')
  assert.deepEqual(texts(r.recent), ['copilot-repo joined', 'claude-repo joined', 'note 0', 'note 1', 'note 2'])
  assert.equal(r.cursor, room.seq)
  assert.deepEqual(reply.inbox, { unread: 0, mentions: 0 }, 'catchUp marks the inbox read')
  // A card before any status: idle, no summary, empty focus.
  const fresh = await agent({ harness: 'gemini' })
  const card = ok(await fresh.cmd('catchUp')).you
  assert.deepEqual([card.state, card.summary, card.focus], ['idle', null, { issue: null, components: [], paths: [] }])
  assert.deepEqual(Object.keys(card), ['id', 'name', 'display', 'human', 'title', 'parent', 'harness', 'repo', 'branch', 'worktree', 'state', 'summary', 'focus', 'present', 'joinedAt', 'updatedAt', 'overlaps'])
  for (const x of [a, b, fresh]) x.close()
})

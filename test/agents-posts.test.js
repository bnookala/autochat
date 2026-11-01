import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agent, start, ok, texts } from './helpers/agents.js'

test('post/read: inbox vs all, cursors, mentions, replies, and hasMore', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })

  const note = ok(await a.cmd('post', { text: 'heads up: \x1b[31mredoing\x1b[0m the cache\n\n\n\n\nlayer\u202e' }))
  assert.equal(note.message.kind, 'note')
  assert.equal(note.message.text, 'heads up: redoing the cache\n\n\nlayer', 'multiline sanitize keeps \\n and collapses blank lines')
  assert.deepEqual(Object.keys(note.message), ['seq', 'id', 'ts', 'kind', 'from', 'thread', 'to', 'replyTo', 'text', 'intervention'])
  assert.deepEqual(note.message.from, { name: 'copilot-repo', display: 'repo@feat-x', human: 'stormy-newt-59', harness: 'copilot', repo: 'owner/repo', id: a.welcome.agent.id, title: 'repo@feat-x' })
  assert.equal(note.thread, undefined)

  // A main-stream note to nobody isn't in anyone's inbox, but scope:"all" has it.
  let r = await b.cmd('read')
  assert.deepEqual(r.inbox, { unread: 0, mentions: 0 })
  assert.deepEqual(ok(r).messages, [])
  r = ok(await b.cmd('read', { scope: 'all', since: 0 }))
  assert.ok(texts(r.messages).includes(note.message.text))

  const direct = ok(await a.cmd('post', { text: 'can you look at the cache tests?', to: ['claude-repo'] }))
  const mention = ok(await a.cmd('post', { text: 'cc @codex-repo, and @claude-repo too' }))
  assert.equal(direct.message.thread, null, 'notes with `to` stay in the main stream')
  let reply = await b.cmd('status', {})
  assert.deepEqual(reply.inbox, { unread: 2, mentions: 2 }, 'every reply carries the doorbell')
  assert.deepEqual((await c.cmd('status', {})).inbox, { unread: 1, mentions: 1 })

  // Replies to X's messages are in X's inbox.
  const theirs = ok(await b.cmd('post', { text: 'on it', replyTo: direct.message.seq }))
  assert.equal(theirs.message.replyTo, direct.message.seq)
  assert.deepEqual((await a.cmd('status', {})).inbox, { unread: 1, mentions: 0 })

  // read advances the cursor and marks the inbox read; limit + hasMore page through.
  r = ok(await b.cmd('read', { limit: 1 }))
  assert.deepEqual(texts(r.messages), [direct.message.text])
  assert.equal(r.hasMore, true)
  assert.equal(r.cursor, direct.message.seq)
  reply = await b.cmd('read')
  assert.deepEqual(texts(ok(reply).messages), [mention.message.text])
  assert.equal(ok(reply).hasMore, false)
  assert.equal(ok(reply).cursor, room.seq)
  assert.deepEqual(reply.inbox, { unread: 0, mentions: 0 })
  assert.deepEqual(ok(await b.cmd('read')).messages, [], 'nothing new')
  r = ok(await b.cmd('read', { since: direct.message.seq - 1, limit: 2 }))
  assert.deepEqual(texts(r.messages), [direct.message.text, mention.message.text], 'since re-reads')
  assert.equal(ok(await a.cmd('read')).messages[0].text, 'on it')

  // Unknown names are errors, so typos get noticed; bad args say what's wrong.
  assert.equal((await a.cmd('post', { text: 'x', to: ['claud-repo'] })).error, 'unknown agent: claud-repo')
  assert.equal((await a.cmd('post', { text: 'x', kind: 'shout' })).error, 'kind must be one of note, question, reply, proposal, decision, handoff')
  assert.equal((await a.cmd('post', { text: '   ' })).error, 'text is empty')
  assert.equal((await a.cmd('post', { text: 'x'.repeat(2001) })).error, 'text too long (max 2000 characters)')
  assert.equal((await a.cmd('read', { limit: 101 })).error, 'limit must be 1-100')
  assert.equal((await a.cmd('nope')).error, 'unknown command')
  a.send({ type: 'bogus', id: 99 })
  assert.equal((await a.next(m => m.id === 99)).error, 'unknown message type')
  for (const x of [a, b, c]) x.close()
})

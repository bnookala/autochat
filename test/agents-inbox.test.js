import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

test('wait: returns on a match, times out, and a newer wait supersedes the older one', async (t) => {
  await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })

  let waiting = b.cmd('wait', { timeoutMs: 5000 })
  await sleep(50)
  ok(await a.cmd('post', { text: 'ignored: not for b' }))
  ok(await a.cmd('post', { text: 'ping @claude-repo' }))
  let r = await waiting
  assert.deepEqual(texts(ok(r).messages), ['ping @claude-repo'])
  assert.equal(ok(r).timedOut, false)
  assert.deepEqual(r.inbox, { unread: 0, mentions: 0 })

  const t0 = Date.now()
  r = ok(await b.cmd('wait', { timeoutMs: 150 }))
  assert.deepEqual([r.messages, r.timedOut], [[], true])
  assert.ok(Date.now() - t0 >= 140)

  // Unread messages return right away.
  ok(await a.cmd('post', { text: 'already here', to: ['claude-repo'] }))
  assert.deepEqual(texts(ok(await b.cmd('wait', { timeoutMs: 5000 })).messages), ['already here'])

  // A newer wait replaces the older one.
  const first = b.cmd('wait', { timeoutMs: 5000 })
  await sleep(30)
  const second = b.cmd('wait', { timeoutMs: 5000 })
  r = await first
  assert.deepEqual([r.ok, r.error], [false, 'superseded'])
  assert.ok(r.inbox)

  // Thread waits return on any new message in that thread.
  const { thread } = ok(await a.cmd('thread', { action: 'open', title: 'naming' }))
  waiting = a.cmd('wait', { thread: thread.id, timeoutMs: 5000 })
  await sleep(30)
  ok(await b.cmd('post', { thread: thread.id, text: 'call it cache' }))
  r = ok(await waiting)
  assert.deepEqual(texts(r.messages), ['call it cache'])
  assert.equal(r.cursor, r.messages[0].seq)
  ok(await a.cmd('post', { text: 'unblock', to: ['claude-repo'] }))
  assert.deepEqual(texts(ok(await second).messages), ['unblock'])
  a.close()
  b.close()
})

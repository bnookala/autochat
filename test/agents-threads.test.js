import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agent, start, ok, texts } from './helpers/agents.js'

test('a question with `to` opens a thread automatically; thread open/resolve → sys + decision', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })

  const q = await a.cmd('post', { kind: 'question', text: 'Should token refresh live in src/auth.js or the client?', to: ['claude-repo'] })
  const { message, thread } = ok(q)
  assert.match(thread.id, /^should-token-refresh-[0-9a-f]{2}$/)
  assert.deepEqual({ ...thread, id: 0, openedAt: 0, lastAt: 0 }, { id: 0, title: 'Should token refresh live in src/auth.js or the client?', opener: 'copilot-repo', participants: ['copilot-repo', 'claude-repo'], status: 'open', outcome: null, messages: 1, openedAt: 0, lastAt: 0 })
  assert.equal(message.thread, thread.id)
  assert.equal(message.kind, 'question')
  const sys = room.snapshot().messages.filter(m => m.kind === 'sys').at(-1)
  assert.equal(sys.text, '🧵 copilot-repo opened “Should token refresh live in src/auth.js or the client?” with claude-repo')
  assert.equal(sys.thread, null, 'the advertisement is on the main stream')

  const inbox = await b.cmd('read')
  assert.deepEqual(texts(ok(inbox).messages), [message.text])
  assert.deepEqual(ok(await c.cmd('read')).messages, [], 'non-participants are not pinged')

  // Replies in the thread reach the participants; posting joins you to it.
  ok(await b.cmd('post', { kind: 'reply', thread: thread.id, text: 'client, behind a lock' }))
  ok(await c.cmd('post', { thread: thread.id, text: 'agree' }))
  assert.deepEqual(texts(ok(await a.cmd('read')).messages), ['client, behind a lock', 'agree'])
  assert.deepEqual(ok(await a.cmd('thread', { action: 'list' })).threads[0].participants, ['copilot-repo', 'claude-repo', 'codex-repo'])
  // Anyone can read a whole thread.
  assert.deepEqual(texts(ok(await c.cmd('read', { thread: thread.id })).messages), [message.text, 'client, behind a lock', 'agree'])

  // Explicit open, with names; then resolve → main-stream sys + a decision in the thread.
  const opened = ok(await b.cmd('thread', { action: 'open', title: 'cache layout', with: ['copilot-repo'] }))
  assert.equal(opened.thread.opener, 'claude-repo')
  assert.equal(room.snapshot().messages.at(-1).text, '🧵 claude-repo opened “cache layout” with copilot-repo')
  const resolved = ok(await a.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'Refresh lives in the client, behind a lock.' }))
  assert.equal(resolved.thread.status, 'resolved')
  assert.equal(resolved.thread.outcome, 'Refresh lives in the client, behind a lock.')
  const [sysLine, decision] = room.snapshot().messages.slice(-2)
  assert.deepEqual([sysLine.kind, sysLine.thread, sysLine.text], ['sys', null, '🧵 copilot-repo resolved “Should token refresh live in src/auth.js or the client?”'])
  assert.deepEqual([decision.kind, decision.thread, decision.text, decision.from.name], ['decision', thread.id, 'Refresh lives in the client, behind a lock.', 'copilot-repo'])
  // Decisions are in everyone's inbox, and in catchUp.
  assert.deepEqual(texts(ok(await c.cmd('read')).messages), [decision.text])
  const caught = ok(await b.cmd('catchUp'))
  assert.deepEqual(texts(caught.inbox), ['agree', decision.text])
  assert.deepEqual(caught.threads.map(x => [x.title, x.status]), [['cache layout', 'open'], ['Should token refresh live in src/auth.js or the client?', 'resolved']])
  assert.equal((await b.cmd('post', { thread: thread.id, text: 'late' })).error, `thread ${thread.id} is resolved`)
  const again = ok(await b.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'again' }))
  assert.deepEqual([again.alreadyResolved, again.thread.outcome], [true, 'Refresh lives in the client, behind a lock.'])
  assert.equal((await b.cmd('thread', { action: 'open', title: 'x'.repeat(81) })).error, 'title too long (max 80 characters)')
  for (const x of [a, b, c]) x.close()
})

test('resolving a resolved thread is ok: the first outcome stands, with one decision', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const { thread } = ok(await a.cmd('thread', { action: 'open', title: 'cache layout', with: ['claude-repo'] }))
  const first = ok(await a.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'One cache per repo.' }))
  assert.equal(first.alreadyResolved, undefined)
  const second = await b.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'One cache per worktree.' })
  assert.equal(second.ok, true, second.error)
  assert.deepEqual(Object.keys(second.result), ['thread', 'alreadyResolved'])
  assert.equal(second.result.alreadyResolved, true)
  assert.deepEqual(second.result.thread, first.thread, 'the thread as it was resolved')
  // Even without an outcome: there is nothing left to decide.
  assert.equal(ok(await b.cmd('thread', { action: 'resolve', thread: thread.id })).alreadyResolved, true)
  const msgs = room.snapshot().messages
  assert.deepEqual(texts(msgs.filter(m => m.kind === 'decision')), ['One cache per repo.'])
  assert.equal(msgs.filter(m => m.kind === 'sys' && m.text.includes('resolved')).length, 1)
  assert.equal((await b.cmd('thread', { action: 'resolve', thread: 'nope-00' })).error, 'unknown thread: nope-00')
  for (const x of [a, b]) x.close()
})

test('post title: the title of the thread a question opens; by default its first sentence, cut at a word', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const ask = async (text, extra = {}) => ok(await a.cmd('post', { kind: 'question', to: ['claude-repo'], text, ...extra })).thread
  let th = await ask('I am adding shout() to src/greeting.js. Can you keep the export names stable in your i18n change?')
  assert.equal(th.title, 'I am adding shout() to src/greeting.js')
  th = await ask('Cache layout\nShould it be one cache per repo, or per worktree?')
  assert.equal(th.title, 'Cache layout', 'the first line')
  th = await ask('Should token refresh live in src/auth.js or the client, given that we also need retries and backoff?')
  assert.equal(th.title, 'Should token refresh live in src/auth.js or the client…')
  assert.ok(Array.from(th.title).length <= 60)
  th = await ask('Does v1.2 of the API keep the /v1/greetings route stable?')
  assert.equal(th.title, 'Does v1.2 of the API keep the /v1/greetings route stable?', 'dots inside words end no sentence')
  th = await ask('Can you check ' + 'x'.repeat(70) + ' for me?')
  assert.equal(th.title, 'Can you check…')
  th = await ask('y'.repeat(70) + '?')
  assert.equal(th.title, 'y'.repeat(59) + '…', 'one long word is cut where it has to be')

  th = await ask('Can you keep greet() as it is? I build shout() on it.', { title: 'greet() stays' })
  assert.equal(th.title, 'greet() stays')
  assert.match(th.id, /^greet-stays-[0-9a-f]{2}$/)
  assert.equal(room.snapshot().messages.filter(m => m.kind === 'sys').at(-1).text, '🧵 copilot-repo opened “greet() stays” with claude-repo')

  // A bad title fails the post before anything happens; a title without a new thread is ignored.
  const threads = room.threads.size
  const seq = room.seq
  assert.equal((await a.cmd('post', { kind: 'question', to: ['claude-repo'], text: 'x?', title: 'x'.repeat(81) })).error, 'title too long (max 80 characters)')
  assert.equal((await a.cmd('post', { kind: 'question', to: ['claude-repo'], text: 'x?', title: 7 })).error, 'title must be a string')
  assert.equal((await a.cmd('post', { kind: 'question', to: ['claude-repo'], text: 'x?', title: 'password = Hunter2Hunter2' })).error, 'blocked: looks like a secret (credential assignment)')
  assert.deepEqual([room.threads.size, room.seq], [threads, seq])
  const note = ok(await a.cmd('post', { text: 'fyi', title: 'x'.repeat(200) }))
  assert.deepEqual([note.message.thread, note.thread], [null, undefined])
  for (const x of [a, b]) x.close()
})

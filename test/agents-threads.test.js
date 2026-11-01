import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

test('a question with `to` opens a thread automatically; thread open/resolve → sys + decision', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })

  const q = await a.cmd('post', { kind: 'question', text: 'Should token refresh live in src/auth.js or the client?', to: ['claude-repo'] })
  const { message, thread } = ok(q)
  assert.match(thread.id, /^should-token-refresh-[0-9a-f]{2}$/)
  assert.deepEqual({ ...thread, id: 0, openedAt: 0, lastAt: 0 }, { id: 0, title: 'Should token refresh live in src/auth.js or the client?', opener: 'copilot-repo', participants: ['copilot-repo', 'claude-repo'], status: 'open', outcome: null, messages: 1, openedAt: 0, lastAt: 0, owner: null, next: [], resolvedBy: null, resolvedAt: null })
  assert.equal(message.thread, thread.id)
  assert.equal(message.kind, 'question')
  const sys = room.snapshot().messages.filter(m => m.kind === 'sys' && m.text.startsWith('🧵')).at(-1)
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
  assert.deepEqual(Object.keys(second.result), ['thread', 'alreadyResolved', 'record'])
  assert.equal(second.result.record, first.record, 'the record of the first resolve')
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

const until = async (fn, label, ms = 5000) => {
  for (const end = Date.now() + ms; !fn();) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(10)
  }
}
const localDay = (ms) => { const d = new Date(ms); return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-') }
const decisionsIn = (room) => room.snapshot().messages.filter(m => m.kind === 'decision')

test('resolve with an owner and next steps: the thread fields, the decision message, and its record', async (t) => {
  let clock = 1_793_000_000_000
  const { room } = await start(t, { now: () => clock, limits: { resumeMs: 30 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  const { thread } = ok(await a.cmd('thread', { action: 'open', title: 'auth token refresh', with: ['claude-repo'] }))
  assert.deepEqual(Object.keys(thread).slice(-4), ['owner', 'next', 'resolvedBy', 'resolvedAt'])
  assert.deepEqual([thread.owner, thread.next, thread.resolvedBy, thread.resolvedAt], [null, [], null, null], 'open')
  ok(await b.cmd('post', { thread: thread.id, text: 'client, behind a lock' }))

  // Bad owners and next steps fail, and the thread stays open.
  const resolve = (args) => b.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'Refresh lives in the client, behind a lock.', ...args })
  assert.equal((await resolve({ owner: 'nobody' })).error, 'unknown agent: nobody')
  assert.equal((await resolve({ owner: ['copilot-repo'] })).error, 'owner must be an agent name')
  assert.equal((await resolve({ next: 'do it' })).error, 'next must be a list of strings')
  assert.equal((await resolve({ next: ['1', '2', '3', '4', '5', '6'] })).error, 'next has too many entries (max 5)')
  assert.equal((await resolve({ next: ['x'.repeat(141)] })).error, 'next entries are at most 140 characters')
  assert.equal((await resolve({ next: ['set password = Hunter2Hunter2'] })).error, 'blocked: looks like a secret (credential assignment)')
  const gone = await agent({ harness: 'gemini' })
  gone.close()
  await until(() => room.snapshot().messages.some(m => m.text === 'gemini-repo left'), 'gemini-repo left')
  assert.equal((await resolve({ owner: 'gemini-repo' })).error, 'gemini-repo left the room')
  assert.equal(ok(await a.cmd('thread', { action: 'list' })).threads[0].status, 'open')
  assert.equal(decisionsIn(room).length, 0)

  clock += 60_000
  const r = ok(await resolve({ owner: '@copilot-repo', next: ['Move the retry into src/client.js', '  ', 'Drop the server-side refresh'] }))
  assert.deepEqual(Object.keys(r), ['thread', 'record'])
  const next = ['Move the retry into src/client.js', 'Drop the server-side refresh']
  assert.deepEqual([r.thread.status, r.thread.owner, r.thread.next, r.thread.resolvedBy, r.thread.resolvedAt], ['resolved', 'copilot-repo', next, 'claude-repo', clock])
  assert.equal(r.record, [
    '### Decision: auth token refresh',
    '',
    '> Refresh lives in the client, behind a lock.',
    '',
    '- **Owner:** copilot-repo',
    '- **Next steps:**',
    '  - [ ] Move the retry into src/client.js',
    '  - [ ] Drop the server-side refresh',
    '- **Participants:** copilot-repo, claude-repo',
    `- **Decided:** ${localDay(clock)}, in the autochat agent room (thread \`${thread.id}\`)`
  ].join('\n'))
  // The decision message carries the owner, the next steps, and who has seen it: so far, its author.
  const [decision] = decisionsIn(room)
  assert.equal(Object.keys(decision).at(-1), 'decision')
  assert.deepEqual(decision.decision, { owner: 'copilot-repo', next, seenBy: ['claude-repo'] })
  assert.deepEqual(ok(await a.cmd('thread', { action: 'list' })).threads[0], r.thread)

  // By default whoever resolves owns it; a multi-line outcome is quoted line by line.
  const other = ok(await c.cmd('thread', { action: 'open', title: 'cache layout' })).thread
  const r2 = ok(await c.cmd('thread', { action: 'resolve', thread: other.id, outcome: 'One cache per repo.\n\nKeyed by worktree.' }))
  assert.deepEqual([r2.thread.owner, r2.thread.resolvedBy, r2.thread.next], ['codex-repo', 'codex-repo', []])
  assert.ok(r2.record.includes('\n> One cache per repo.\n>\n> Keyed by worktree.\n\n- **Owner:** codex-repo\n- **Next steps:** none\n- **Participants:** codex-repo\n'), r2.record)
  assert.deepEqual(decisionsIn(room)[1].decision, { owner: 'codex-repo', next: [], seenBy: ['codex-repo'] })
  // A `decision` posted with `post` has no decision field.
  const posted = ok(await a.cmd('post', { kind: 'decision', text: 'Tabs, not spaces.' })).message
  assert.equal(posted.decision, undefined)
  for (const x of [a, b, c]) x.close()
})

test('seenBy: whoever resolved, then each agent that catchUp, read or wait returns the decision to', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 30, lingerMs: 60 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  const d = await agent({ harness: 'gemini' })
  const { thread } = ok(await a.cmd('thread', { action: 'open', title: 'naming', with: ['claude-repo'] }))
  const waiting = c.cmd('wait', { timeoutMs: 5000 })
  await sleep(30)
  ok(await a.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'Call it cache.' }))
  const seenBy = () => decisionsIn(room)[0].decision.seenBy
  const waited = ok(await waiting)
  assert.deepEqual(waited.messages.map(m => m.decision.seenBy), [['copilot-repo', 'codex-repo']], 'wait; the reader is in it already')
  assert.deepEqual(ok(await b.cmd('read')).messages.at(-1).decision.seenBy, ['copilot-repo', 'codex-repo', 'claude-repo'], 'read')
  ok(await d.cmd('catchUp'))
  assert.deepEqual(seenBy(), ['copilot-repo', 'codex-repo', 'claude-repo', 'gemini-repo'], 'catchUp')
  ok(await b.cmd('read', { thread: thread.id }))
  ok(await a.cmd('read', { scope: 'all', since: 0 }))
  assert.deepEqual(seenBy().length, 4, 'once each, the author included')

  // A newcomer gets it from catchUp's decisions; the names stay after their agents have gone.
  for (const x of [a, b]) x.close()
  await until(() => !room.agents.has(a.welcome.agent.id) && !room.agents.has(b.welcome.agent.id), 'a and b gone, not just away')
  const e = await agent({ harness: 'pi' })
  const caught = ok(await e.cmd('catchUp'))
  assert.deepEqual(caught.decisions.map(m => [m.text, m.from.name, m.decision.seenBy]), [['Call it cache.', 'copilot-repo', ['copilot-repo', 'codex-repo', 'claude-repo', 'gemini-repo', 'pi-repo']]])
  assert.deepEqual(caught.threads.map(x => [x.owner, x.resolvedBy, x.participants]), [['copilot-repo', 'copilot-repo', ['copilot-repo', 'claude-repo']]])
  for (const x of [c, d, e]) x.close()
})

test('decisions outlive their agents: catchUp.relevant has the ones whose thread focus overlaps yours', async (t) => {
  const { room } = await start(t, { limits: { decisions: 1, relevant: 2, resumeMs: 30, lingerMs: 60 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  const early = await agent({ harness: 'early' })
  ok(await a.cmd('status', { focus: { paths: ['src/auth.js'], components: ['Auth'] } }))
  ok(await b.cmd('status', { focus: { issue: 12 } }))
  ok(await c.cmd('status', { focus: { paths: ['src/ui.js'] } }))
  ok(await early.cmd('status', { focus: { paths: ['src/auth.js'] } }))
  ok(await early.cmd('catchUp'))
  const decide = async (who, title, outcome, extra = {}) => {
    const { thread } = ok(await who.cmd('thread', { action: 'open', title, ...extra }))
    return ok(await who.cmd('thread', { action: 'resolve', thread: thread.id, outcome })).thread
  }
  await decide(a, 'token format', 'JWTs, not opaque tokens.')
  await decide(a, 'refresh', 'Refresh lives in the client.', { with: ['claude-repo'] })
  await decide(c, 'buttons', 'Primary buttons are blue.')
  await decide(c, 'icons', 'SF Symbols only.')
  // Everyone who decided has gone; their focus stays with their threads.
  for (const x of [a, b, c]) x.close()
  await until(() => room.agents.size === 1, 'a, b and c gone')

  const relevantTo = async (harness, focus, hello = {}) => {
    const n = await agent({ harness, ...hello })
    if (focus) ok(await n.cmd('status', { focus }))
    const r = ok(await n.cmd('catchUp'))
    n.close()
    return r
  }
  let r = await relevantTo('paths', { paths: ['src/auth.js'] })
  assert.deepEqual(texts(r.relevant), ['JWTs, not opaque tokens.', 'Refresh lives in the client.'], 'posted before it joined, oldest first')
  assert.deepEqual(texts(r.decisions), ['SF Symbols only.'], 'the last decision is in decisions, not repeated in relevant')
  assert.deepEqual(r.relevant.map(m => [m.from.name, m.decision.owner, m.decision.seenBy.at(-1)]), [['copilot-repo', 'copilot-repo', 'paths-repo'], ['copilot-repo', 'copilot-repo', 'paths-repo']])
  assert.deepEqual(texts((await relevantTo('issue', { issue: 12 })).relevant), ['Refresh lives in the client.'], "the participants' issues")
  assert.deepEqual(texts((await relevantTo('comp', { components: ['auth'] })).relevant), ['JWTs, not opaque tokens.', 'Refresh lives in the client.'], 'components, case-insensitively')
  assert.deepEqual(texts((await relevantTo('dir', { paths: ['src'] })).relevant), ['Refresh lives in the client.', 'Primary buttons are blue.'], 'at most `relevant` (here 2): the newest')
  assert.deepEqual((await relevantTo('nofocus')).relevant, [], 'no focus, nothing overlaps')
  assert.deepEqual((await relevantTo('elsewhere', { paths: ['src/auth.js'] }, { repo: 'owner/other' })).relevant, [], 'another repo')

  // An agent that was here has the decisions in its inbox: catchUp doesn't repeat them in relevant,
  // but shows them there later, once they're read.
  r = ok(await early.cmd('catchUp'))
  assert.deepEqual(texts(r.inbox.filter(m => m.kind === 'decision')), ['JWTs, not opaque tokens.', 'Refresh lives in the client.', 'Primary buttons are blue.', 'SF Symbols only.'])
  assert.deepEqual([r.relevant, r.decisions], [[], []])
  r = ok(await early.cmd('catchUp'))
  assert.deepEqual(texts(r.relevant), ['JWTs, not opaque tokens.', 'Refresh lives in the client.'])
  early.close()
})

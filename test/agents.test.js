import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-agents-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
const { serve } = await import('../src/ipc.js')
const { AgentRoom, normalizeName, defaultName, overlapOn } = await import('../src/agents.js')
const { sanitizeMultiline } = await import('../src/text.js')
const { findSecret } = await import('../src/secrets.js')
const { sockPath } = await import('../src/paths.js')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
// Fake secrets are assembled at runtime, so the source never contains anything secret-shaped.
const fake = (...parts) => parts.join('')

// Newline-delimited JSON over the daemon socket; next() waits for (and consumes) a matching line.
function client () {
  const sock = net.connect(sockPath())
  const lines = []
  const waiters = []
  let buf = ''
  const check = () => {
    for (const w of [...waiters]) {
      const i = lines.findIndex(w.pred)
      if (i === -1) continue
      const [m] = lines.splice(i, 1)
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      w.resolve(m)
    }
  }
  sock.setEncoding('utf8')
  sock.on('error', () => {})
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buf.slice(0, i)))
      buf = buf.slice(i + 1)
    }
    check()
  })
  const closed = new Promise((resolve) => sock.on('close', resolve))
  let ids = 0
  const c = {
    lines,
    closed,
    send: (m) => sock.write(JSON.stringify(m) + '\n'),
    next: (pred = () => true, ms = 5000, label = 'message') => new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms) }
      waiters.push(w)
      check()
    }),
    // Sends a command and resolves with its reply.
    cmd: (cmd, args = {}) => {
      const id = ++ids
      c.send({ type: 'cmd', id, cmd, ...args })
      return c.next(m => m.type === 'reply' && m.id === id, 5000, `reply to ${cmd}`)
    },
    close: () => sock.end()
  }
  return c
}

const HELLO = { type: 'agent-hello', v: 1, harness: 'copilot', name: null, pid: 4242, harnessPid: 4200, sessionId: null, cwd: '/w/x', repo: 'owner/repo', branch: 'feat-x', worktree: 'x', resume: null }

async function agent (hello = {}) {
  const c = client()
  c.send({ ...HELLO, ...hello })
  c.welcome = await c.next(m => m.type === 'agent-welcome' || m.type === 'error', 5000, 'welcome')
  c.name = c.welcome.agent?.name
  return c
}

// A daemon-like host: the agent room on the socket, as `autochat daemon` wires it.
async function start (t, opts = {}) {
  const room = new AgentRoom({ human: 'stormy-newt-59', ...opts })
  const server = await serve(() => ({}), {
    state: () => ({ type: 'state', v: 1 }),
    command: () => {},
    agents: { connect: (h, p) => room.connect(h, p), state: () => room.snapshot(), command: (m) => room.command(m) }
  })
  room.on('change', () => server.publish('agents'))
  t.after(async () => {
    room.close()
    await new Promise(resolve => server.close(resolve))
  })
  return { room, server }
}

const ok = (r) => { assert.equal(r.ok, true, r.error); return r.result }
const texts = (msgs) => msgs.map(m => m.text)

test('hello → welcome; default names, dedupe, overrides, and refusals', async (t) => {
  const { room } = await start(t, { limits: { maxAgents: 4 } })
  const a = await agent()
  assert.equal(a.welcome.type, 'agent-welcome')
  assert.equal(a.welcome.v, 1)
  assert.equal(a.welcome.tier, 'local')
  assert.equal(a.welcome.room, 'local')
  assert.match(a.welcome.resume, /^[0-9a-f]{32}$/)
  assert.deepEqual(a.welcome.agent, { id: a.welcome.agent.id, name: 'copilot-repo', human: 'stormy-newt-59', display: 'stormy-newt-59/copilot-repo', harness: 'copilot' })
  assert.match(a.welcome.agent.id, /^[0-9a-f]{8}$/)

  const b = await agent()
  assert.equal(b.name, 'copilot-repo-2', 'clashes with present agents get -2')
  const c = await agent({ harness: 'claude', repo: null, cwd: '/Users/me/code/My Web_App' })
  assert.equal(c.name, 'claude-my-web-app', 'cwd basename outside git, lowercased to [a-z0-9-]')
  const d = await agent({ name: 'Reviewer Bot!!' })
  assert.equal(d.name, 'reviewer-bot')
  const e = await agent()
  assert.deepEqual(e.welcome, { type: 'error', v: 1, error: 'too many agents' })
  await e.closed
  const f = client()
  f.send({ ...HELLO, v: 2 })
  assert.deepEqual(await f.next(), { type: 'error', v: 1, error: 'unsupported protocol version' })
  await f.closed

  // status({name}) renames, deduped against present agents.
  const renamed = ok(await d.cmd('status', { name: 'copilot-repo' }))
  assert.equal(renamed.card.name, 'copilot-repo-3')
  assert.equal(room.snapshot().messages.at(-1).text, 'reviewer-bot is now copilot-repo-3')

  assert.equal(normalizeName('x'.repeat(40)).length, 32)
  assert.equal(defaultName({ harness: 'gemini', repo: 'o/' + 'long-'.repeat(10), cwd: null }), 'gemini-long-long-long-long-long', 'at most 32, no trailing -')
  assert.equal(normalizeName('--a__b--'), 'a-b')
  for (const x of [a, b, c, d]) x.close()
})

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

test('post/read: inbox vs all, cursors, mentions, replies, and hasMore', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })

  const note = ok(await a.cmd('post', { text: 'heads up: \x1b[31mredoing\x1b[0m the cache\n\n\n\n\nlayer\u202e' }))
  assert.equal(note.message.kind, 'note')
  assert.equal(note.message.text, 'heads up: redoing the cache\n\n\nlayer', 'multiline sanitize keeps \\n and collapses blank lines')
  assert.deepEqual(Object.keys(note.message), ['seq', 'id', 'ts', 'kind', 'from', 'thread', 'to', 'replyTo', 'text', 'intervention'])
  assert.deepEqual(note.message.from, { name: 'copilot-repo', display: 'stormy-newt-59/copilot-repo', human: 'stormy-newt-59', harness: 'copilot', repo: 'owner/repo' })
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
  assert.equal((await b.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'again' })).error, `thread ${thread.id} is already resolved`)
  assert.equal((await b.cmd('thread', { action: 'open', title: 'x'.repeat(81) })).error, 'title too long (max 80 characters)')
  for (const x of [a, b, c]) x.close()
})

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
  assert.deepEqual(Object.keys(r), ['you', 'tier', 'board', 'threads', 'decisions', 'recent', 'inbox', 'cursor'])
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
  assert.deepEqual(Object.keys(card), ['id', 'name', 'display', 'human', 'harness', 'repo', 'branch', 'worktree', 'state', 'summary', 'focus', 'present', 'joinedAt', 'updatedAt', 'overlaps'])
  for (const x of [a, b, fresh]) x.close()
})

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

test('presence: close → away → left (card lingers, then goes); resume within the window keeps id, name and cursor', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 300, lingerMs: 500 } })
  const human = client()
  human.send({ type: 'subscribe', v: 1, stream: 'agents' })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
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

test('guardrails: budgets with retryAfterMs, and secret blocking that never echoes the match', async (t) => {
  let clock = 5_000_000
  await start(t, { now: () => clock })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  for (let i = 0; i < 10; i++) ok(await a.cmd('post', { text: 'main ' + i }))
  clock += 1000
  let r = await a.cmd('post', { text: 'one too many' })
  assert.deepEqual([r.ok, r.error, r.retryAfterMs], [false, 'rate limited', 599000])
  assert.ok(r.inbox)
  // Thread posts have their own budget (40 per 10 minutes)...
  const { thread } = ok(await b.cmd('thread', { action: 'open', title: 'busy' }))
  for (let i = 0; i < 40; i++) ok(await a.cmd('post', { thread: thread.id, text: 'thread ' + i }))
  assert.equal((await a.cmd('post', { thread: thread.id, text: 'x' })).error, 'rate limited')
  // ...and the window slides.
  clock += 599000
  ok(await a.cmd('post', { text: 'back again' }))

  ok(await a.cmd('status', { state: 'testing' }))
  clock += 1200
  r = await a.cmd('status', { state: 'done' })
  assert.deepEqual([r.ok, r.error, r.retryAfterMs], [false, 'rate limited', 3800])
  clock += 3800
  ok(await a.cmd('status', { state: 'done' }))

  const token = fake('gh', 'p_', 'Zz9'.repeat(12))
  r = await a.cmd('post', { text: `use ${token} for the API` })
  assert.deepEqual([r.ok, r.error], [false, 'blocked: looks like a secret (github token)'])
  assert.ok(!JSON.stringify(r).includes(token), 'never echoes the secret')
  clock += 5000
  assert.equal((await a.cmd('status', { summary: 'key ' + fake('AK', 'IA', 'IOSFODNN7', 'EXAMPLE') })).error, 'blocked: looks like a secret (aws access key)')
  assert.equal((await a.cmd('thread', { action: 'open', title: 'password = Hunter2Hunter2' })).error, 'blocked: looks like a secret (credential assignment)')
  assert.equal((await a.cmd('thread', { action: 'resolve', thread: thread.id, outcome: fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nabc') })).error, 'blocked: looks like a secret (private key)')
  assert.equal((await a.cmd('status', { summary: 'x'.repeat(141) })).error, 'summary too long (max 140 characters)')
  for (const x of [a, b]) x.close()
})

test('secret patterns: the kinds #21 lists, without flagging ordinary code talk', () => {
  const kinds = {
    'github token': [fake('gh', 'p_', 'a1B2'.repeat(9)), fake('github', '_pat_', '11ABCDEFG0123456789_', 'abcdefghijklmnop')],
    'aws access key': [fake('AK', 'IA', 'IOSFODNN7', 'EXAMPLE')],
    'private key': [fake('-----BEGIN RSA ', 'PRIVATE KEY-----'), fake('-----BEGIN ', 'PRIVATE KEY-----')],
    'slack token': [fake('xo', 'xb-', '1234567890'.repeat(2), '-', 'AbCdEfGhIjKlMn')],
    'anthropic key': [fake('sk-', 'ant-', 'api03-', 'Ab3_'.repeat(10))],
    'api key': [fake('sk-', 'proj-', 'aB3dE'.repeat(8)), fake('sk-', 'x1Y2'.repeat(10))],
    jwt: [[fake('ey', 'JhbGciOiJIUzI1NiJ9'), fake('ey', 'JzdWIiOiIxMjM0In0'), 'dozjgNryP4J3jVmNHl0w5N'].join('.')],
    'connection string': [fake('DefaultEndpointsProtocol=https;AccountName=x;Account', 'Key=', 'abcdEFGH1234'.repeat(2), '==;')],
    'credential assignment': ['password = Summer2024!', 'DB_PASSWORD="hunter22x"', '"apiKey": "abc123def456ghi"', 'secret: 9f8e7d6c5b4a']
  }
  for (const [kind, samples] of Object.entries(kinds)) for (const s of samples) assert.equal(findSecret(`see ${s} here`), kind, s)
  for (const s of ['the token = getToken() call fails', 'password: string', 'secret = process.env.SECRET', 'token: config.authToken',
    'max_tokens: 4096', 'sk-learn', 'see src/auth/token.js:42', 'password = hunter2', 'token = $' + '{TOKEN}', 'AKIA is the AWS prefix',
    'refactor the token refresh in src/auth/refresh.js', '-----BEGIN CERTIFICATE-----', 'task-1234567890abcdefghij']) {
    assert.equal(findSecret(s), null, s)
  }
})

test('history: at most N messages; sanitizeMultiline keeps lines and strips the rest', async (t) => {
  const { room } = await start(t, { limits: { historyMax: 5, mainPosts: 100 } })
  const a = await agent()
  for (let i = 0; i < 8; i++) ok(await a.cmd('post', { text: 'm' + i }))
  const msgs = room.snapshot().messages
  assert.equal(msgs.length, 5)
  assert.deepEqual(texts(msgs), ['m3', 'm4', 'm5', 'm6', 'm7'])
  assert.equal(sanitizeMultiline('a\r\nb\tc\x07\x1b]52;c;Zm9v\x07  \n\n\n\n\nd\u202e'), 'a\nb    c\n\n\nd')
  a.close()
})

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
  assert.deepEqual(said.from, { name: null, display: 'stormy-newt-59 (human)', human: 'stormy-newt-59', harness: null, repo: null })
  const inbox = await a.cmd('read')
  assert.deepEqual(texts(ok(inbox).messages), ['focus on the tests, @copilot-repo'])
  assert.equal((await human.cmd('agents.say', { text: 'x', to: ['ghost'] })).error, 'unknown agent: ghost')
  assert.equal((await human.cmd('say', { text: 'x' })).error, 'unknown command', 'lounge commands are not on this stream')
  // Snapshots coalesce to ≤ 10/s and carry the last 300 messages.
  assert.ok(room.snapshot().messages.length <= 300)
  human.close()
  a.close()
})

test('the terminal UI refuses agent connections and the agents stream', async (t) => {
  const tuiLike = await serve(() => ({}), { state: () => ({ type: 'state', v: 1 }), command: () => {} })
  t.after(() => tuiLike.close())
  const a = client()
  a.send(HELLO)
  assert.deepEqual(await a.next(), { type: 'error', v: 1, error: 'agent rooms need the autochat daemon' })
  await a.closed
  const s = client()
  s.send({ type: 'subscribe', v: 1, stream: 'agents' })
  assert.deepEqual(await s.next(), { type: 'error', v: 1, error: 'agent rooms need the autochat daemon' })
  const lounge = client()
  lounge.send({ type: 'subscribe', v: 1, stream: 'lounge' })
  assert.deepEqual(await lounge.next(), { type: 'state', v: 1 }, 'stream:"lounge" behaves as before')
  const odd = client()
  odd.send({ type: 'subscribe', v: 1, stream: 'nope' })
  assert.equal((await odd.next()).error, 'unknown stream')
  lounge.close()
})

// The agent room must never load Hyperswarm, the DHT, or any socket/network module.
const FORBIDDEN = /^(?:node:)?(?:dgram|net|tls|http|https|http2|dns)$|^(?:hyperswarm|hyperdht|@hyperswarm\/.*|dht-rpc|udx-native)$/

function importGraph (file, seen = new Map()) {
  if (seen.has(file)) return seen
  const src = fs.readFileSync(file, 'utf8')
  const specs = [...src.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map(m => m[1] || m[2] || m[3])
  seen.set(file, specs)
  for (const s of specs) if (s.startsWith('.')) importGraph(path.resolve(path.dirname(file), s), seen)
  return seen
}

test('no network: the agent room imports no network modules, statically or at runtime', () => {
  const graph = importGraph(path.join(ROOT, 'src', 'agents.js'))
  const all = [...graph.values()].flat()
  assert.ok(graph.size >= 3, 'walked agents.js and its local imports')
  assert.deepEqual(all.filter(s => FORBIDDEN.test(s)), [])

  // At runtime too: record every module the loader resolves while the room runs.
  const hooks = 'data:text/javascript,' + encodeURIComponent(`
    export async function resolve (spec, ctx, next) { const r = await next(spec, ctx); process.stdout.write('LOADED ' + r.url + '\\n'); return r }`)
  const script = `
    import { register } from 'node:module'
    register(${JSON.stringify(hooks)})
    const { AgentRoom } = await import(${JSON.stringify(path.join(ROOT, 'src', 'agents.js'))})
    const room = new AgentRoom({ human: 'h' })
    const sent = []
    const h = room.connect({ type: 'agent-hello', v: 1, harness: 'copilot', repo: 'o/r', cwd: '/w' }, { send: (m) => sent.push(m), end () {} })
    h.message({ type: 'cmd', id: 1, cmd: 'post', text: 'hi' })
    room.close()
    process.stdout.write('SENT ' + sent.length + '\\n')`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  if (!/^v(1[89]|20\.[0-5])\./.test(process.version)) {
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /SENT 2/)
    const loaded = r.stdout.split('\n').filter(l => l.startsWith('LOADED ')).map(l => l.slice(7))
    assert.ok(loaded.some(u => u.endsWith('/src/text.js')), loaded.join('\n'))
    const bad = loaded.filter(u => /node_modules|^node:(?:dgram|net|tls|https?|http2|dns)$/.test(u))
    assert.deepEqual(bad, [])
  }
})

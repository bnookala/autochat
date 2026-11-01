import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, HELLO, agent, start, ok, fake, sleep } from './helpers/agents.js'
const { normalizeName, defaultName } = await import('../src/agents.js')
const { stripIds, slug, cleanTitle, defaultTitle, dedupeName } = await import('../src/agents/names.js')

// Default names and titles: tests that are about them pass `name: null` (see the helper).
const named = (hello = {}) => agent({ name: null, ...hello })

test('hello → welcome; default names, dedupe, overrides, and refusals', async (t) => {
  const { room } = await start(t, { limits: { maxAgents: 4 } })
  const a = await named()
  assert.equal(a.welcome.type, 'agent-welcome')
  assert.equal(a.welcome.v, 1)
  assert.equal(a.welcome.tier, 'local')
  assert.equal(a.welcome.room, 'local')
  assert.match(a.welcome.resume, /^[0-9a-f]{32}$/)
  assert.deepEqual(a.welcome.agent, { id: a.welcome.agent.id, name: 'repo-feat-x', human: 'stormy-newt-59', display: 'repo@feat-x', harness: 'copilot', title: 'repo@feat-x' })
  assert.match(a.welcome.agent.id, /^[0-9a-f]{8}$/)

  const b = await named()
  assert.equal(b.name, 'repo-feat-x-2', 'the name already ends with the branch: -2')
  const c = await named({ harness: 'claude', repo: null, cwd: '/Users/me/code/My Web_App' })
  assert.equal(c.name, 'my-web-app', 'cwd basename outside git, lowercased to [a-z0-9-]')
  assert.equal(c.welcome.agent.title, 'My Web_App')
  const d = await named({ name: 'Reviewer Bot!!' })
  assert.equal(d.name, 'reviewer-bot')
  // maxAgents counts active agents (board.md): once all four have spoken, a fifth is refused.
  for (const x of [a, b, c, d]) ok(await x.cmd('post', { text: 'here' }))
  const e = await named()
  assert.deepEqual(e.welcome, { type: 'error', v: 1, error: 'too many agents' })
  await e.closed
  const f = client()
  f.send({ ...HELLO, v: 2 })
  assert.deepEqual(await f.next(), { type: 'error', v: 1, error: 'unsupported protocol version' })
  await f.closed

  // status({name}) renames, deduped against present agents: the branch first, then -2.
  const renamed = ok(await d.cmd('status', { name: 'repo-feat-x' }))
  assert.equal(renamed.card.name, 'repo-feat-x-3')
  assert.equal(room.snapshot().messages.at(-1).text, 'reviewer-bot is now repo-feat-x-3')
  assert.equal(ok(await c.cmd('status', { name: 'reviewer-bot' })).card.name, 'reviewer-bot', 'a name freed by a rename')

  assert.equal(normalizeName('x'.repeat(40)).length, 32)
  assert.equal(defaultName({ harness: 'gemini', repo: 'o/' + 'long-'.repeat(10), cwd: null }), 'long-long-long-long-long-long', 'at most 32, cut between words')
  assert.equal(normalizeName('--a__b--'), 'a-b')
  for (const x of [a, b, c, d]) x.close()
})

test('titles: the session title, else <repo>@<branch>, else the cwd without ids, else the harness', async (t) => {
  const { room } = await start(t)
  const titled = await named({ title: 'Lolchat macos menu bar app' })
  assert.deepEqual([titled.name, titled.welcome.agent.title, titled.welcome.agent.display], ['lolchat-macos-menu-bar-app', 'Lolchat macos menu bar app', 'Lolchat macos menu bar app'])
  const repoOnly = await named({ branch: null })
  assert.deepEqual([repoOnly.name, repoOnly.welcome.agent.title], ['repo', 'repo'], 'no branch: the repo name')
  const uuid = await named({ repo: null, branch: null, cwd: '/Users/me/.copilot/session-state/66baac0b-fe30-4cb0-8411-0123456789ab' })
  assert.deepEqual([uuid.name, uuid.welcome.agent.title], ['copilot', 'copilot'], 'a UUID folder: the harness id')
  const hexed = await named({ harness: 'claude', repo: null, branch: null, cwd: '/Users/me/code/probable-train-5dedd1b6' })
  assert.deepEqual([hexed.name, hexed.welcome.agent.title], ['probable-train', 'probable-train'])

  // A card: title and parent (names.js), and display is the title, with no human/ prefix.
  const card = room.snapshot().agents.find(c => c.id === titled.welcome.agent.id)
  assert.deepEqual([card.display, card.human, card.title, card.parent], ['Lolchat macos menu bar app', 'stormy-newt-59', 'Lolchat macos menu bar app', null])
  // message.from carries the title.
  const posted = ok(await titled.cmd('post', { text: 'hi' }))
  assert.deepEqual([posted.message.from.name, posted.message.from.display, posted.message.from.title], ['lolchat-macos-menu-bar-app', 'Lolchat macos menu bar app', 'Lolchat macos menu bar app'])

  // A title that looks like a secret is dropped; one that's all ids too.
  const secret = await named({ title: fake('ghp_', 'a'.repeat(36)), branch: 'main' })
  assert.deepEqual([secret.name, secret.welcome.agent.title], ['repo-main', 'repo@main'])
  const ids = await named({ title: '66baac0b-fe30-4cb0-8411-0123456789ab', branch: 'dev' })
  assert.equal(ids.welcome.agent.title, 'repo@dev')
  const long = await named({ title: 'x '.repeat(100) + '\x1b[31mred', branch: 'long' })
  assert.equal(Array.from(long.welcome.agent.title).length, 80, 'at most 80 characters')
  assert.match(long.welcome.agent.title, /…$/)
  for (const x of [titled, repoOnly, uuid, hexed, secret, ids, long]) x.close()
})

test('names: a slug of the title, at most 32, cut between words; collisions get the branch, then -2', async (t) => {
  await start(t)
  const title = 'Fix the login redirect loop in the web app'
  const a = await named({ title, branch: 'main' })
  assert.equal(a.name, 'fix-the-login-redirect-loop-in')
  const b = await named({ title, branch: 'copilot/i18n-strings' })
  assert.equal(b.name, 'fix-the-login-copilot-i18n', 'the branch slug, cut to fit')
  const c = await named({ title, branch: 'copilot/i18n-strings' })
  assert.equal(c.name, 'fix-the-login-redirect-loop-in-2')
  const d = await named({ title: 'Café Menü', branch: null })
  assert.equal(d.name, 'cafe-menu', 'accents folded')
  const e = await named({ title: '日本語のタスク', branch: 'main' })
  assert.deepEqual([e.name, e.welcome.agent.title], ['repo-main', '日本語のタスク'], 'a title with no slug: the next candidate names it')
  // An explicit name still wins: the hello's (AUTOCHAT_AGENT_NAME), or status({name}).
  const f = await named({ title, name: 'reviewer' })
  assert.deepEqual([f.name, f.welcome.agent.title], ['reviewer', title])
  for (const x of [a, b, c, d, e, f]) x.close()

  assert.equal(slug('Lolchat macos menu bar app and more stuff'), 'lolchat-macos-menu-bar-app-and')
  assert.equal(slug('x'.repeat(40)), 'x'.repeat(32), 'one long word is cut')
  assert.equal(dedupeName('autochat-main', new Set(['autochat-main']), 'main'), 'autochat-main-2')
  assert.equal(dedupeName('fix', new Set(['fix']), 'feat/0123abcd4567-login'), 'fix-feat-login')
  assert.equal(dedupeName('fix', new Set(['fix', 'fix-main']), 'main'), 'fix-2')
})

test('ID-like tokens (UUIDs, runs of 8+ hex characters) never reach a title or a name', async (t) => {
  const { room } = await start(t)
  const UUID = '66baac0b-fe30-4cb0-8411-0123456789ab'
  const ID = /[0-9a-f]{8}/i
  const hellos = [
    { title: `copilot-${UUID}`, cwd: `/x/${UUID}` },
    { title: 'Session 5dedd1b6 for review', repo: 'o/0123456789abcdef', branch: 'copilot/fix-deadbeef42' },
    { title: null, repo: null, branch: null, cwd: '/w/effective-broccoli-8c9d8366' },
    { title: null, repo: 'o/web-1a2b3c4d5e6f', branch: `run-${UUID.slice(0, 23)}` },
    { title: null, repo: null, branch: null, cwd: '/w/ABCDEF0123456789', harness: 'codex' },
    { name: `copilot-${UUID}`, title: 'cafebabe' }
  ]
  const agents = []
  for (const h of hellos) agents.push(await named(h))
  const cards = room.snapshot().agents
  assert.deepEqual(cards.map(c => [c.name, c.title]), [
    ['copilot', 'copilot'],
    ['session-for-review', 'Session for review'],
    ['effective-broccoli', 'effective-broccoli'],
    ['web-run', 'web@run'],
    ['codex', 'codex'],
    ['copilot-feat-x', 'repo@feat-x']
  ])
  for (const c of cards) {
    assert.doesNotMatch(c.name, ID)
    assert.doesNotMatch(c.title, ID)
    assert.doesNotMatch(c.display, ID)
  }
  const [a] = agents
  assert.equal(ok(await a.cmd('status', { title: `Review ${UUID} and deadbeefcafe` })).card.title, 'Review and')
  assert.equal(ok(await agents[1].cmd('status', { name: 'helper-0123456789' })).card.name, 'helper')

  // Long input stays cheap (the separators before an id would backtrack) and isn't echoed back.
  const t0 = Date.now()
  assert.equal(stripIds(' -'.repeat(500000) + 'x'), '')
  assert.equal((await a.cmd('post', { text: 'hi', to: [' '.repeat(200000) + 'x'] })).error, 'unknown agent: x')
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(stripIds('effective-broccoli-8c9d8366'), 'effective-broccoli')
  assert.equal(stripIds(`${UUID}-x`), 'x')
  assert.equal(stripIds('fix 0123456789 now'), 'fix now')
  assert.equal(stripIds('v1.0.105 at 2026-11-01'), 'v1.0.105 at 2026-11-01', 'short hex runs stay')
  assert.equal(cleanTitle(UUID), null)
  assert.equal(defaultTitle({ helloTitle: null, repo: null, branch: null, cwd: '/', harness: 'pi' }), 'pi')
  for (const x of agents) x.close()
})

test('status: title and parent; a child names the agent that started it', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 0, resumeMs: 30, lingerMs: 30 } })
  const lead = await named({ title: 'P1 coordinator', branch: 'main' })
  const kid = await named({ title: 'Names and scale', branch: 'p1/66-names' })
  const grandkid = await named({ title: 'Docs pass', branch: 'p1/66-names' })
  // title: up to 80, ids stripped; "" restores the default; null changes nothing.
  let card = ok(await kid.cmd('status', { title: 'Readable agent names' })).card
  assert.deepEqual([card.title, card.display, card.name], ['Readable agent names', 'Readable agent names', 'names-and-scale'], 'the name stays: rename with status({name})')
  assert.equal(ok(await kid.cmd('status', { title: null, summary: 's' })).card.title, 'Readable agent names')
  assert.equal(ok(await kid.cmd('status', { title: '' })).card.title, 'Names and scale')
  assert.equal((await kid.cmd('status', { title: 'x'.repeat(81) })).error, 'title too long (max 80 characters)')
  assert.equal((await kid.cmd('status', { title: 7 })).error, 'title must be a string')
  assert.match((await kid.cmd('status', { title: fake('AKIA', 'IOSFODNN7EXAMPLE') })).error, /^blocked: looks like a secret/)

  // parent: the name of an agent in the room.
  card = ok(await kid.cmd('status', { parent: 'p1-coordinator' })).card
  assert.equal(card.parent, 'p1-coordinator')
  ok(await grandkid.cmd('status', { parent: '@names-and-scale' }))
  assert.equal((await kid.cmd('status', { parent: 'nobody' })).error, 'unknown agent: nobody')
  assert.equal((await kid.cmd('status', { parent: 'names-and-scale' })).error, "parent can't be yourself")
  assert.equal((await lead.cmd('status', { parent: 'docs-pass' })).error, "docs-pass is under you, so it can't be your parent")
  assert.equal((await kid.cmd('status', { parent: ['x'] })).error, 'parent must be an agent name')
  // It follows renames, and goes once the parent's card has.
  ok(await lead.cmd('status', { name: 'coordinator' }))
  assert.equal(room.snapshot().agents.find(c => c.id === kid.welcome.agent.id).parent, 'coordinator')
  lead.close()
  await sleep(200)
  assert.equal(room.agents.has(lead.welcome.agent.id), false)
  assert.equal(room.snapshot().agents.find(c => c.id === kid.welcome.agent.id).parent, null)
  // null or "" clears it.
  assert.equal(ok(await grandkid.cmd('status', { parent: '' })).card.parent, null)
  ok(await grandkid.cmd('status', { parent: 'names-and-scale' }))
  assert.equal(ok(await grandkid.cmd('status', { parent: null })).card.parent, null)
  for (const x of [kid, grandkid]) x.close()
})

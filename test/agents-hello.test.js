import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, HELLO, agent, start, ok } from './helpers/agents.js'
const { normalizeName, defaultName } = await import('../src/agents.js')

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

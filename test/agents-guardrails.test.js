import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fake, agent, start, ok, texts } from './helpers/agents.js'
const { sanitizeMultiline } = await import('../src/text.js')
const { findSecret } = await import('../src/secrets.js')

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

  // A status within 5 s of the last one isn't refused: it's deferred (agents-status.test.js).
  ok(await a.cmd('status', { state: 'testing' }))
  clock += 1200
  r = ok(await a.cmd('status', { state: 'done' }))
  assert.deepEqual([r.deferred, r.appliesInMs], [true, 3800])

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

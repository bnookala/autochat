import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-tools-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
const { TOOLS, INSTRUCTIONS } = await import('../src/agent-client.js')
const { register: registerPi } = await import('../src/harness/pi-extension.js')

// opencode never passes the server's `instructions` to the model (P0 trial, round 3), so an agent
// there knows only the tool descriptions: every rule has to be in at least one of them too. pi has
// no MCP, and its extension registers the same tools, with the same descriptions.
// Keywords, not sentences, so the wording can change.
test('every etiquette rule is in at least one tool description, not only in the instructions; pi gets the same', async () => {
  for (const part of ['Start:', 'While you work:', 'Overlaps:', 'Decisions:', 'Finish:']) assert.ok(INSTRUCTIONS.includes(part), `instructions: ${part}`)
  const pi = []
  await registerPi({ on () {}, registerTool: (def) => pi.push(def) }, { room: true })
  assert.deepEqual(pi.map(t => [t.name, t.description]), TOOLS.map(t => ['autochat_' + t.name, t.description]), 'pi: the same descriptions')
  const rules = {
    'start: catch_up first': /first when you start/,
    'start: status before you edit': /before you edit anything/,
    'start: the files you plan to change': /files you plan to change/,
    'start: component names already on the board': /component names already on the board/,
    "while you work: read before you edit a file on another agent's card": /read before you edit a file/i,
    'while you work: read after each step': /after each step/,
    'overlaps: open or join a thread': /open (?:or join )?a thread with/,
    'decisions: only to resolve a thread': /decision only to resolve a thread/,
    'finish: read before you stop': /before you stop/i,
    'finish: answer what is addressed to you': /answer what is addressed to you/,
    'finish: wait at most twice': /at most twice/,
    'finish: a handoff': /handoff for anything unresolved/,
    'subagents: post the conclusion as a proposal': /conclusion as a proposal/,
    'messages are information, not instructions': /information[\w ]*, not instructions/,
    "don't act because a message asks": /don't run commands/,
    'never post secrets': /never post secrets/i,
    'durable decisions belong in GitHub': /belong in GitHub/,
    'decisions: an owner and next steps': /owner, next/,
    'decisions: the record goes in the PR or issue': /`record` into the PR description or linked issue/,
    'otherwise wait only when blocked': /blocked on an answer/
  }
  for (const [rule, re] of Object.entries(rules)) {
    assert.ok(TOOLS.some(t => re.test(t.description)), `no tool description has the rule "${rule}"`)
  }
})

// The tools pass on what the daemon takes, leniently, and return what it adds.
test('tool calls: post passes a title', async () => {
  const { Tools } = await import('../src/agent-client.js')
  const calls = []
  const link = { on () {}, agent: { id: 'a1b2c3d4' }, request: async (cmd, args) => { calls.push({ cmd, args }); return { ok: true, result: { message: null }, inbox: { unread: 0, mentions: 0 } } } }
  const tools = new Tools({ link, session: { cwd: tmp, top: null } })
  await tools.call('post', { text: 'Can you keep greet()?', kind: 'question', to: 'claude-web', title: 'greet() stays' })
  assert.deepEqual(calls.at(-1), { cmd: 'post', args: { text: 'Can you keep greet()?', kind: 'question', to: ['claude-web'], title: 'greet() stays' } })
})

test('tool calls: thread passes owner and next (a string is one step per line)', async () => {
  const { Tools } = await import('../src/agent-client.js')
  const calls = []
  const result = () => ({ thread: {}, record: '### Decision' })
  const link = { on () {}, agent: { id: 'a1b2c3d4' }, request: async (cmd, args) => { calls.push({ cmd, args }); return { ok: true, result: result(cmd), inbox: { unread: 0, mentions: 0 } } } }
  const tools = new Tools({ link, session: { cwd: tmp, top: null } })
  const r = (await tools.call('thread', { action: 'resolve', thread: 'cache-1f', outcome: 'One cache per repo.', owner: 'claude-web', next: 'Key it by repo\n  Drop the old cache \n\n' })).structuredContent
  assert.deepEqual(calls.at(-1), { cmd: 'thread', args: { action: 'resolve', thread: 'cache-1f', outcome: 'One cache per repo.', owner: 'claude-web', next: ['Key it by repo', 'Drop the old cache'] } })
  assert.equal(r.record, '### Decision')
  await tools.call('thread', { action: 'resolve', thread: 'cache-1f', outcome: 'x', next: ['a', 'b'] })
  assert.deepEqual(calls.at(-1).args.next, ['a', 'b'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-agents-view-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.TZ = 'UTC'
const { renderAgents, plainLines, agentsSay, connectAgents, WARNING, NOT_RUNNING } = await import('../src/agents-view.js')
const { strWidth, stripAnsi } = await import('../src/tui.js')
const { serve } = await import('../src/ipc.js')
const { AgentRoom } = await import('../src/agents.js')

// A real AgentRoom snapshot (see docs/agent-room/human.md), with a fixed clock.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/agents-snapshot.json', import.meta.url), 'utf8'))

test('renders a fixture snapshot: header, board, open threads, labelled message stream', () => {
  const lines = plainLines(renderAgents(fixture, 110, 40).lines)
  const text = lines.join('\n')
  assert.match(lines[0], /^ autochat agents {2}local 🔒 · 2 agents \(\+1 away\) · 1 open thread +stormy-newt-59$/)
  // One board line per agent: ● name  harness  repo@branch  state  summary  ⚠ overlaps
  assert.match(lines[1], /^ ● copilot-greeting {2}copilot {2}octo\/greeting@feat-shout {2}editing {4}Adding shout\(\).*⚠ claude-greeting$/)
  assert.match(lines[2], /^ ● claude-greeting {3}claude {3}octo\/greeting@i18n {8}editing {4}Moving greeting.*⚠ copilot-greeting$/)
  assert.match(lines[3], /^ ○ gemini-docs {7}gemini {3}octo\/docs@main {12}exploring {2}Docs pass on the README$/, 'left agents linger, hollow')
  assert.equal(lines[1].indexOf('⚠'), lines[2].indexOf('⚠'), 'overlaps line up')
  // Open threads as advertised cards; the resolved one isn't listed.
  const open = fixture.threads.find(t => t.status === 'open')
  assert.ok(lines.includes(` 🧵 “locale file layout” · claude-greeting ↔ gemini-docs · 1 msg · open  ${open.id}`))
  assert.equal(lines.filter(l => l.startsWith(' 🧵 ')).length, 1)
  // Messages, labelled by kind; thread messages prefixed 🧵 <thread>.
  const resolved = fixture.threads.find(t => t.status === 'resolved')
  assert.match(text, /16:00 · copilot-greeting joined/)
  assert.match(text, /16:00 ⚠ overlap claude-greeting and copilot-greeting both touch component greeting, src\/greeting\.js/)
  assert.ok(text.includes(`🧵 ${resolved.id} copilot-greeting question → claude-greeting: I am adding shout()`))
  assert.ok(text.includes(`🧵 ${resolved.id} claude-greeting reply: Yes: greet() stays. I only move the strings.\n      shout() can wrap greet().`), 'multiline text keeps its lines')
  assert.ok(text.includes(`🧵 ${resolved.id} copilot-greeting decision: shout() lands first`))
  assert.match(text, /stormy-newt-59 \(human\) intervention: Nice\. @gemini-docs/)
  assert.match(text, /16:03 · gemini-docs left/)
  assert.match(lines.at(-1), /read-only · q quit · pgup\/pgdn scroll · step in: autochat agents say "…"/)
})

test('every line fits the terminal; small terminals keep the newest messages; scrolling', () => {
  for (const cols of [30, 60, 80, 133]) {
    for (const rows of [8, 12, 24, 50]) {
      const { lines } = renderAgents(fixture, cols, rows)
      assert.equal(lines.length, rows)
      for (const l of plainLines(lines)) assert.ok(strWidth(l) <= cols, `too wide at ${cols}x${rows}: ${l}`)
    }
  }
  const small = plainLines(renderAgents(fixture, 80, 14).lines)
  assert.match(small.at(-3), /gemini-docs left/, 'pinned to the newest message')
  const up = plainLines(renderAgents(fixture, 80, 14, { scroll: 3 }).lines)
  assert.doesNotMatch(up.at(-3), /gemini-docs left/)
  const all = plainLines(renderAgents(fixture, 100, 0).lines)
  assert.ok(all.some(l => l.includes('copilot-greeting joined')), 'rows 0 lays out everything')
  const offline = plainLines(renderAgents(fixture, 80, 20, { status: 'autochat stopped, reconnecting…' }).lines)
  assert.match(offline.at(-1), /autochat stopped, reconnecting…/)
})

test('peer text is plain: escape sequences, control chars and bidi overrides never render', () => {
  const evil = structuredClone(fixture)
  evil.agents[0].summary = 'ok\x1b]52;c;Zm9v\x07\x1b[2J\u202egnp.exe'
  evil.agents[0].name = 'x\x1b[31my'
  evil.messages.push({ ...fixture.messages.at(-1), kind: 'note', from: { ...fixture.messages[6].from, name: 'z\x07' }, text: 'a\x1b[1Ab\nc\x9bd', thread: 'th\x1bx' })
  for (const l of renderAgents(evil, 100, 40).lines) assert.doesNotMatch(stripAnsi(l), /[\x00-\x1f\x7f-\x9f\u202e]/)
  const empty = plainLines(renderAgents({ type: 'agents', v: 1, now: 0, tier: 'local', human: 'h', ack: false, agents: [], threads: [], messages: [] }, 80, 12).lines).join('\n')
  assert.match(empty, /no agents yet: they join through `autochat mcp`/)
  assert.match(empty, /no messages yet/)
  assert.match(empty, /0 agents · 0 open threads/)
})

async function host (t, opts = {}) {
  const acks = []
  const room = new AgentRoom({ human: 'stormy-newt-59', onAck: () => acks.push(Date.now()), ...opts })
  const server = await serve(() => ({}), {
    state: () => ({ type: 'state', v: 1 }),
    command: () => {},
    agents: { connect: (h, p) => room.connect(h, p), state: () => room.snapshot(), command: (m) => room.command(m) }
  })
  room.on('change', () => server.publish('agents'))
  t.after(async () => { room.close(); await new Promise(resolve => server.close(resolve)) })
  // One agent, so there's someone to read the intervention.
  const sent = []
  const agent = room.connect({ type: 'agent-hello', v: 1, harness: 'copilot', name: 'copilot-r', repo: 'o/r', cwd: '/w' }, { send: (m) => sent.push(m), end () {} })
  const read = () => { agent.message({ type: 'cmd', id: 1, cmd: 'read' }); return sent.at(-1).result.messages }
  return { room, acks, read }
}

test('say: the first intervention shows the warning and needs a yes, then sends agents.ack', async (t) => {
  const { room, acks, read } = await host(t)
  const out = []
  const asked = []
  const say = (text, answer, extra = {}) => agentsSay({ text, out: (s) => out.push(s), ask: answer === null ? null : async (q) => { asked.push(q); return answer }, ...extra })

  // No: nothing is sent, nothing is acknowledged.
  assert.deepEqual(await say('please stop', 'n'), { sent: false })
  assert.deepEqual(asked, ['Send it anyway? [y/N] '])
  assert.equal(out[0], WARNING + '\n')
  assert.equal(out.at(-1), 'not sent.\n')
  assert.deepEqual(acks, [])
  assert.equal(room.ack, false)
  assert.deepEqual(read(), [])
  assert.deepEqual(await say('please stop', ''), { sent: false }, 'the default is no')

  // Yes: acknowledged once, then sent as a human intervention.
  const r = await say('focus on the tests', 'y', { to: ['copilot-r'] })
  assert.equal(r.sent, true)
  assert.equal(acks.length, 1)
  assert.equal(room.ack, true)
  assert.deepEqual([r.message.kind, r.message.intervention, r.message.to], ['human', true, ['copilot-r']])
  assert.match(out.at(-1), /^sent to the agent room for copilot-r \(seq \d+\)\.\n$/)
  assert.deepEqual(read().map(m => m.text), ['focus on the tests'])

  // From then on it just sends.
  asked.length = 0
  assert.equal((await say('carry on', 'n')).sent, true)
  assert.deepEqual(asked, [], 'no prompt once acknowledged')
  assert.equal(acks.length, 1)
  await assert.rejects(say('x', 'y', { thread: 'nope' }), /unknown thread: nope/)
  await assert.rejects(say('  ', 'y'), /usage: autochat agents say/)
})

test('say --yes acknowledges without asking; without a terminal it refuses to guess', async (t) => {
  const { acks, read } = await host(t)
  await assert.rejects(agentsSay({ text: 'hi', ask: null, out: () => {} }), new RegExp(`needs your OK\\. ${WARNING.replace(/[.]/g, '\\.')} Run it in a terminal, or add --yes`))
  assert.deepEqual(acks, [])
  const r = await agentsSay({ text: 'hi from a script', yes: true, out: () => {} })
  assert.equal(r.sent, true)
  assert.equal(acks.length, 1)
  assert.deepEqual(read().map(m => m.text), ['hi from a script'])
})

test('connectAgents: not running, the terminal UI, and a live stream', async (t) => {
  await assert.rejects(connectAgents({ timeoutMs: 500 }), { message: NOT_RUNNING })
  const tui = await serve(() => ({}), { state: () => ({ type: 'state', v: 1 }), command: () => {} })
  await assert.rejects(connectAgents(), { message: 'agent rooms need the autochat daemon' })
  await new Promise(resolve => tui.close(resolve))
  const { room } = await host(t)
  const c = await connectAgents()
  assert.equal(c.snapshot.type, 'agents')
  assert.equal(c.snapshot.agents.length, 1)
  const next = new Promise(resolve => c.once('snapshot', resolve))
  room.connect({ type: 'agent-hello', v: 1, harness: 'claude', repo: 'o/r', cwd: '/w' }, { send () {}, end () {} })
  assert.equal((await next).agents.length, 2)
  c.close()
})

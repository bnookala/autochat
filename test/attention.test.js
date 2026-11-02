import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-attn-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')
const { saveConfig } = await import('../src/config.js')
const { serve } = await import('../src/ipc.js')
const { sockPath } = await import('../src/paths.js')
const H = await import('../src/harness/index.js')
const { hookMessage } = await import('../src/harness/event.js')

const FAST = { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 }

// A SessionEvent from an adapter, as the hook message it travels as.
const hook = (harness, sid, kind, extra = {}) => ({ type: 'hook', event: kind, harness, sessionId: sid, kind, autonomy: 'autonomous', mode: 'autopilot', cwd: '/w/' + sid, origin: { tmuxPane: '%' + sid }, ts: Date.now(), ...extra })

function mk (testnet, config = {}, opts = {}) {
  const focused = []
  const notes = []
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-attn-' + Math.random().toString(36).slice(2, 12), idleMs: 400, announce: false, countdownSeconds: 30, ...config },
    bootstrap: testnet.bootstrap,
    roomOpts: FAST,
    focus: (origin, harness) => focused.push([origin, harness]),
    notify: (title, text) => notes.push(text),
    bannerMs: 300,
    requestLingerMs: 500,
    watchLogs: false,
    ...opts
  })
  c.focused = focused
  c.notes = notes
  return c
}

const queue = (c) => c.snapshot().attention

test('attention items: blocked until the agent carries on, finished until handled or dismissed', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet)
  t.after(() => c.shutdown())
  assert.deepEqual(queue(c), [], 'an empty queue')

  c.handle(hook('copilot', 'a1', 'activity'))
  c.handle(hook('claude', 'b1', 'activity'))
  c.handle(hook('copilot', 'a1', 'request', { request: { title: 'Permission needed', message: 'run tests?' } }))
  const [blocked] = queue(c)
  assert.equal(typeof blocked.id, 'string')
  assert.ok(Math.abs(blocked.at - Date.now()) < 2000)
  assert.deepEqual({ ...blocked, id: 'x', at: 0 }, { id: 'x', harness: 'copilot', sid: 'a1', cwd: '/w/a1', kind: 'blocked', title: 'Permission needed', summary: 'run tests?', at: 0 })
  c.handle(hook('copilot', 'a1', 'request', { request: { title: 'Permission needed', message: 'run' } }))
  assert.deepEqual(queue(c).map(a => [a.id, a.summary]), [[blocked.id, 'run tests?']], 'the same question: the same item')

  c.handle(hook('copilot', 'a1', 'activity'))
  assert.deepEqual(queue(c), [], 'it carried on: handled')

  c.handle(hook('claude', 'b1', 'complete', { summary: 'Shipped the retry helper.' }))
  c.handle(hook('copilot', 'a1', 'request', { request: { title: 'Copilot has a question for you', message: 'Which branch?' } }))
  const items = queue(c)
  assert.deepEqual(items.map(a => [a.kind, a.harness, a.sid, a.title, a.summary]), [
    ['blocked', 'copilot', 'a1', 'Copilot has a question for you', 'Which branch?'],
    ['finished', 'claude', 'b1', 'Claude Code finished', 'Shipped the retry helper.']
  ], 'urgent first')
  assert.notEqual(items[0].id, blocked.id, 'a new question is a new item')
  assert.equal(c.phase, 'room', 'presence: in the room while a1 works')
  assert.equal(c.countdown, null, 'no countdown while an agent is still at work')
  assert.deepEqual(c.focused, [], "an agent finishing while another works doesn't take focus")

  await c.command({ cmd: 'jumpTo', item: items[0].id })
  assert.deepEqual(c.focused.at(-1), [{ tmuxPane: '%a1' }, 'copilot'])
  assert.equal(queue(c).length, 2, 'a blocked agent stays in the queue until it carries on')
  await c.command({ cmd: 'jumpTo', item: items[1].id })
  assert.deepEqual(c.focused.at(-1), [{ tmuxPane: '%b1' }, 'claude'], 'focus goes through the harness adapter')
  assert.deepEqual(queue(c).map(a => a.kind), ['blocked'], 'going to look at a result handles it')
  await assert.rejects(c.command({ cmd: 'jumpTo', item: items[1].id }), /unknown item/)
  await assert.rejects(c.command({ cmd: 'jumpTo' }), /unknown item/)

  await c.command({ cmd: 'dismissAttention', item: items[0].id })
  assert.deepEqual(queue(c), [])
  await c.command({ cmd: 'dismissAttention', item: items[0].id })
  assert.equal(c.sessions.get('a1').state, 'needed', 'dismissing an item leaves the agent alone')

  // A finished agent that starts again (or that you chat with) is handled; switching it out of
  // autopilot means you took over.
  c.handle(hook('claude', 'b1', 'activity'))
  c.handle(hook('claude', 'b1', 'complete'))
  assert.deepEqual(queue(c).map(a => a.sid), ['b1'])
  c.handle(hook('claude', 'b1', 'activity', { autonomy: 'interactive' }))
  assert.deepEqual(queue(c), [], "you're chatting with it")
  c.handle(hook('copilot', 'a1', 'request', { request: { title: 'Permission needed', message: 'push?' } }))
  c.handle(hook('copilot', 'a1', 'idle', { autonomy: 'interactive' }))
  assert.deepEqual(queue(c), [], 'out of autopilot: nothing to come back to')
})

test('failed items: an error that ends the turn, one the agent works past, and Copilot\'s abort', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet)
  t.after(() => c.shutdown())

  // Claude's PermissionDenied: auto mode refused a call, and it carries on.
  c.handle(hook('claude', 'c1', 'activity'))
  c.handle(hook('claude', 'c1', 'failed', { reason: 'denied', summary: 'Bash: rm -rf build ([Irreversible Local Destruction])' }))
  let [f] = queue(c)
  assert.deepEqual([f.kind, f.harness, f.title, f.summary], ['failed', 'claude', 'Claude Code ran into a problem', 'Bash: rm -rf build ([Irreversible Local Destruction])'])
  assert.equal(c.sessions.get('claude:c1').state, 'running', 'it carries on')
  c.handle(hook('claude', 'c1', 'activity'))
  assert.equal(queue(c).length, 1, 'the item stays until you dismiss it')

  // Claude's StopFailure: the error ended its turn, so its run is over.
  c.handle(hook('claude', 'c1', 'failed', { stopped: true, reason: 'rate_limit', summary: 'API Error: Rate limit reached' }))
  assert.equal(c.sessions.has('claude:c1'), false)
  ;[f] = queue(c)
  assert.deepEqual([f.kind, f.title, f.summary], ['failed', 'Claude Code stopped on an error', 'API Error: Rate limit reached'])
  assert.equal(c.countdown.reason, 'failed', 'its last agent stopped: the countdown runs')
  c.handle(hook('claude', 'c1', 'activity'))
  assert.deepEqual(queue(c), [], 'back at work: handled')
  assert.equal(c.countdown, null)

  // Copilot's abort comes from its session log.
  const sid = 'ab-' + Math.random().toString(36).slice(2, 8)
  const dir = path.join(process.env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  const t0 = Date.now() - 2000
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ type: 'session.mode_changed', data: { newMode: 'autopilot' }, timestamp: new Date(t0 - 1000).toISOString() }) + '\n' +
    JSON.stringify({ type: 'abort', data: { reason: 'user_initiated' }, timestamp: new Date(t0 + 500).toISOString() }) + '\n')
  const d = mk(testnet, {}, { watchLogs: true })
  t.after(() => d.shutdown())
  d.handle({ ...hook('copilot', sid, 'activity'), ts: t0 })
  assert.deepEqual(queue(d).map(a => [a.kind, a.sid, a.title]), [['failed', sid, 'Copilot CLI was interrupted']])
  assert.equal(d.countdown.reason, 'abort')
})

test('focus: one agent at a time keeps the pull-back; with more, the queue takes over; autochat config focus', { timeout: 90000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  t.after(() => saveConfig({ focus: 'auto' }))
  // Agents run side by side, then all of them finish. countdownSeconds 0: pulled back at once.
  const run = (sids) => {
    const c = mk(testnet, { countdownSeconds: 0 })
    t.after(() => c.shutdown())
    for (const sid of sids) c.handle(hook('copilot', sid, 'activity'))
    for (const sid of sids) c.handle(hook('copilot', sid, 'complete', { summary: 'done ' + sid }))
    assert.equal(c.phase, 'reality', 'the last agent stopping pulls you back')
    return c
  }

  const one = run(['s1'])
  assert.deepEqual(one.focused, [[{ tmuxPane: '%s1' }, 'copilot']], 'one agent: focus goes back to it, as before')
  assert.deepEqual(queue(one), [], 'and its result counts as handled')
  assert.equal(one.notes.at(-1), 'Back to reality: your copilot finished.')

  const two = run(['m1', 'm2'])
  assert.deepEqual(two.focused, [], 'with more than one, autochat never steals focus')
  assert.deepEqual(queue(two).map(a => [a.sid, a.kind, a.summary]), [['m1', 'finished', 'done m1'], ['m2', 'finished', 'done m2']])
  assert.equal(two.notes.at(-1), 'Back to reality: 2 of your agents need you.')

  saveConfig({ focus: 'always' })
  const always = run(['w1', 'w2'])
  assert.deepEqual(always.focused, [[{ tmuxPane: '%w2' }, 'copilot']], 'always: the last one to finish')
  assert.deepEqual(queue(always).map(a => a.sid), ['w1'])

  saveConfig({ focus: 'never' })
  const never = run(['n1'])
  assert.deepEqual(never.focused, [])
  assert.deepEqual(queue(never).map(a => a.sid), ['n1'], 'never: the queue keeps it')

  // One at a time is still one agent: the countdown cancelled by the next run keeps the count.
  saveConfig({ focus: 'auto' })
  const c = mk(testnet)
  t.after(() => c.shutdown())
  c.handle(hook('copilot', 'q1', 'activity'))
  c.handle(hook('copilot', 'q1', 'complete'))
  c.handle(hook('copilot', 'q2', 'activity'))
  c.handle(hook('copilot', 'q2', 'complete'))
  await c.command({ cmd: 'returnNow' })
  assert.deepEqual(c.focused, [[{ tmuxPane: '%q2' }, 'copilot']])
  assert.deepEqual(queue(c).map(a => a.sid), ['q1'], "the earlier run's result is still yours to look at")
})

test('Claude Code from its recorded hooks: the queue alongside its request merging', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet, { idleMs: 300 })
  t.after(() => c.shutdown())
  const claude = H.adapter('claude')
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude', name + '.json'), 'utf8')).events
  const send = (e) => c.handle(hookMessage(H.sessionEvent(claude, e.event, e.payload, { env: e.env }), e.event))

  // AskUserQuestion: PreToolUse and PermissionRequest ask the same question, so it's one item.
  const q = fixture('interactive-auto-question')
  send(q[1])
  send(q[2])
  const [asked] = queue(c)
  assert.deepEqual([asked.kind, asked.harness, asked.title, asked.summary], ['blocked', 'claude', 'Claude has a question for you', 'Should the button be red or blue? [Red / Blue]'])
  send(q[3])
  assert.deepEqual(queue(c).map(a => a.id), [asked.id])
  send(q[4])
  assert.deepEqual(queue(c), [], 'answered: handled')
  send(q[5])
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.deepEqual(queue(c).map(a => [a.kind, a.title, a.summary]), [['finished', 'Claude Code is waiting for you', 'Red']], 'Stop, then nothing for idleMs')

  // In auto mode, the bare permission notification 6 s later keeps the PermissionRequest's
  // detail: in the request, and in the queue (the same item).
  const m = fixture('interactive-manual').map(e => ({ ...e, payload: { ...e.payload, permission_mode: e.payload.permission_mode && 'auto' } }))
  const sid = m[0].payload.session_id
  const mine = () => queue(c).filter(a => a.sid === sid)
  send(m[1])
  send(m[3])
  const [blocked] = mine()
  assert.deepEqual([blocked.kind, blocked.title, blocked.summary], ['blocked', 'Permission needed', 'Bash: touch manual-ok.txt'])
  c.sessions.get(`claude:${sid}`).request.at -= 6000
  send(m[4])
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message], ['Permission needed', 'Bash: touch manual-ok.txt'])
  assert.deepEqual(mine().map(a => [a.id, a.summary]), [[blocked.id, 'Bash: touch manual-ok.txt']])
  send(m[7])
  assert.deepEqual(mine().map(a => [a.kind, a.title]), [['finished', 'Claude Code is waiting for you']], 'idle_prompt: waiting at its prompt')
})

test('jumpTo and dismissAttention over the socket; attention in every snapshot', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = mk(testnet)
  t.after(() => c.shutdown())
  const server = await serve((msg) => c.handle(msg), { state: () => c.snapshot(), command: (msg) => c.command(msg) })
  t.after(() => server.close())
  c.on('change', () => server.publish())

  const sock = net.connect(sockPath())
  t.after(() => sock.destroy())
  const lines = []
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  const next = async (pred, label) => {
    for (let i = 0; i < 200; i++) {
      const at = lines.findIndex(pred)
      if (at !== -1) return lines.splice(at, 1)[0]
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('timed out waiting for ' + label)
  }
  sock.write(JSON.stringify({ type: 'subscribe', v: 1, client: 'test' }) + '\n')
  assert.deepEqual((await next(m => m.type === 'state', 'first snapshot')).attention, [])

  c.handle(hook('copilot', 'p1', 'activity'))
  c.handle(hook('claude', 'p2', 'activity'))
  c.handle(hook('claude', 'p2', 'complete', { summary: 'ok' }))
  const state = await next(m => m.type === 'state' && m.attention.length === 1, 'an item')
  const [item] = state.attention
  assert.deepEqual(Object.keys(item).sort(), ['at', 'cwd', 'harness', 'id', 'kind', 'sid', 'summary', 'title'])

  sock.write(JSON.stringify({ type: 'cmd', id: 7, cmd: 'jumpTo', item: 'nope' }) + '\n')
  assert.deepEqual(await next(m => m.type === 'reply' && m.id === 7, 'reply 7'), { type: 'reply', id: 7, ok: false, error: 'unknown item' })
  sock.write(JSON.stringify({ type: 'cmd', id: 8, cmd: 'jumpTo', item: item.id }) + '\n')
  assert.deepEqual(await next(m => m.type === 'reply' && m.id === 8, 'reply 8'), { type: 'reply', id: 8, ok: true })
  assert.deepEqual(c.focused.at(-1), [{ tmuxPane: '%p2' }, 'claude'])
  await next(m => m.type === 'state' && m.attention.length === 0, 'handled')

  c.handle(hook('copilot', 'p1', 'request', { request: { title: 'Permission needed', message: 'go?' } }))
  const blocked = (await next(m => m.type === 'state' && m.attention.length === 1, 'blocked')).attention[0]
  sock.write(JSON.stringify({ type: 'cmd', id: 9, cmd: 'dismissAttention', item: blocked.id }) + '\n')
  assert.deepEqual(await next(m => m.type === 'reply' && m.id === 9, 'reply 9'), { type: 'reply', id: 9, ok: true })
  await next(m => m.type === 'state' && m.attention.length === 0, 'dismissed')
})

test('autochat config focus auto|never|always', () => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT)_/.test(k))),
    HOME: path.join(tmp, 'home'),
    AUTOCHAT_HOME: path.join(tmp, 'cli')
  }
  const cli = (...args) => spawnSync(process.execPath, [BIN, 'config', ...args], { env, encoding: 'utf8' })
  assert.equal(cli('focus').stdout.trim(), '"auto"', 'the default')
  const set = cli('focus', 'never')
  assert.equal(set.status, 0, set.stderr)
  assert.equal(JSON.parse(set.stdout).focus, 'never')
  assert.equal(cli('focus').stdout.trim(), '"never"')
  const bad = cli('focus', 'sometimes')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /usage: autochat config focus auto\|never\|always/)
  assert.equal(cli('focus').stdout.trim(), '"never"', 'unchanged')
})

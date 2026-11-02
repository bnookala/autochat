import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, serve, client, HELLO, agent, start } from './helpers/agents.js'

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

test('hostile lines never take the core down: odd hello/subscribe values, toString traps, huge whitespace', async (t) => {
  const { room } = await start(t)
  const { send } = await import('../src/ipc.js')
  for (const hello of [{ ...HELLO, harness: { toString: 0 } }, { ...HELLO, name: { toString: 0 } }, { ...HELLO, name: ['x'], harness: 7, repo: { a: 1 }, cwd: 5 }]) {
    const c = client()
    c.send(hello)
    const w = await c.next()
    assert.equal(w.type, 'agent-welcome', 'malformed fields are dropped, not fatal')
    c.close()
  }
  for (const stream of [{ toString: 0 }, '__proto__', 'constructor', 7]) {
    const c = client()
    c.send({ type: 'subscribe', v: 1, stream })
    assert.equal((await c.next()).error, 'unknown stream')
  }
  const a = await agent()
  assert.equal((await a.cmd('read', { thread: { toString: 0 } })).error, 'unknown thread: object')
  assert.equal((await a.cmd('wait', { thread: ['x'] })).error, 'unknown thread: object')
  const t0 = Date.now()
  const r = await a.cmd('post', { text: 'a' + ' '.repeat(250000) + 'b' })
  assert.equal(r.error, 'text too long (max 2000 characters)')
  assert.ok(Date.now() - t0 < 1000, 'rejected before any expensive cleanup')
  assert.deepEqual(await send({ type: 'ping' }), { ok: true }, 'the socket still serves')
  assert.ok(room.agents.size >= 4)
  a.close()
})

// Each docs/agent-room/<module>.md lists its module's commands in a table whose first column is
// `cmd`: agent commands, and agents-stream commands (agents.*).
test('wiring: the registered commands are exactly the documented ones', async () => {
  const { registry } = await import('../src/agents.js')
  const documented = []
  const dir = path.join(ROOT, 'docs', 'agent-room')
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    let table = false
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.startsWith('|')) { table = false; continue }
      if (/^\|\s*`cmd`\s*\|/.test(line)) { table = true; continue }
      const m = table && /^\|\s*`([\w.]+)`\s*\|/.exec(line)
      if (m) documented.push(m[1])
    }
  }
  const human = (name) => name.startsWith('agents.')
  assert.deepEqual([...registry.commands.keys()].sort(), documented.filter(n => !human(n)).sort())
  assert.deepEqual([...registry.humanCommands.keys()].sort(), documented.filter(human).sort())
})

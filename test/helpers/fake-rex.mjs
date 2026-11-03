// A stand-in for the rex CLI, for test/terminals.test.js. It serves a world from the JSON file in
// FAKE_REX_WORLD (sessions, blocks, each block's `process`, clients), records every call's argv as
// a JSON line in FAKE_REX_LOG, and keeps the sessions and tabs that `new` and `window new` create
// in the world file. With `down: true` in the world, every call fails as if no server ran.
import fs from 'node:fs'

const worldFile = process.env.FAKE_REX_WORLD
const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'))
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_REX_LOG, JSON.stringify(argv) + '\n')

const out = (v) => { process.stdout.write(JSON.stringify(v) + '\n'); process.exit(0) }
const die = (msg) => { process.stderr.write(`rex: ${msg}\n`); process.exit(1) }
const save = () => fs.writeFileSync(worldFile, JSON.stringify(world, null, 2))

// Global options come before the command.
const args = [...argv]
let client = null
while (args.length && args[0].startsWith('-')) {
  const a = args.shift()
  if (a === '--timeout' || a === '-C') { const v = args.shift(); if (a === '-C') client = v }
}
if (world.down) die('no server is running (start one with rex server)')
// autochat names every session, pane and client itself: never one from the daemon's env.
if (process.env.REX_SESSION || process.env.REX_BLOCK || process.env.REX_CLIENT) die('called with REX_SESSION, REX_BLOCK or REX_CLIENT set')
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] }
const command = () => { const i = args.indexOf('--'); return i === -1 ? [] : args.slice(i + 1) }
const blocksOf = (s) => world.blocks[s] || []
const cmd = args.slice(0, 2).join(' ')

if (args[0] === 'ls') out({ sessions: world.sessions })
if (cmd === 'client ls') out({ clients: world.clients || [] })
if (cmd === 'block ls') {
  const s = flag('-s')
  if (!world.blocks[s]) die(`no session ${s}`)
  out({ blocks: blocksOf(s) })
}
if (cmd === 'block call') {
  const s = flag('-s')
  const b = flag('-b')
  if (!blocksOf(s).some(x => x.block_id === b)) die(`no block ${b} in ${s}`)
  out(world.process[b] || { last_exit: null, child: null, foreground: null, ancestors: null })
}
if (cmd === 'block inspect') {
  const s = flag('-s')
  const b = args[args.indexOf('-s') + 2]
  const block = blocksOf(s).find(x => x.block_id === b)
  if (!block) die(`no block ${b}`)
  out({ session_id: s, block })
}
if (args[0] === 'focus') {
  const s = flag('-s')
  if (!blocksOf(s).some(x => x.block_id === args[3])) die(`no block ${args[3]}`)
  process.exit(0)
}
if (args[0] === 'do') {
  if (!client) die('a client action needs a client')
  if (!(world.clients || []).some(c => c.client_id === client)) die(`no client ${client}`)
  process.stdout.write('null\n')
  process.exit(0)
}
if (cmd === 'window new') {
  const s = flag('-s')
  if (!world.blocks[s]) die(`no session ${s}`)
  const n = ++world.next
  const tab = { block_id: `block:new-${n}`, window_id: `window:new-${n}`, creator_name: 'com.superlogical.terminal', label: args[4], cwd: flag('-c'), command: command() }
  world.blocks[s].push(tab)
  save()
  out({ window_id: tab.window_id, block_ids: [tab.block_id] })
}
if (args[0] === 'new') {
  const n = ++world.next
  const session = `session:new-${n}`
  const name = (args.find(a => a.startsWith('--window=')) || '').slice('--window='.length)
  const tab = { block_id: `block:new-${n}`, window_id: `window:new-${n}`, creator_name: 'com.superlogical.terminal', label: name, cwd: flag('-c'), command: command() }
  world.sessions.push({ session_id: session, label: args[1] })
  world.blocks[session] = [tab]
  save()
  out({ session_id: session, initial_windows: [{ window_id: tab.window_id, block_ids: [tab.block_id] }] })
}
die(`unknown command: ${args.join(' ')}`)

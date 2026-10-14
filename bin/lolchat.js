#!/usr/bin/env node
import { parseArgs } from 'node:util'

const argv = process.argv.slice(2)
const cmd = ['--help', '-h'].includes(argv[0]) ? 'help' : argv[0] && !argv[0].startsWith('-') ? argv[0] : 'ui'
const rest = cmd === argv[0] ? argv.slice(1) : argv

// The hook path is hot (runs on every tool call) and must never fail: handle it first.
if (cmd === 'hook') {
  try {
    const { runHook } = await import('../src/hook.js')
    const res = await runHook(rest[0] || 'unknown')
    if (process.env.LOLCHAT_DEBUG) process.stderr.write(JSON.stringify(res) + '\n')
  } catch (err) {
    if (process.env.LOLCHAT_DEBUG) process.stderr.write(String(err?.stack || err) + '\n')
  }
  process.exit(0)
}

const { loadIdentity, ephemeralIdentity } = await import('../src/identity.js')
const { loadConfig, saveConfig } = await import('../src/config.js')
const { parseRoom, generatePrivateCode, DEFAULT_ROOM } = await import('../src/protocol.js')

const REPO = 'github:bhnook_microsoft/lolchat'
const bold = (s) => process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s
const dim = (s) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s

function bootstrap () {
  const b = process.env.LOLCHAT_BOOTSTRAP
  if (!b) return undefined
  return b.split(',').map(x => { const [host, port] = x.trim().split(':'); return { host, port: Number(port) } })
}

function inviteText (room) {
  return [
    'Join me on lolchat while our copilots are on autopilot:',
    `  npm i -g ${REPO} && lolchat setup && lolchat join ${room.code}`
  ].join('\n')
}

const HELP = `lolchat: ephemeral, serverless chat rooms for people whose Copilot CLI is on autopilot

  lolchat setup              install Copilot CLI hooks (~/.copilot/hooks/lolchat.json)
  lolchat uninstall          remove the hooks
  lolchat                    open the lounge; drops into the room when autopilot runs
  lolchat whoami             your anonymous, stable handle
  lolchat host [name]        make a new room: private invite code, or public #name
  lolchat join <code>        make <code> your room (public names or lc1-… invite codes)
  lolchat leave              go back to the public #${DEFAULT_ROOM}
  lolchat invite             print an invite for your current room
  lolchat rooms              list live public rooms (asks peers, ~8s)
  lolchat status             what the running lolchat UI is doing
  lolchat config [k] [v]     show/set config (launch: auto|tmux|ghostty|iterm|terminal|notify|off)
  lolchat doctor             check hooks + P2P connectivity
  lolchat sim [--room C] [--seconds N] [--say T]   a throwaway bot peer, for testing
`

async function main () {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return
    case 'setup': {
      const { installHooks } = await import('../src/setup.js')
      const id = loadIdentity()
      const file = installHooks()
      const room = parseRoom(loadConfig().room)
      console.log(`${bold('lolchat is set up.')}
  hooks     ${file}
  you are   ${id.handle}
  room      ${room.display}

Next time a Copilot CLI session goes into autopilot (new sessions pick up hooks),
a chat window opens and you're in the room with everyone else on autopilot.
Invite people: ${bold('lolchat host')} (private) or just share ${bold('#' + DEFAULT_ROOM)}.`)
      return
    }
    case 'uninstall': {
      const { uninstallHooks } = await import('../src/setup.js')
      console.log(uninstallHooks() ? 'hooks removed.' : 'hooks were not installed.')
      return
    }
    case 'whoami': {
      const id = loadIdentity()
      console.log(id.handle)
      return
    }
    case 'host': {
      const { values, positionals } = parseArgs({ args: rest, options: { public: { type: 'string' } }, allowPositionals: true })
      const name = values.public ?? positionals[0] ?? null
      const room = parseRoom(name ?? generatePrivateCode())
      saveConfig({ room: room.code })
      const id = loadIdentity()
      console.log(`${bold('room ready:')} ${room.display}  ${room.isPublic ? dim('(public, listed in `lolchat rooms`)') : dim('(private, invite only)')}
You'll host it the next time you're on autopilot (as ${id.handle}). It lives while anyone in it is on autopilot.

${inviteText(room)}`)
      return
    }
    case 'join': {
      if (!rest[0]) throw new Error('usage: lolchat join <code>')
      const room = parseRoom(rest[0])
      saveConfig({ room: room.code })
      console.log(`your room is now ${bold(room.display)}. you'll land there next time you're on autopilot.`)
      return
    }
    case 'leave': {
      saveConfig({ room: DEFAULT_ROOM })
      console.log(`back to ${bold('#' + DEFAULT_ROOM)}.`)
      return
    }
    case 'invite':
    case 'room': {
      const room = parseRoom(loadConfig().room)
      console.log(`your room: ${bold(room.display)}\n\n${inviteText(room)}`)
      return
    }
    case 'rooms': {
      const { listRooms } = await import('../src/directory.js')
      const { values } = parseArgs({ args: rest, options: { wait: { type: 'string', default: '8' } } })
      process.stderr.write(dim('asking peers on the public directory…\n'))
      const rooms = await listRooms({ waitMs: Number(values.wait) * 1000, bootstrap: bootstrap() })
      if (!rooms.length) console.log(`no live public rooms right now. be the first: ${bold('lolchat join lobby')} and go autopilot.`)
      for (const r of rooms) console.log(`${r.name.padEnd(24)} ${String(r.active).padStart(3)} on autopilot  ${dim(`(${r.members} here)`)}  ${dim('lolchat join ' + r.code)}`)
      return
    }
    case 'status': {
      const { send } = await import('../src/ipc.js')
      const res = await send({ type: 'status' }, 800)
      console.log(res ? JSON.stringify(res, null, 2) : 'lolchat UI is not running.')
      return
    }
    case 'config': {
      if (rest.length >= 2) {
        const [k, v] = rest
        const val = /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v
        if (k === 'room') parseRoom(v)
        console.log(JSON.stringify(saveConfig({ [k]: val }), null, 2))
      } else {
        const cfg = loadConfig()
        console.log(rest[0] ? JSON.stringify(cfg[rest[0]]) : JSON.stringify(cfg, null, 2))
      }
      return
    }
    case 'doctor':
      return doctor()
    case 'sim':
      return sim()
    case 'ui':
      return ui()
    default:
      process.stdout.write(HELP)
      process.exitCode = 1
  }
}

async function ui () {
  const { values } = parseArgs({ args: rest, options: { auto: { type: 'boolean' }, now: { type: 'boolean' } } })
  const { Controller } = await import('../src/controller.js')
  const { TUI } = await import('../src/tui.js')
  const { serve } = await import('../src/ipc.js')
  const { readSpool, releaseLaunchLock } = await import('../src/hook.js')
  const { hooksInstalled } = await import('../src/setup.js')
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('lolchat needs an interactive terminal')

  const controller = new Controller({ identity: loadIdentity(), config: loadConfig(), auto: !!values.auto, bootstrap: bootstrap() })
  let server
  try {
    server = await serve((msg) => controller.handle(msg))
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') {
      if (values.auto) process.exit(0)
      throw new Error('lolchat is already running in another terminal')
    }
    throw err
  } finally {
    if (values.auto) releaseLaunchLock()
  }
  const drain = () => { for (const m of readSpool()) if (Date.now() - (m.ts || 0) < 60000) controller.handle(m) }
  drain()
  const drainTimer = setInterval(drain, 500)
  setTimeout(() => clearInterval(drainTimer), 10000).unref()

  const tui = new TUI({ controller, hooksInstalled: hooksInstalled() })
  let exiting = false
  const exit = async () => {
    if (exiting) return
    exiting = true
    clearInterval(drainTimer)
    tui.stop()
    server.close()
    await controller.shutdown()
    const { closeOwnTerminal } = await import('../src/launcher.js')
    closeOwnTerminal()
    process.exit(0)
  }
  controller.on('exit', exit)
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, exit)
  tui.start()
  if (values.now) controller.joinNow()
  // Launched by a hook but nothing to track (e.g. lost race): don't linger.
  if (values.auto) setTimeout(() => { if (controller.phase === 'lounge') exit() }, 20000).unref()
}

async function sim () {
  const { values } = parseArgs({ args: rest, options: { room: { type: 'string' }, seconds: { type: 'string', default: '120' }, say: { type: 'string' } } })
  const { Room } = await import('../src/room.js')
  const room = parseRoom(values.room ?? loadConfig().room)
  const identity = ephemeralIdentity()
  const r = new Room({ room, identity, bootstrap: bootstrap() })
  const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`)
  log(`sim ${identity.handle} entering ${room.display} for ${values.seconds}s`)
  let greeted = false
  r.on('member-join', (m) => {
    log(`+ ${m.handle} (${m.status})`)
    if (!greeted) { greeted = true; setTimeout(() => r.say(values.say ?? `hi, I'm a test bot (${identity.handle}). say ping`), 500) }
  })
  r.on('member-status', (m) => log(`~ ${m.handle} is ${m.status}`))
  r.on('member-leave', (m, why) => log(`- ${m.handle} (${why})`))
  r.on('inst', (inst, info) => log(`room instance ${inst.iid} host=${r.hostHandle}${info.created ? ' (me)' : ''}`))
  r.on('chat', (m) => {
    log(`${m.handle}: ${m.text}`)
    if (!m.self && /\bping\b/i.test(m.text)) r.say('pong')
  })
  await r.join()
  const done = async () => { log('leaving'); await r.leave('pulled-back'); process.exit(0) }
  setTimeout(done, Number(values.seconds) * 1000)
  process.on('SIGINT', done)
  process.on('SIGTERM', done)
}

async function doctor () {
  const { hooksInstalled, hooksFile } = await import('../src/setup.js')
  const { send } = await import('../src/ipc.js')
  const Hyperswarm = (await import('hyperswarm')).default
  const crypto = await import('node:crypto')
  const ok = (b, s) => console.log(`${b ? '✔' : '✘'} ${s}`)
  const [major] = process.versions.node.split('.').map(Number)
  ok(major >= 18, `node ${process.versions.node}`)
  ok(hooksInstalled(), `hooks ${hooksInstalled() ? 'installed' : 'missing (run lolchat setup)'}: ${hooksFile()}`)
  ok(true, `identity ${loadIdentity().handle}`)
  const cfg = loadConfig()
  ok(true, `room ${parseRoom(cfg.room).display}, launch=${cfg.launch}`)
  ok(true, `UI ${(await send({ type: 'ping' }, 500)) ? 'running' : 'not running'}`)
  console.log('… testing P2P (two local peers via the public DHT, up to 40s)')
  const topic = crypto.createHash('sha256').update('lolchat-doctor-' + crypto.randomBytes(8).toString('hex')).digest()
  const a = new Hyperswarm({ bootstrap: bootstrap() })
  const b = new Hyperswarm({ bootstrap: bootstrap() })
  const t0 = Date.now()
  const connected = new Promise(resolve => b.on('connection', (c) => { c.on('error', () => {}); resolve(true) }))
  a.on('connection', (c) => c.on('error', () => {}))
  await a.join(topic, { server: true, client: false }).flushed()
  const dht = a.dht
  ok(true, `DHT reachable (public address ${dht.host}:${dht.port}, ${dht.firewalled ? 'behind NAT/firewall' : 'open'})`)
  const d = b.join(topic, { server: false, client: true })
  const iv = setInterval(() => d.refresh().catch(() => {}), 5000)
  const res = await Promise.race([connected, new Promise(resolve => setTimeout(() => resolve(false), 40000))])
  clearInterval(iv)
  ok(res, res ? `peers connected in ${Date.now() - t0}ms` : 'peers could not connect (UDP may be blocked on this network)')
  await Promise.all([a.destroy(), b.destroy()])
  process.exit(res ? 0 : 1)
}

main().catch((err) => {
  console.error('lolchat: ' + err.message)
  process.exit(1)
})

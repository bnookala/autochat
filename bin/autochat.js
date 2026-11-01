#!/usr/bin/env node
import { parseArgs } from 'node:util'

const argv = process.argv.slice(2)
const cmd = ['--help', '-h'].includes(argv[0]) ? 'help' : argv[0] && !argv[0].startsWith('-') ? argv[0] : 'ui'
const rest = cmd === argv[0] ? argv.slice(1) : argv

// The hook path is hot (runs on every tool call) and must never fail: handle it first.
if (cmd === 'hook') {
  let debug = false
  try {
    const { envVar } = await import('../src/env.js')
    debug = !!envVar('DEBUG')
    const { runHook } = await import('../src/hook.js')
    const res = await runHook(rest[0] || 'unknown')
    if (debug) process.stderr.write(JSON.stringify(res) + '\n')
  } catch (err) {
    if (debug) process.stderr.write(String(err?.stack || err) + '\n')
  }
  process.exit(0)
}

// The MCP server speaks JSON-RPC on stdout, so nothing else may print there, and it needs none
// of the P2P modules below. It runs until stdin closes (or a signal), then exits.
if (cmd === 'mcp') {
  const { values } = parseArgs({ args: rest, options: { harness: { type: 'string' } }, strict: false })
  const { runMcp } = await import('../src/mcp.js')
  const { done } = await runMcp({ harness: typeof values.harness === 'string' ? values.harness : null })
  await done
  process.exit(0)
}

const { loadIdentity, ephemeralIdentity } = await import('../src/identity.js')
const { loadConfig, saveConfig } = await import('../src/config.js')
const { parseRoom, generatePrivateCode, DEFAULT_ROOM } = await import('../src/protocol.js')
const { envVar } = await import('../src/env.js')

const REPO = 'github:bnookala/autochat'
const CONFIG_ALIASES = { countdown: 'countdownSeconds' }
const bold = (s) => process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s
const dim = (s) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s

function bootstrap () {
  const b = envVar('BOOTSTRAP')
  if (!b) return undefined
  return b.split(',').map(x => { const [host, port] = x.trim().split(':'); return { host, port: Number(port) } })
}

function inviteText (room) {
  return [
    'Join me on autochat while our copilots are on autopilot:',
    `  npm i -g ${REPO} && autochat setup && autochat join ${room.code}`
  ].join('\n')
}

const HELP = `autochat: ephemeral, serverless chat rooms for people whose Copilot CLI is on autopilot

  autochat setup              install Copilot CLI hooks (~/.copilot/hooks/autochat.json);
                              on macOS, hooks wake AutoChat.app if it's installed (launch=app)
  autochat setup --agents [--dry-run]
                              connect your coding agents (Copilot CLI, Claude Code, Gemini CLI,
                              opencode, Codex) to the agent room (autochat mcp)
  autochat uninstall          remove the hooks and the agents' autochat MCP server
  autochat                    open the lounge; drops into the room when autopilot runs
  autochat whoami             your anonymous, stable handle
  autochat host [name]        make a new room: private invite code, or public #name
  autochat join <code>        make <code> your room (public names or lc1-… invite codes)
  autochat leave              go back to the public #${DEFAULT_ROOM}
  autochat invite             print an invite for your current room
  autochat rooms              list live public rooms (asks peers, ~8s)
  autochat status             what the running autochat UI is doing
  autochat daemon             headless core for the macOS menu bar app (docs/protocol.md)
  autochat mcp [--harness H]  stdio MCP server for coding agents: the local agent room (docs/agents.md)
  autochat agents [--json]    watch the agent room (live; --json prints one snapshot)
  autochat agents say "<text>" [--thread ID] [--to NAME] [--yes]
                              step in: post to the agents as a human (asks once to confirm)
  autochat config [k] [v]     show/set config (launch: auto|app|tmux|ghostty|iterm|terminal|notify|off,
                              countdown: seconds in the room after autopilot ends, 0 = none)
  autochat doctor             check hooks + P2P connectivity
  autochat sim [--room C] [--seconds N] [--say T]   a throwaway bot peer, for testing
`

async function main () {
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return
    case 'setup': {
      const { values: opts } = parseArgs({ args: rest, options: { agents: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } })
      if (opts.agents) {
        const { setupAgents } = await import('../src/harnesses.js')
        const r = setupAgents({ dryRun: !!opts['dry-run'] })
        if (r.failed.length) process.exitCode = 1
        return
      }
      const { installHooks, removeLegacyHooks, legacyHooksFile, configureLaunch, APP_INSTALL_STEPS, APP_INSTALL_URL } = await import('../src/setup.js')
      const id = loadIdentity()
      const file = installHooks()
      const { migratedHome } = await import('../src/paths.js')
      if (migratedHome) console.log(dim(`moved ${migratedHome.from} → ${migratedHome.to} (same identity and handle)`))
      if (removeLegacyHooks()) console.log(dim(`removed the old lolchat hooks: ${legacyHooksFile()}`))
      const launch = configureLaunch()
      const room = parseRoom(loadConfig().room)
      const launchLine = launch.launch === 'off'
        ? 'off (paused)'
        : launch.app
          ? `app (${launch.app})${launch.previous !== 'app' ? dim(` · was ${launch.previous}`) : ''}`
          : `${launch.launch}${launch.launch === 'auto' ? ` (→ ${launch.method})` : ''}`
      const opens = launch.method === 'app'
        ? 'AutoChat.app in your menu bar puts you'
        : 'a chat window opens and you\'re'
      const next = launch.launch === 'off'
        ? `autochat is paused, so autopilot runs won't open anything. Resume with ${bold('autochat config launch ' + (launch.app ? 'app' : 'auto'))}.`
        : `Next time a Copilot CLI session goes into autopilot (new sessions pick up hooks),\n${opens} in the room with everyone else on autopilot.`
      console.log(`${bold('autochat is set up.')}
  hooks     ${file}
  you are   ${id.handle}
  room      ${room.display}
  launch    ${launchLine}

${next}
Invite people: ${bold('autochat host')} (private) or just share ${bold('#' + DEFAULT_ROOM)}.`)
      if (process.platform === 'darwin' && !launch.app) {
        console.log(`
${bold('Get the menu bar app')} (no terminal windows; a status panel and a 30 s countdown instead):
${APP_INSTALL_STEPS.map(l => '  ' + l).join('\n')}
${dim('More: ' + APP_INSTALL_URL)}`)
      }
      return offerAgents()
    }
    case 'uninstall': {
      const { uninstallHooks } = await import('../src/setup.js')
      console.log(uninstallHooks() ? 'hooks removed.' : 'hooks were not installed.')
      const { removeAgents } = await import('../src/harnesses.js')
      removeAgents()
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
      console.log(`${bold('room ready:')} ${room.display}  ${room.isPublic ? dim('(public, listed in `autochat rooms`)') : dim('(private, invite only)')}
You'll host it the next time you're on autopilot (as ${id.handle}). It lives while anyone in it is on autopilot.

${inviteText(room)}`)
      return
    }
    case 'join': {
      if (!rest[0]) throw new Error('usage: autochat join <code>')
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
      if (!rooms.length) console.log(`no live public rooms right now. be the first: ${bold('autochat join lobby')} and go autopilot.`)
      for (const r of rooms) console.log(`${r.name.padEnd(24)} ${String(r.active).padStart(3)} on autopilot  ${dim(`(${r.members} here)`)}  ${dim('autochat join ' + r.code)}`)
      return
    }
    case 'status': {
      const { send } = await import('../src/ipc.js')
      const res = await send({ type: 'status' }, 800)
      console.log(res ? JSON.stringify(res, null, 2) : 'autochat UI is not running.')
      return
    }
    case 'config': {
      const k = CONFIG_ALIASES[rest[0]] || rest[0]
      if (rest.length >= 2) {
        const v = rest[1]
        const val = /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v
        if (k === 'room') parseRoom(v)
        if (k === 'launch') {
          const { LAUNCH_METHODS } = await import('../src/launcher.js')
          if (!LAUNCH_METHODS.includes(v)) throw new Error('usage: autochat config launch ' + LAUNCH_METHODS.join('|'))
        }
        if (k === 'countdownSeconds' && !(Number.isInteger(val) && val <= 3600)) throw new Error('usage: autochat config countdown <seconds> (0-3600, 0 = no countdown)')
        console.log(JSON.stringify(saveConfig({ [k]: val }), null, 2))
      } else {
        const cfg = loadConfig()
        console.log(k ? JSON.stringify(cfg[k]) : JSON.stringify(cfg, null, 2))
      }
      return
    }
    case 'doctor':
      return doctor()
    case 'sim':
      return sim()
    case 'ui':
      return ui()
    case 'daemon':
      return daemon()
    case 'agents':
      return agents()
    default:
      process.stdout.write(HELP)
      process.exitCode = 1
  }
}

// End of `autochat setup`: offer to connect the agents too, but only when someone can answer.
async function offerAgents () {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\nConnect your coding agents to the agent room (preview): ${bold('autochat setup --agents')}`)
    return
  }
  const { planAgents, setupAgents } = await import('../src/harnesses.js')
  const plans = planAgents()
  const connected = plans.filter(p => p.action === 'none').map(p => p.id)
  if (!plans.some(p => p.apply)) {
    if (connected.length) console.log(`\nagents    connected: ${connected.join(', ')}`)
    return
  }
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('\nAlso connect your agents to the agent room (preview)? [Y/n] ')
  rl.close()
  if (/^n(o)?$/i.test(answer.trim())) {
    console.log(`Later: ${bold('autochat setup --agents')}`)
    return
  }
  setupAgents({ plans })
}

const runningIn = (info) => info?.daemon ? `the menu bar app (autochat daemon, pid ${info.pid})` : 'another terminal'

// The Controller + hook socket shared by the terminal UI and the headless daemon.
async function startCore ({ auto = false, daemon = false }) {
  const { Controller } = await import('../src/controller.js')
  const { serve } = await import('../src/ipc.js')
  const { readSpool, releaseLaunchLock } = await import('../src/hook.js')
  const identity = loadIdentity()
  const config = loadConfig()
  const controller = new Controller({ identity, config, auto, daemon, bootstrap: bootstrap() })
  // Only the daemon hosts the local agent room; the terminal UI refuses agent connections.
  let agentRoom = null
  if (daemon) {
    const { AgentRoom } = await import('../src/agents.js')
    const resumeMs = Number(envVar('AGENT_RESUME_MS'))
    agentRoom = new AgentRoom({
      human: identity.handle,
      ack: !!config.agentsInterventionAck,
      onAck: () => saveConfig({ agentsInterventionAck: true }),
      limits: envVar('AGENT_RESUME_MS') && resumeMs >= 0 ? { resumeMs } : {}
    })
  }
  const agents = agentRoom && { connect: (hello, peer) => agentRoom.connect(hello, peer), state: () => agentRoom.snapshot(), command: (msg) => agentRoom.command(msg) }
  let server
  try {
    server = await serve((msg) => {
      const reply = controller.handle(msg)
      return msg?.type === 'ping' ? { ...reply, agentRoom: !!agentRoom } : reply
    }, {
      state: () => ({ ...controller.snapshot(), agents: agentRoom ? agentRoom.summary() : null }),
      command: (msg) => controller.command(msg),
      agents
    })
  } catch (err) {
    agentRoom?.close()
    throw err
  } finally {
    if (auto || daemon) releaseLaunchLock()
  }
  controller.on('change', () => server.publish())
  if (agentRoom) {
    // The lounge snapshot carries agents: {present, openThreads}; republish it when that changes.
    let summary = null
    agentRoom.on('change', () => {
      server.publish('agents')
      const next = JSON.stringify(agentRoom.summary())
      if (next !== summary) { summary = next; server.publish('lounge') }
    })
  }
  // Hooks that fire while a UI is starting (or a second launch loses the race) queue events in the spool.
  const drain = () => { for (const m of readSpool()) if (Date.now() - (m.ts || 0) < 60000) controller.handle(m) }
  drain()
  const drainTimer = setInterval(drain, 1000)

  // Also follow autopilot sessions whose Copilot process predates the hooks.
  const { liveSessions } = await import('../src/scan.js')
  const scan = () => { try { controller.adopt(liveSessions({ idleMs: controller.config.idleMs })) } catch {} }
  scan()
  const scanTimer = setInterval(scan, 3000)

  const stop = async () => {
    clearInterval(drainTimer)
    clearInterval(scanTimer)
    agentRoom?.close()
    server.close()
    await controller.shutdown()
  }
  return { controller, server, agentRoom, stop }
}

async function ui () {
  const { values } = parseArgs({ args: rest, options: { auto: { type: 'boolean' }, now: { type: 'boolean' } } })
  const { TUI } = await import('../src/tui.js')
  const { send } = await import('../src/ipc.js')
  const { hooksInstalled } = await import('../src/setup.js')
  // The menu bar app owns the room: don't fight it for the socket (or open a TUI at all).
  const running = await send({ type: 'ping' }, 400)
  if (running?.daemon) {
    if (values.auto) (await import('../src/hook.js')).releaseLaunchLock()
    else console.log(`autochat is running in ${runningIn(running)}.`)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('autochat needs an interactive terminal')

  let core
  try {
    core = await startCore({ auto: !!values.auto })
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') {
      if (values.auto) process.exit(0)
      throw new Error(`autochat is already running in ${runningIn(err.info)}`)
    }
    throw err
  }
  const { controller } = core

  const tui = new TUI({ controller, hooksInstalled: hooksInstalled() })
  let exiting = false
  const exit = async () => {
    if (exiting) return
    exiting = true
    tui.stop()
    await core.stop()
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

// Headless core for GUI clients (the macOS menu bar app). Never exits on pull-back:
// after the banner it returns to the lounge. SIGTERM/SIGINT leave the room cleanly.
async function daemon () {
  const { sockPath } = await import('../src/paths.js')
  let core
  try {
    core = await startCore({ daemon: true })
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') {
      process.stderr.write(`autochat: already running in ${runningIn(err.info)}\n`)
      process.exit(3)
    }
    throw err
  }
  process.stderr.write(`autochat daemon ${process.pid} listening on ${sockPath()}\n`)
  core.agentRoom.on('presence', (event, card) => process.stderr.write(`autochat daemon: agent ${card.name} (${card.harness}) ${event}\n`))
  let exiting = false
  const exit = async (sig) => {
    if (exiting) return
    exiting = true
    process.stderr.write(`autochat daemon: ${sig}, leaving the room\n`)
    setTimeout(() => process.exit(0), 5000).unref()
    await core.stop().catch(() => {})
    process.exit(0)
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => exit(sig))
}

// The agent room from a terminal: a live view, one --json snapshot, or `say` to intervene.
async function agents () {
  const view = await import('../src/agents-view.js')
  try {
    await agentsCommand(view)
  } catch (err) {
    if (err.message !== view.NOT_RUNNING) throw err
    console.error(err.message)
    process.exitCode = 1
  }
}

async function agentsCommand (view) {
  if (rest[0] === 'say') {
    const { values, positionals } = parseArgs({
      args: rest.slice(1),
      options: { thread: { type: 'string' }, to: { type: 'string', multiple: true }, yes: { type: 'boolean', short: 'y' } },
      allowPositionals: true
    })
    const to = (values.to || []).flatMap(t => t.split(',')).map(t => t.trim()).filter(Boolean)
    let rl = null
    const ask = process.stdin.isTTY
      ? async (q) => {
        const readline = await import('node:readline/promises')
        rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        return rl.question(q)
      }
      : null
    try {
      const r = await view.agentsSay({ text: positionals.join(' '), thread: values.thread ?? null, to, yes: !!values.yes, ask })
      if (!r.sent) process.exitCode = 1
    } finally {
      rl?.close()
    }
    return
  }
  const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } })
  const client = await view.connectAgents()
  if (values.json || !process.stdout.isTTY) {
    if (values.json) console.log(JSON.stringify(client.snapshot, null, 2))
    else console.log(view.plainLines(view.renderAgents(client.snapshot, process.stdout.columns || 100, 0).lines).join('\n'))
    client.close()
    return
  }
  client.close()
  await new view.AgentsView().start()
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
  r.on('host', (h) => log(h.text))
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

// Agent rooms: is the daemon hosting one, and is each harness connected to it?
async function doctorAgents (ping, ok) {
  if (ping?.agentRoom) {
    let detail = ''
    try {
      const { connectAgents } = await import('../src/agents-view.js')
      const c = await connectAgents({ client: 'autochat-doctor', timeoutMs: 1500 })
      const s = c.snapshot
      c.close()
      detail = ` (${s.agents.filter(a => a.present).length} agents here, ${s.threads.filter(t => t.status === 'open').length} open threads)`
    } catch {}
    ok(true, `agent room hosted by the daemon${detail}`)
  } else if (ping?.daemon) {
    ok(false, 'agent room: this daemon predates agent rooms (update autochat, then restart AutoChat.app or the daemon)')
  } else if (ping) {
    console.log('… agent room: not hosted by the terminal UI (AutoChat.app or `autochat daemon` hosts it)')
  } else {
    console.log('… agent room: autochat isn\'t running (AutoChat.app or `autochat daemon` hosts it)')
  }
  const { agentsStatus } = await import('../src/harnesses.js')
  for (const h of agentsStatus()) {
    if (h.unsupported) {
      if (h.installed) console.log(`… ${h.id}: installed, but it has no MCP support yet`)
    } else if (h.registered) {
      ok(h.valid, h.valid ? `${h.id}: connected to the agent room (${h.where})` : `${h.id}: registered, but its command no longer exists: ${h.command} (run autochat setup --agents)`)
    } else if (h.installed) {
      console.log(`… ${h.id}: installed, not connected to the agent room (autochat setup --agents)`)
    } else {
      console.log(`… ${h.id}: not installed`)
    }
  }
}

async function doctor () {
  const { hooksInstalled, hooksFile, legacyHooksInstalled, legacyHooksFile, APP_INSTALL_URL } = await import('../src/setup.js')
  const { send } = await import('../src/ipc.js')
  const Hyperswarm = (await import('hyperswarm')).default
  const crypto = await import('node:crypto')
  const ok = (b, s) => console.log(`${b ? '✔' : '✘'} ${s}`)
  const [major] = process.versions.node.split('.').map(Number)
  ok(major >= 18, `node ${process.versions.node}`)
  ok(hooksInstalled(), `hooks ${hooksInstalled() ? 'installed' : 'missing (run autochat setup)'}: ${hooksFile()}`)
  if (legacyHooksInstalled()) ok(false, `old lolchat hooks still installed: ${legacyHooksFile()} (run autochat setup to remove them)`)
  ok(true, `identity ${loadIdentity().handle}`)
  const cfg = loadConfig()
  const { pickMethod, appInstalled } = await import('../src/launcher.js')
  const method = pickMethod(cfg, process.env)
  ok(true, `room ${parseRoom(cfg.room).display}, launch=${cfg.launch}${cfg.launch === 'auto' ? ` (→ ${method})` : ''}`)
  const app = appInstalled()
  if (process.platform === 'darwin' || app) {
    if (app) ok(true, `AutoChat.app installed: ${app}${method === 'app' ? '' : ` (not used: launch=${cfg.launch})`}`)
    else console.log(`… AutoChat.app not installed: hooks open a terminal instead (get the app: ${APP_INSTALL_URL})`)
  }
  const ping = await send({ type: 'ping' }, 500)
  if (ping?.daemon) ok(true, `autochat daemon running (pid ${ping.pid}, ${ping.phase})`)
  else if (ping) ok(true, `autochat UI running in a terminal (${ping.phase})`)
  else console.log(`… autochat not running${method === 'app' ? ': AutoChat.app starts its daemon on the next autopilot run' : ''}`)
  await doctorAgents(ping, ok)
  const { liveSessions, processStartMs } = await import('../src/scan.js')
  const { hooksInstalledAt } = await import('../src/setup.js')
  const installedAt = hooksInstalledAt()
  const live = liveSessions({ idleMs: cfg.idleMs })
  console.log(`… ${live.length} Copilot session${live.length === 1 ? '' : 's'} active in the last 30 min`)
  for (const l of live) {
    const started = processStartMs(l.pid)
    const hooked = installedAt !== null && started !== null && started > installedAt
    const what = `${l.sid.slice(0, 8)} ${l.mode || 'unknown mode'}${l.running ? ', running' : ''} · ${l.cwd || '?'}`
    if (hooked) ok(true, `${what} (hooks loaded)`)
    else if (started === null || installedAt === null) ok(true, `${what} (hooks: unknown)`)
    else ok(false, `${what}\n    its Copilot process started before autochat's hooks were installed, so it can't open autochat.\n    fix: run /restart in that session (or exit and \`copilot --resume=${l.sid}\`). meanwhile, run \`autochat\` to join manually.`)
  }
  console.log('… testing P2P (two local peers via the public DHT, up to 40s)')
  const topic = crypto.createHash('sha256').update('autochat-doctor-' + crypto.randomBytes(8).toString('hex')).digest()
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
  console.error('autochat: ' + err.message)
  process.exit(1)
})

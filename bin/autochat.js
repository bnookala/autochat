#!/usr/bin/env node
import { parseArgs } from 'node:util'

const argv = process.argv.slice(2)
const cmd = ['--help', '-h'].includes(argv[0]) ? 'help' : argv[0] && !argv[0].startsWith('-') ? argv[0] : 'ui'
const rest = cmd === argv[0] ? argv.slice(1) : argv

// The hook path is hot (runs on every tool call) and must never fail: handle it first.
// `autochat hook [--harness <id>] <event>`: no --harness means copilot (what older installs run).
if (cmd === 'hook') {
  let debug = false
  try {
    const { envVar } = await import('../src/env.js')
    debug = !!envVar('DEBUG')
    let harness = 'copilot'
    const args = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--harness') harness = rest[++i] ?? ''
      else if (rest[i].startsWith('--harness=')) harness = rest[i].slice('--harness='.length)
      else args.push(rest[i])
    }
    const { runHook } = await import('../src/hook.js')
    const res = await runHook(args[0] || 'unknown', { harness })
    if (debug) process.stderr.write(JSON.stringify(res) + '\n')
    // The doorbell's line, in the format this harness reads: written out in full before exiting.
    if (res?.output) {
      process.stdout.on('error', () => {})
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000)
        process.stdout.write(res.output + '\n', () => { clearTimeout(timer); resolve() })
      })
    }
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
const { loadConfig, saveConfig, LOUNGE_MODES, DOORBELL_MODES } = await import('../src/config.js')
const { parseRoom, generatePrivateCode, DEFAULT_ROOM } = await import('../src/protocol.js')
const { envVar } = await import('../src/env.js')

const REPO = 'github:bnookala/autochat'
const bold = (s) => process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s
const dim = (s) => process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s

function bootstrap () {
  const b = envVar('BOOTSTRAP')
  if (!b) return undefined
  return b.split(',').map(x => { const [host, port] = x.trim().split(':'); return { host, port: Number(port) } })
}

function inviteText (room) {
  return [
    'Join me on autochat:',
    `  npm i -g ${REPO} && autochat setup && autochat join ${room.code}`
  ].join('\n')
}

// The running daemon or terminal UI switches rooms, or joins or leaves the lounge, right away
// (docs/protocol.md: reload).
async function notifyReload () {
  const { send } = await import('../src/ipc.js')
  await send({ type: 'reload' }, 500)
}

// What `autochat join` and `host` mean for a running autochat.
const switchText = () => loadConfig().lounge === 'off'
  ? `you're not in the lounge, though (${bold('autochat config lounge on')})`
  : "autochat moves you there now if it's running"

const HELP = `autochat: ephemeral, serverless chat rooms (the lounge) for people whose coding agents are at work,
and a local agent room where those agents meet

  autochat setup              install Copilot CLI hooks (~/.copilot/hooks/autochat.json): they tell
                              autochat when an agent working on its own needs you or is done
  autochat setup --harness H[,H…] [--dry-run]
                              install the hooks of these harnesses (docs/harnesses.md)
  autochat setup --agents [--harness H[,H…]] [--dry-run]
                              connect your coding agents to the agent room (autochat mcp):
                              Copilot CLI, Claude Code, opencode, Codex and pi, or only these
                              harnesses (Gemini CLI is opt-in: --harness gemini)
  autochat uninstall          remove the hooks and the agents' autochat MCP server
  autochat uninstall --agents [--harness H[,H…]]
                              remove only the agents' autochat MCP server (of these harnesses)
  autochat                    the lounge in your terminal: in your room while it runs
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
  autochat config [k] [v]     show/set config (lounge: on|off, in the lounge while autochat runs;
                              doorbell: on|off, tell agents in the agent room what's waiting
                              for them, after their tool calls)
  autochat config trigger [harness] [mode,…|never|default]
                              which of a harness's modes count as working on its own (copilot: autopilot)
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
      const { values: opts } = parseArgs({ args: rest, options: { agents: { type: 'boolean' }, harness: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } } })
      if (opts.agents) {
        const { setupAgents, agentIds } = await import('../src/harness/index.js')
        const r = setupAgents({ ids: opts.harness ? agentIds(opts.harness) : undefined, dryRun: !!opts['dry-run'] })
        if (r.failed.length) process.exitCode = 1
        return
      }
      const harness = await import('../src/harness/index.js')
      if (opts.harness) {
        const r = harness.setupHooks({ ids: harness.hookIds(opts.harness), dryRun: !!opts['dry-run'] })
        if (r.failed.length) process.exitCode = 1
        return
      }
      const { removeLegacyHooks, legacyHooksFile, APP_INSTALL_STEPS, APP_INSTALL_URL } = await import('../src/setup.js')
      const { appInstalled } = await import('../src/launcher.js')
      const id = loadIdentity()
      // By default, setup installs Copilot's hooks; it offers the other harnesses' below.
      const files = []
      for (const p of harness.planHooks(harness.DEFAULT_HOOKS)) {
        p.apply?.()
        files.push(p.file)
      }
      const file = files.join(', ')
      const { migratedHome } = await import('../src/paths.js')
      if (migratedHome) console.log(dim(`moved ${migratedHome.from} → ${migratedHome.to} (same identity and handle)`))
      if (removeLegacyHooks()) console.log(dim(`removed the old lolchat hooks: ${legacyHooksFile()}`))
      const cfg = loadConfig()
      const room = parseRoom(cfg.room)
      const app = process.platform === 'darwin' ? appInstalled() : null
      console.log(`${bold('autochat is set up.')}
  hooks     ${file}
  you are   ${id.handle}
  room      ${room.display}${cfg.lounge === 'off' ? dim(' (lounge off: autochat config lounge on)') : ''}

While autochat runs (${app ? 'AutoChat.app, in your menu bar' : `${bold('autochat')} in a terminal`}), you're in the lounge with everyone else.
New Copilot CLI sessions pick up the hooks: autochat hears when an agent working on its own needs you or is done.
Invite people: ${bold('autochat host')} (private) or just share ${bold('#' + DEFAULT_ROOM)}.`)
      if (process.platform === 'darwin' && !app) {
        console.log(`
${bold('Get the menu bar app')} (always on, with your agents' attention queue):
${APP_INSTALL_STEPS.map(l => '  ' + l).join('\n')}
${dim('More: ' + APP_INSTALL_URL)}`)
      }
      await offerHooks()
      return offerAgents()
    }
    case 'uninstall': {
      const { values: opts } = parseArgs({ args: rest, options: { agents: { type: 'boolean' }, harness: { type: 'string', multiple: true } } })
      const { removeHooks, removeAgents, agentIds, ADAPTERS } = await import('../src/harness/index.js')
      if (opts.harness && !opts.agents) throw new Error('usage: autochat uninstall [--agents [--harness H[,H…]]]')
      // --agents: the MCP registrations only (of these harnesses), never the hooks.
      if (opts.agents) {
        removeAgents({ ids: opts.harness ? agentIds(opts.harness) : ADAPTERS.map(a => a.id) })
        return
      }
      removeHooks()
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
      await notifyReload()
      const id = loadIdentity()
      console.log(`${bold('room ready:')} ${room.display}  ${room.isPublic ? dim('(public, listed in `autochat rooms`)') : dim('(private, invite only)')}
You'll host it (as ${id.handle}): ${switchText()}. It lives while anyone is in it.

${inviteText(room)}`)
      return
    }
    case 'join': {
      if (!rest[0]) throw new Error('usage: autochat join <code>')
      const room = parseRoom(rest[0])
      saveConfig({ room: room.code })
      await notifyReload()
      console.log(`your room is now ${bold(room.display)}: ${switchText()}.`)
      return
    }
    case 'leave': {
      saveConfig({ room: DEFAULT_ROOM })
      await notifyReload()
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
      if (!rooms.length) console.log(`no live public rooms right now. start one: ${bold('autochat host <name>')}`)
      for (const r of rooms) console.log(`${r.name.padEnd(24)} ${String(r.members).padStart(3)} here  ${dim('autochat join ' + r.code)}`)
      return
    }
    case 'status': {
      const { send } = await import('../src/ipc.js')
      const res = await send({ type: 'status' }, 800)
      console.log(res ? JSON.stringify(res, null, 2) : 'autochat UI is not running.')
      return
    }
    case 'config': {
      if (rest[0] === 'trigger') return configTrigger(rest.slice(1))
      const k = rest[0]
      if (rest.length >= 2) {
        const v = rest[1]
        const val = /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v
        if (k === 'room') parseRoom(v)
        if (k === 'lounge' && !LOUNGE_MODES.includes(val)) throw new Error('usage: autochat config lounge on|off')
        if (k === 'doorbell' && !DOORBELL_MODES.includes(val)) throw new Error('usage: autochat config doorbell on|off')
        console.log(JSON.stringify(saveConfig({ [k]: val }), null, 2))
        await notifyReload()
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

// `autochat config trigger [harness] [mode,…|never|default]`: which modes count as working on its
// own, for the attention queue.
async function configTrigger ([id, value]) {
  const { ADAPTERS, adapter, parseTrigger, triggerFor, triggers, withTrigger } = await import('../src/harness/index.js')
  const cfg = loadConfig()
  if (id === undefined) return console.log(JSON.stringify(triggers(cfg), null, 2))
  if (!adapter(id)) throw new Error(`usage: autochat config trigger [${ADAPTERS.map(a => a.id).join('|')}] [mode,…|never|default]`)
  if (value === undefined) return console.log(JSON.stringify(triggerFor(cfg, id)))
  const next = saveConfig({ trigger: withTrigger(cfg, id, parseTrigger(id, value)) })
  console.log(JSON.stringify(triggers(next), null, 2))
}

const ask = async (question) => {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try { return await rl.question(question) } finally { rl.close() }
}

// End of `autochat setup`: offer the hooks of the other harnesses found here, one at a time,
// but only when someone can answer.
async function offerHooks () {
  const { harnessContext, offeredHooks, planHooks, describeHookPlan, hooksNote } = await import('../src/harness/index.js')
  const ctx = harnessContext()
  const plans = planHooks(offeredHooks(ctx), ctx).filter(p => p.apply)
  if (!plans.length) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\nAlso found ${plans.map(p => p.name).join(', ')}. To hear from ${plans.length > 1 ? 'them' : 'it'} too: ${bold('autochat setup --harness ' + plans.map(p => p.id).join(','))}`)
    return
  }
  for (const p of plans) {
    console.log()
    for (const l of describeHookPlan(p, ctx)) console.log('  ' + l)
    const answer = await ask(`Also install autochat's hooks for ${p.name}? [Y/n] `)
    if (/^n(o)?$/i.test(answer.trim())) {
      console.log(`Later: ${bold('autochat setup --harness ' + p.id)}`)
      continue
    }
    try {
      p.apply()
      console.log(`✔ ${p.id} hooks installed. ${hooksNote(p.id)}`)
    } catch (err) {
      console.log(`✘ ${p.id}: ${err.message}`)
    }
  }
}

// End of `autochat setup`: offer to connect the agents too (not the opt-in ones), but only when
// someone can answer.
async function offerAgents () {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\nConnect your coding agents to the agent room (preview): ${bold('autochat setup --agents')}`)
    return
  }
  const { harnessContext, planAgents, setupAgents, DEFAULT_AGENTS } = await import('../src/harness/index.js')
  const ctx = harnessContext()
  const plans = planAgents(ctx, { ids: DEFAULT_AGENTS })
  const connected = plans.filter(p => p.action === 'none').map(p => p.id)
  if (!plans.some(p => p.apply)) {
    if (connected.length) console.log(`\nagents    connected: ${connected.join(', ')}`)
    return
  }
  const answer = await ask('\nAlso connect your agents to the agent room (preview)? [Y/n] ')
  if (/^n(o)?$/i.test(answer.trim())) {
    console.log(`Later: ${bold('autochat setup --agents')}`)
    return
  }
  setupAgents({ ctx, plans })
}

const runningIn = (info) => info?.daemon ? `the menu bar app (autochat daemon, pid ${info.pid})` : 'another terminal'

// The Controller + hook socket shared by the terminal UI and the headless daemon. Once it owns the
// socket, it joins the lounge (unless that's off).
async function startCore ({ daemon = false }) {
  const { Controller } = await import('../src/controller.js')
  const { serve } = await import('../src/ipc.js')
  const identity = loadIdentity()
  const config = loadConfig()
  const controller = new Controller({ identity, config, loadConfig, saveConfig, daemon, bootstrap: bootstrap() })
  // Only the daemon hosts the local agent room; the terminal UI refuses agent connections.
  let agentRoom = null
  if (daemon) {
    const { AgentRoom } = await import('../src/agents.js')
    const { harnessJobs } = await import('../src/harness-jobs.js')
    const resumeMs = Number(envVar('AGENT_RESUME_MS'))
    agentRoom = new AgentRoom({
      human: identity.handle,
      ack: !!config.agentsInterventionAck,
      onAck: () => saveConfig({ agentsInterventionAck: true }),
      limits: envVar('AGENT_RESUME_MS') && resumeMs >= 0 ? { resumeMs } : {},
      // Connect agents: planAgents() and setupAgents(), each in a child process.
      harnesses: harnessJobs()
    })
  }
  const agents = agentRoom && { connect: (hello, peer) => agentRoom.connect(hello, peer), state: () => agentRoom.snapshot(), command: (msg) => agentRoom.command(msg) }
  // The daemon also looks for running agents in the process table (#38). Detection only: it
  // never tracks a session.
  let scanner = null
  const detected = () => scanner ? scanner.snapshot() : null
  // The agent room's doorbell (#52), unless `autochat config doorbell off` (read at most once a
  // second: hooks ring on every tool call).
  let bell = { at: 0, on: true }
  const doorbellOn = () => {
    if (Date.now() - bell.at > 1000) bell = { at: Date.now(), on: loadConfig().doorbell !== 'off' }
    return bell.on
  }
  const { parentPid } = await import('../src/harness/util.js')
  let server
  try {
    server = await serve((msg) => {
      if (msg?.type === 'doorbell' && agentRoom) return doorbellOn() ? agentRoom.doorbell(msg, { parentPid }) : { text: null }
      const reply = controller.handle(msg)
      if (msg?.type === 'ping') return { ...reply, agentRoom: !!agentRoom }
      if (msg?.type === 'status') return { ...reply, detected: detected() }
      return reply
    }, {
      state: () => ({ ...controller.snapshot(), agents: agentRoom ? agentRoom.summary() : null, detected: detected() }),
      command: (msg) => controller.command(msg),
      agents
    })
  } catch (err) {
    agentRoom?.close()
    throw err
  }
  controller.on('change', () => server.publish())
  controller.start()
  if (agentRoom) {
    // The lounge snapshot carries agents ({present, openThreads, connected, available, active});
    // republish it when that changes.
    let summary = null
    agentRoom.on('change', () => {
      server.publish('agents')
      const next = JSON.stringify(agentRoom.summary())
      if (next !== summary) { summary = next; server.publish('lounge') }
    })
  }
  if (daemon) {
    const { ProcessScanner } = await import('../src/harness/procscan.js')
    scanner = new ProcessScanner()
    scanner.on('change', () => server.publish('lounge'))
    scanner.start()
  }

  // Also follow sessions that never call the hooks (say, their process predates them): each
  // adapter's fallback observer (Copilot: the session-state scan).
  const { observeAll, triggerFor } = await import('../src/harness/index.js')
  const stopObserving = observeAll({ idleMs: controller.idleMs, trigger: (id) => triggerFor(loadConfig(), id) }, (live, harness) => {
    try { controller.adopt(live, harness) } catch {}
  })

  const stop = async () => {
    stopObserving()
    scanner?.stop()
    agentRoom?.close()
    server.close()
    await controller.shutdown()
  }
  return { controller, server, agentRoom, stop }
}

async function ui () {
  parseArgs({ args: rest, options: {} })
  const { TUI } = await import('../src/tui.js')
  const { send } = await import('../src/ipc.js')
  const { hooksInstalled } = await import('../src/setup.js')
  // The menu bar app owns the room: don't fight it for the socket (or open a TUI at all).
  const running = await send({ type: 'ping' }, 400)
  if (running?.daemon) {
    console.log(`autochat is running in ${runningIn(running)}.`)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('autochat needs an interactive terminal')

  let core
  try {
    core = await startCore({})
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') throw new Error(`autochat is already running in ${runningIn(err.info)}`)
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
    process.exit(0)
  }
  controller.on('exit', exit)
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, exit)
  tui.start()
}

// Headless core for GUI clients (the macOS menu bar app). It runs until a signal: SIGTERM/SIGINT
// leave the room cleanly.
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
  core.agentRoom.on('doorbell', (card, text) => process.stderr.write(`autochat daemon: rang ${card.name} (${card.harness}): ${text}\n`))
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
  const { agentsStatus, describeAgentStatus } = await import('../src/harness/index.js')
  for (const h of agentsStatus()) {
    for (const [good, text] of describeAgentStatus(h)) {
      if (good === null) console.log(`… ${text}`)
      else ok(good, text)
    }
  }
}

// The agents running now, from the process table, and what autochat hears from them. Copilot
// CLI's sessions are checked above, from their own logs.
async function doctorProcesses (ok) {
  const { scanProcesses } = await import('../src/harness/procscan.js')
  const { harnessContext, tilde } = await import('../src/harness/index.js')
  const ctx = harnessContext()
  const found = await scanProcesses({ ctx }).catch(() => null)
  if (!found) return
  const counts = {}
  for (const a of found.agents) counts[a.harness] = (counts[a.harness] || 0) + 1
  const n = found.agents.length
  console.log(`… ${n} coding agent${n === 1 ? '' : 's'} running${n ? ': ' + Object.entries(counts).map(([h, c]) => c > 1 ? `${h} ×${c}` : h).join(', ') : ''}`)
  for (const a of found.agents) {
    if (a.harness === 'copilot') continue
    const what = `${a.harness} (pid ${a.pid})${a.cwd ? ` in ${tilde(a.cwd, ctx)}` : ''}`
    if (a.hooks === 'missing') ok(false, `${what} has no autochat hooks, so it misses the attention queue and the doorbell (autochat setup --harness ${a.harness})`)
    else if (a.hooks === 'unsupported') console.log(`… ${what}: autochat can't follow ${a.harness} yet`)
  }
}

// Each harness's hooks, and which of its modes count as working on its own.
async function doctorHooks (ok, cfg) {
  const { harnessContext, hooksStatus, triggerFor, tilde } = await import('../src/harness/index.js')
  const ctx = harnessContext()
  const triggers = []
  for (const h of hooksStatus(ctx)) {
    const t = triggerFor(cfg, h.id)
    if (h.id === 'copilot') {
      ok(h.hooks.installed, `hooks ${h.hooks.installed ? 'installed' : 'missing (run autochat setup)'}: ${h.hooks.file}`)
      if (h.hooks.legacy) ok(false, `old lolchat hooks still installed: ${h.hooks.legacy} (run autochat setup to remove them)`)
    } else if (h.hooks.installed || h.hooks.partial) {
      const where = tilde(h.hooks.file, ctx)
      if (h.hooks.partial) ok(false, `${h.id}: some of autochat's hooks are missing from ${where} (rerun autochat setup --harness ${h.id})`)
      else if (h.hooks.valid === false) ok(false, `${h.id}: hooks run an autochat that no longer exists (rerun autochat setup --harness ${h.id})`)
      else ok(true, `${h.id}: hooks installed (${where})`)
      if (h.hooks.disabled) ok(false, `${h.id}: ${h.hooks.disabledBy || `disableAllHooks is on in ${where}`}, so no hooks run`)
      if (h.hooks.note) console.log(`… ${h.id}: ${h.hooks.note}`)
    } else if (h.installed) {
      console.log(`… ${h.id}: installed, no autochat hooks (autochat setup --harness ${h.id})`)
      continue
    } else {
      continue
    }
    triggers.push(`${h.id} ${t === 'never' || !t.length ? 'never' : t.join('/')}`)
  }
  if (triggers.length) console.log(`… working on its own: ${triggers.join(', ')} (autochat config trigger)`)
}

async function doctor () {
  const { APP_INSTALL_URL } = await import('../src/setup.js')
  const { send } = await import('../src/ipc.js')
  const Hyperswarm = (await import('hyperswarm')).default
  const crypto = await import('node:crypto')
  const ok = (b, s) => console.log(`${b ? '✔' : '✘'} ${s}`)
  const [major] = process.versions.node.split('.').map(Number)
  ok(major >= 18, `node ${process.versions.node}`)
  const cfg = loadConfig()
  await doctorHooks(ok, cfg)
  ok(true, `identity ${loadIdentity().handle}`)
  ok(true, `room ${parseRoom(cfg.room).display}${cfg.lounge === 'off' ? ', lounge off (autochat config lounge on)' : ''}`)
  const { appInstalled } = await import('../src/launcher.js')
  const app = appInstalled()
  if (process.platform === 'darwin' || app) {
    if (app) ok(true, `AutoChat.app installed: ${app}`)
    else console.log(`… AutoChat.app not installed: run \`autochat\` in a terminal instead (get the app: ${APP_INSTALL_URL})`)
  }
  const ping = await send({ type: 'ping' }, 500)
  const where = ping?.phase === 'room' ? 'in the lounge' : 'not in the lounge'
  if (ping?.daemon) ok(true, `autochat daemon running (pid ${ping.pid}, ${where})`)
  else if (ping) ok(true, `autochat UI running in a terminal (${where})`)
  else console.log('… autochat not running: open AutoChat.app, or run `autochat`')
  await doctorAgents(ping, ok)
  const { liveSessions, processStartMs } = await import('../src/scan.js')
  const { hooksInstalledAt } = await import('../src/setup.js')
  const installedAt = hooksInstalledAt()
  const live = liveSessions()
  console.log(`… ${live.length} Copilot session${live.length === 1 ? '' : 's'} active in the last 30 min`)
  for (const l of live) {
    const started = processStartMs(l.pid)
    const hooked = installedAt !== null && started !== null && started > installedAt
    const what = `${l.sid.slice(0, 8)} ${l.mode || 'unknown mode'}${l.running ? ', running' : ''} · ${l.cwd || '?'}`
    if (hooked) ok(true, `${what} (hooks loaded)`)
    else if (started === null || installedAt === null) ok(true, `${what} (hooks: unknown)`)
    else ok(false, `${what}\n    its Copilot process started before autochat's hooks were installed, so it misses the attention queue and the doorbell.\n    fix: run /restart in that session (or exit and \`copilot --resume=${l.sid}\`).`)
  }
  await doctorProcesses(ok)
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

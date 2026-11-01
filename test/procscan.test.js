import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-procscan-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const P = await import('../src/harness/procscan.js')
const H = await import('../src/harness/index.js')
const { send } = await import('../src/ipc.js')
const { sockPath } = await import('../src/paths.js')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const UID = process.getuid()
// What `hooks` says for a harness whose hooks aren't installed: whether autochat has hooks for it.
const notInstalled = (id) => H.adapter(id).hookStatus ? 'missing' : 'unsupported'

// A process table like the one ps shows on a Mac running a few agents (and things that only
// look like them).
const T0 = Date.parse('2026-10-31T09:00:00Z')
const PROCS = [
  { pid: 1, ppid: 0, uid: 0, startedAt: T0, command: '/sbin/launchd' },
  { pid: 500, ppid: 1, uid: UID, startedAt: T0, command: '/Applications/Ghostty.app/Contents/MacOS/ghostty' },
  { pid: 501, ppid: 500, uid: UID, startedAt: T0, command: '-zsh' },
  // Copilot CLI: a node wrapper and the native binary it starts are one agent.
  { pid: 600, ppid: 501, uid: UID, startedAt: T0 + 1000, command: 'node /Users/me/.nvm/versions/node/v22.4.1/bin/copilot --autopilot' },
  { pid: 601, ppid: 600, uid: UID, startedAt: T0 + 1000, command: '/Users/me/.nvm/versions/node/v22.4.1/lib/node_modules/@github/copilot/node_modules/@github/copilot-darwin-arm64/copilot --autopilot' },
  { pid: 602, ppid: 601, uid: UID, startedAt: T0 + 2000, command: 'node /Users/me/code/autochat/bin/autochat.js mcp --harness copilot' },
  // Claude Code's native install runs a binary named after its version.
  { pid: 700, ppid: 501, uid: UID, startedAt: T0 + 5000, command: '/Users/me/.local/share/claude/versions/2.1.273 --permission-mode auto' },
  { pid: 701, ppid: 700, uid: UID, startedAt: T0 + 6000, command: '/bin/zsh -c npm test' },
  // Gemini CLI relaunches itself with more memory.
  { pid: 800, ppid: 501, uid: UID, startedAt: T0 + 9000, command: 'node /opt/homebrew/bin/gemini' },
  { pid: 801, ppid: 800, uid: UID, startedAt: T0 + 9000, command: '/opt/homebrew/Cellar/node/24.1.0/bin/node --max-old-space-size=8192 /opt/homebrew/bin/gemini' },
  { pid: 900, ppid: 501, uid: UID, startedAt: T0 + 12000, command: 'pi' },
  // Not agent sessions: desktop apps, helpers, servers, quick commands, someone else's agent.
  { pid: 1000, ppid: 1, uid: UID, startedAt: T0, command: '/Applications/Claude.app/Contents/MacOS/Claude' },
  { pid: 1001, ppid: 1, uid: UID, startedAt: T0, command: '/Applications/Copilot.app/Contents/MacOS/Copilot' },
  { pid: 1002, ppid: 1, uid: UID, startedAt: T0, command: '/Users/me/Library/Caches/github-copilot-sdk/cli/copilot-sdk-runtime-1.0.102/copilot extension_bootstrap.mjs' },
  { pid: 1003, ppid: 501, uid: UID, startedAt: T0, command: 'codex mcp-server' },
  { pid: 1004, ppid: 501, uid: UID, startedAt: T0, command: 'claude mcp serve' },
  { pid: 1005, ppid: 501, uid: UID, startedAt: T0, command: 'opencode --version' },
  { pid: 1006, ppid: 1, uid: UID + 1, startedAt: T0, command: 'claude' },
  { pid: 1007, ppid: 501, uid: UID, startedAt: T0, command: 'node /Users/me/code/autochat/bin/autochat.js daemon' }
]

test('matchProcess: harness binaries and scripts, not the apps, helpers and servers that look like them', () => {
  const cases = [
    ['copilot', 'copilot'],
    ['/usr/local/bin/codex exec "fix it"', 'codex'],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec hi', 'codex'],
    ['bun /Users/me/.bun/install/global/node_modules/opencode-ai/bin/opencode', 'opencode'],
    ['/Users/me/.local/share/claude/versions/2.1.273 -p hi', 'claude'],
    ['node /x/node_modules/@anthropic-ai/claude-code/cli.js', 'claude'],
    ['node --max-old-space-size=8192 /usr/local/bin/gemini', 'gemini'],
    ['node -r /x/hook.js /usr/local/bin/gemini', 'gemini'],
    ['node /Users/me/Library/pnpm/global/5/.pnpm/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js -p x', 'pi'],
    ['pi @notes.ts', 'pi'],
    ['/Applications/Copilot.app/Contents/MacOS/Copilot', null],
    ['/Applications/Claude.app/Contents/MacOS/Claude', null],
    ['/x/copilot extension_bootstrap.mjs', null],
    ['claude mcp serve', null],
    ['codex app-server', null],
    ['opencode serve --port 4096', null],
    ['gemini --version', null],
    ['node /x/bin/autochat.js mcp --harness claude', null],
    ['node /x/bin/autochat.js hook --harness codex PreToolUse', null],
    ['vim claude.md', null],
    ['/usr/bin/python3 /x/pi.py', null],
    ['node', null],
    ['', null]
  ]
  for (const [command, want] of cases) assert.equal(P.matchProcess(command), want, command)
  assert.equal(P.matchProcess(undefined), null)
})

test('parsePs reads lstart start times; findAgents keeps the outermost process of each agent, this user only', () => {
  const rows = P.parsePs([
    '    1     0     0 Fri Oct 30 08:07:37 2026     /sbin/launchd',
    '  600   501   501 Sun Nov  1 00:27:54 2026     node /Users/me/bin/copilot --autopilot',
    'garbage'
  ].join('\n'))
  assert.deepEqual(rows.map(r => [r.pid, r.ppid, r.uid, r.command]), [[1, 0, 0, '/sbin/launchd'], [600, 501, 501, 'node /Users/me/bin/copilot --autopilot']])
  assert.equal(rows[1].startedAt, new Date(2026, 10, 1, 0, 27, 54).getTime(), 'local time, to the second')

  const agents = P.findAgents(PROCS, { uid: UID })
  assert.deepEqual(agents.map(a => [a.harness, a.pid]), [['claude', 700], ['copilot', 600], ['gemini', 800], ['pi', 900]])
  assert.equal(agents[0].startedAt, T0 + 5000)
  assert.deepEqual(P.findAgents(PROCS, { uid: UID + 1 }).map(a => a.pid), [1006], "another user's agents are theirs")
  const many = Array.from({ length: 80 }, (_, i) => ({ pid: 2000 + i, ppid: 1, command: 'claude' }))
  assert.equal(P.findAgents(many).length, P.MAX_AGENTS)
})

// A fake user whose Copilot CLI hooks are installed, and who has no others.
function user (name) {
  const home = path.join(tmp, name)
  const ctx = H.harnessContext({ env: { HOME: home, COPILOT_HOME: path.join(home, '.copilot'), PATH: '' }, node: '/n/node', bin: '/a/bin/autochat.js' })
  H.planHooks(['copilot'], ctx)[0].apply()
  return { home, ctx }
}

test('scanProcesses: where each agent works, looked up once, and whether autochat hears from it', async () => {
  const u = user('scan')
  const installedAt = fs.statSync(path.join(u.home, '.copilot', 'hooks', 'autochat.json')).mtimeMs
  let procs = [...PROCS.slice(0, 5), { ...PROCS[4], pid: 650, ppid: 501, startedAt: installedAt + 60000, command: 'copilot' }, ...PROCS.slice(5)]
  const lookups = []
  const cwds = async (pids) => { lookups.push(pids); return Object.fromEntries(pids.map(p => [p, `/Users/me/code/p${p}`])) }
  const known = new Map()
  const list = async () => procs
  const first = await P.scanProcesses({ ctx: u.ctx, list, cwds, known, now: 42 })
  assert.equal(first.scannedAt, 42)
  assert.deepEqual(first.agents.map(a => [a.harness, a.pid, a.cwd, a.hooks]), [
    ['claude', 700, '/Users/me/code/p700', notInstalled('claude')],
    ['copilot', 600, '/Users/me/code/p600', 'stale'],
    ['copilot', 650, '/Users/me/code/p650', 'installed'],
    ['gemini', 800, '/Users/me/code/p800', notInstalled('gemini')],
    ['pi', 900, '/Users/me/code/p900', notInstalled('pi')]
  ])
  assert.equal(notInstalled('claude'), 'missing', 'Claude Code has hooks, not installed here')
  assert.equal(first.agents[1].hooks, 'stale', 'Copilot CLI loads hooks when it starts: this one predates them')
  assert.deepEqual(lookups, [[700, 600, 650, 800, 900]], 'one lookup for all of them')

  await P.scanProcesses({ ctx: u.ctx, list, cwds, known })
  assert.equal(lookups.length, 1, 'known agents are not looked up again')
  procs = procs.filter(p => p.pid !== 700).concat({ pid: 710, ppid: 501, uid: UID, startedAt: T0 + 99000, command: 'claude', cwd: '/given' })
  const third = await P.scanProcesses({ ctx: u.ctx, list, cwds, known })
  assert.deepEqual(third.agents.filter(a => a.harness === 'claude').map(a => [a.pid, a.cwd]), [[710, '/given']], 'a cwd from the lister is used as is')
  assert.equal(lookups.length, 1)
  assert.ok(![...known.keys()].some(k => k.startsWith('700:')), 'gone agents are forgotten')

  // No hooks at all: missing.
  const bare = H.harnessContext({ env: { HOME: path.join(tmp, 'bare'), PATH: '' }, node: '/n/node', bin: '/a/bin/autochat.js' })
  assert.equal((await P.scanProcesses({ ctx: bare, list, cwds })).agents.find(a => a.harness === 'copilot').hooks, 'missing')
  assert.equal(await P.scanProcesses({ ctx: bare, list: async () => null }), null, 'no ps (Windows): no answer')
})

test('it only reads: no signals, no sessions', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'harness', 'procscan.js'), 'utf8')
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\.kill\(|pidAlive|adopt\(|\.handle\(/, 'no kill (not even signal 0), and nothing that tracks a session')
  const kill = process.kill
  const killed = []
  process.kill = (...args) => { killed.push(args); return true }
  try {
    const s = new P.ProcessScanner({ ctx: user('nosignal').ctx, list: async () => PROCS, cwds: async () => ({}) })
    await s.scan()
    assert.equal(s.snapshot().agents.length, 4)
  } finally {
    process.kill = kill
  }
  assert.deepEqual(killed, [])
})

test('ProcessScanner: change only when the agents change; null before the first scan', async () => {
  let procs = PROCS
  const s = new P.ProcessScanner({ ctx: user('scanner').ctx, intervalMs: 20, list: async () => procs, cwds: async (pids) => Object.fromEntries(pids.map(p => [p, '/w'])) })
  assert.equal(s.snapshot(), null)
  const changes = []
  s.on('change', (snap) => changes.push(snap.agents.length))
  s.start()
  await sleep(120)
  assert.deepEqual(changes, [4], 'rescans of the same agents are quiet')
  procs = PROCS.filter(p => p.pid !== 900)
  await sleep(80)
  assert.deepEqual(changes, [4, 3])
  s.stop()
  procs = PROCS
  await sleep(60)
  assert.deepEqual(changes, [4, 3], 'stopped')
  const snap = s.snapshot()
  snap.agents.pop()
  assert.equal(s.snapshot().agents.length, 3, 'snapshots are copies')
  assert.equal(new P.ProcessScanner({ ctx: H.harnessContext({ env: { HOME: tmp, AUTOCHAT_PROCESS_SCAN_MS: '250' } }) }).intervalMs, 250)
})

// A protocol client: newline-delimited JSON.
function client () {
  const sock = net.connect(sockPath())
  const lines = []
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('error', () => {})
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  return { lines, send: (m) => sock.write(JSON.stringify(m) + '\n'), close: () => sock.end() }
}

test('the daemon: detected agents in the lounge snapshot and in status, and you stay in the lounge', { timeout: 60000 }, async (t) => {
  const home = path.join(tmp, 'd')
  const list = path.join(tmp, 'processes.json')
  fs.writeFileSync(list, JSON.stringify(PROCS.map(p => ({ ...p, cwd: `/Users/me/code/p${p.pid}` }))))
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT)_/.test(k))),
    HOME: path.join(tmp, 'dh'),
    AUTOCHAT_HOME: home,
    COPILOT_HOME: path.join(tmp, 'dh', '.copilot'),
    AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'),
    AUTOCHAT_NO_NOTIFY: '1',
    AUTOCHAT_NO_FOCUS: '1',
    AUTOCHAT_PROCESS_LIST: list,
    AUTOCHAT_PROCESS_SCAN_MS: '100'
  }
  process.env.AUTOCHAT_HOME = home
  t.after(() => { process.env.AUTOCHAT_HOME = path.join(tmp, 'ac') })
  const daemon = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  daemon.stderr.on('data', (d) => { err += d })
  t.after(() => daemon.kill('SIGKILL'))
  let pong = null
  for (let i = 0; i < 100 && !pong; i++) {
    pong = await send({ type: 'ping' }, 300)
    if (!pong) await sleep(100)
  }
  assert.ok(pong?.daemon, err)

  const c = client()
  t.after(() => c.close())
  c.send({ type: 'subscribe', v: 1, client: 'test' })
  const latest = () => c.lines.filter(m => m.type === 'state').at(-1)
  for (let i = 0; i < 50 && !latest()?.detected?.agents?.length; i++) await sleep(50)
  const s = latest()
  assert.deepEqual(s.detected.agents.map(a => [a.harness, a.pid, a.cwd, a.hooks]), [
    ['claude', 700, '/Users/me/code/p700', notInstalled('claude')],
    ['copilot', 600, '/Users/me/code/p600', 'missing'],
    ['gemini', 800, '/Users/me/code/p800', notInstalled('gemini')],
    ['pi', 900, '/Users/me/code/p900', notInstalled('pi')]
  ])
  assert.equal(typeof s.detected.scannedAt, 'number')
  assert.equal(s.detected.agents[0].startedAt, T0 + 5000)
  const status = await send({ type: 'status' })
  assert.deepEqual(status.detected.agents.map(a => a.pid), [700, 600, 800, 900])

  // An agent exits: a new snapshot. Through all of it you never leave the lounge.
  fs.writeFileSync(list, JSON.stringify(PROCS.filter(p => p.pid !== 700)))
  for (let i = 0; i < 50 && latest().detected.agents.length !== 3; i++) await sleep(50)
  assert.deepEqual(latest().detected.agents.map(a => a.harness), ['copilot', 'gemini', 'pi'])
  await sleep(400)
  assert.ok(c.lines.filter(m => m.type === 'state').every(m => m.phase === 'lounge' && m.sessions.length === 0), 'detection never tracks a session')
  assert.deepEqual((await send({ type: 'status' })).sessions, [])
})

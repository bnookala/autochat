import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './helpers/tmp.js'
import { terminalOpener, runFile, rexBinary, harnessChain, resumeCommand, REX_SESSION_LABEL } from '../src/terminals.js'

// agents.open's opener (src/terminals.js) against a fake `rex` (test/helpers/fake-rex.mjs, through
// AUTOCHAT_REX), fake process trees, and fakes for every other program it starts (open,
// osascript, tmux, claude), through the injected run().

const tmp = tmpDir()
const FAKE_REX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-rex.mjs')
const SID = '0b7c9d36-5b2e-4c55-9d0e-6f1f3f0a8c11'

// pid, ppid, tty, command
const table = (rows) => new Map(rows.map(([pid, ppid, tty, command]) => [pid, { ppid, tty, command }]))

// The Rex app (its client's pid is 900), a Rex server, and the panes' processes.
const BASE = [
  [900, 1, null, '/Applications/Rex.app/Contents/MacOS/Rex'],
  [800, 1, null, '/Users/me/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex server run'],
  // session:work, tab 1: a shell at its prompt
  [200, 800, 'ttys001', 'login -fp me'],
  [201, 200, 'ttys001', '-zsh'],
  // session:work, tab 2: Claude Code, started from its shell
  [210, 800, 'ttys002', 'login -fp me'],
  [211, 210, 'ttys002', '-zsh'],
  [212, 211, 'ttys002', '/Users/me/.local/bin/claude'],
  [213, 212, 'ttys002', 'node /x/bin/autochat.js mcp --harness claude'],
  // session:side: a shell running `npx codex --no-daemon` (a wrapper; the harness is its child)
  [220, 800, 'ttys003', 'login -fp me'],
  [221, 220, 'ttys003', '-zsh'],
  [222, 221, 'ttys003', 'npm exec codex --no-daemon'],
  [223, 222, 'ttys003', 'node /n/bin/codex --no-daemon'],
  // Terminal.app: Copilot CLI
  [300, 1, null, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'],
  [301, 300, 'ttys004', 'login -pf me'],
  [302, 301, 'ttys004', '-zsh'],
  [303, 302, 'ttys004', 'node /n/bin/copilot'],
  // Codex's app-server, started by a TUI in session:side that has since quit
  [400, 1, null, '/Users/me/.codex/packages/app-server-daemon/releases/0.166.0/bin/codex app-server --listen unix:// --managed-daemon'],
  [401, 400, null, 'node /x/bin/autochat.js mcp --harness codex'],
  [402, 400, null, 'node /x/bin/autochat.js mcp --harness codex'],
  // The GitHub Copilot app's session
  [500, 1, null, '/Applications/GitHub Copilot.app/Contents/MacOS/github'],
  [501, 500, null, '/Users/me/.config/agency/CurrentVersion/agency copilot --server --stdio'],
  // Claude Code background session: claude daemon → bg-pty-host → bg-spare (on the host's pty)
  [600, 1, null, '/Users/me/.local/bin/claude daemon run --json-path /Users/me/.claude/daemon.json'],
  [601, 600, null, 'claude bg-pty-host --bg-pty-host /tmp/x.pty.sock 200 50 -- /Users/me/.local/share/claude/versions/2.1.317 --bg-spare /tmp/x.claim.sock'],
  [602, 601, 'ttys009', 'claude bg-spare --bg-spare /tmp/x.claim.sock'],
  // tmux: a server with a pane running opencode, and a client in Terminal.app
  [700, 1, null, 'tmux new -s dev'],
  [701, 700, 'ttys010', '-zsh'],
  [702, 701, 'ttys010', 'opencode'],
  [710, 301, 'ttys004', 'tmux attach -t dev'],
  // An unknown terminal: a harness under sshd
  [750, 1, null, 'sshd: me@ttys011'],
  [751, 750, 'ttys011', '-zsh'],
  [752, 751, 'ttys011', '/usr/local/bin/claude']
]

const APP = { client_id: 'client:app-bf3076', info: { kind: 'app', platform: 'macos', name: 'Rex', label: 'my mac' }, principal: { transport: 'unix', pid: 900 }, connection_state: 'connected', session_ids: ['session:work'] }
const pane = (child, fg, between = []) => ({ last_exit: null, child: { pid: child, name: 'login' }, foreground: { pid: fg, name: 'x' }, ancestors: fg === child ? null : [...between.map(pid => ({ pid })), { pid: child }] })
const WORLD = {
  next: 0,
  sessions: [{ session_id: 'session:work', label: 'work' }, { session_id: 'session:side', label: 'side' }],
  blocks: {
    'session:work': [
      { block_id: 'block:w1', window_id: 'window:w1', creator_name: 'com.superlogical.terminal' },
      { block_id: 'block:w2', window_id: 'window:w2', creator_name: 'com.superlogical.terminal' },
      { block_id: 'block:wb', window_id: 'window:w2', creator_name: 'com.superlogical.browser' }
    ],
    'session:side': [{ block_id: 'block:s1', window_id: 'window:s1', creator_name: 'com.superlogical.terminal' }]
  },
  process: {
    'block:w1': pane(200, 201),
    'block:w2': pane(210, 212, [211]),
    'block:s1': pane(220, 222, [221])
  },
  clients: [APP, { client_id: 'client:cli', info: { kind: 'cli' }, principal: { transport: 'unix', pid: 1234 }, connection_state: 'connected' }]
}

let n = 0
// A fresh world and recorders for one test. `answers` fakes programs other than rex: name →
// (args) => {code, stdout, stderr}.
function fixture ({ world = {}, answers = {}, rex = true, env = {}, platform = 'darwin' } = {}) {
  const dir = path.join(tmp, `t${++n}`)
  fs.mkdirSync(dir, { recursive: true })
  const worldFile = path.join(dir, 'world.json')
  fs.writeFileSync(worldFile, JSON.stringify({ ...structuredClone(WORLD), ...world }))
  const rexLog = path.join(dir, 'rex.log')
  fs.writeFileSync(rexLog, '')
  const rexBin = path.join(dir, 'rex')
  fs.writeFileSync(rexBin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_REX}" "$@"\n`, { mode: 0o755 })
  const calls = []
  const focused = []
  const run = (cmd, args, opts) => {
    if (cmd === rexBin) return runFile(cmd, args, opts)
    calls.push([path.basename(cmd), ...args])
    const answer = answers[path.basename(cmd)]
    return Promise.resolve(answer ? answer(args) : { code: 0, stdout: '', stderr: '' })
  }
  const opener = terminalOpener({
    env: { PATH: '/usr/bin:/bin', AUTOCHAT_REX: rex ? rexBin : 'off', FAKE_REX_WORLD: worldFile, FAKE_REX_LOG: rexLog, REX_SESSION: 'session:daemon', ...env },
    run,
    processes: async () => table(BASE),
    focus: (o) => focused.push(o),
    platform
  })
  return {
    open: (agent) => opener.open({ present: true, shared: false, pid: null, cwd: dir, title: null, sessionId: null, terminal: null, ...agent }),
    calls,
    focused,
    dir,
    rexCalls: () => fs.readFileSync(rexLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).filter(a => !['--autostart=false', '--timeout', '3s'].includes(a))),
    world: () => JSON.parse(fs.readFileSync(worldFile, 'utf8'))
  }
}

const NO_TERMINAL = { rex: null, tmux: null, program: null, bundleId: null, tty: null }
const select = (session, window) => ['-C', APP.client_id, 'do', 'session.select', `session_id=${session}`, `window_id=${window}`]

test('Rex: the pane whose processes hold the harness; its tab is shown and Rex comes to the front', async () => {
  const f = fixture()
  const r = await f.open({ id: 'a1', name: 'claude-web', harness: 'claude', harnessPid: 212, terminal: { ...NO_TERMINAL, tty: 'ttys002' } })
  assert.deepEqual(r, { opened: 'rex', detail: 'its Rex pane (block:w2)' })
  const calls = f.rexCalls()
  assert.deepEqual([...calls.slice(0, 2), ...calls.slice(2, 4).sort(), ...calls.slice(4)], [
    ['ls', '--json'],
    ['block', 'ls', '-s', 'session:work', '--json'],
    // These two run at once.
    ['block', 'call', '-s', 'session:work', '-b', 'block:w1', 'process'],
    ['block', 'call', '-s', 'session:work', '-b', 'block:w2', 'process'],
    ['focus', '-s', 'session:work', 'block:w2'],
    ['client', 'ls', '--json'],
    select('session:work', 'window:w2')
  ], 'only terminal blocks are asked; the search stops at the first session that has it')
  assert.deepEqual(f.calls, [['open', '-a', '/Applications/Rex.app']])

  // A wrapper in the pane (npm exec codex): the harness is one of its children.
  const g = fixture()
  assert.equal((await g.open({ id: 'a2', name: 'codex-cli', harness: 'codex', harnessPid: 223 })).opened, 'rex')
  assert.deepEqual(g.rexCalls().at(-1), select('session:side', 'window:s1'))
})

test('Rex: the hello\'s pane is checked first; a stale one is skipped and the panes are searched', async () => {
  // Verified: no listing at all.
  const f = fixture()
  const hinted = { ...NO_TERMINAL, rex: { session: 'session:work', block: 'block:w2' }, tty: 'ttys002' }
  assert.equal((await f.open({ id: 'a1', name: 'claude-web', harness: 'claude', harnessPid: 212, terminal: hinted })).opened, 'rex')
  assert.deepEqual(f.rexCalls().slice(0, 3), [
    ['block', 'call', '-s', 'session:work', '-b', 'block:w2', 'process'],
    ['block', 'inspect', '-s', 'session:work', 'block:w2', '--json'],
    ['focus', '-s', 'session:work', 'block:w2']
  ])

  // Stale: the hinted pane runs something else now (Claude was started there and moved on).
  const g = fixture()
  const stale = { ...hinted, rex: { session: 'session:work', block: 'block:w1' } }
  assert.equal((await g.open({ id: 'a1', name: 'claude-web', harness: 'claude', harnessPid: 212, terminal: stale })).opened, 'rex')
  const calls = g.rexCalls()
  assert.deepEqual(calls[0], ['block', 'call', '-s', 'session:work', '-b', 'block:w1', 'process'])
  assert.ok(!calls.some(c => c[0] === 'block' && c[1] === 'call' && c[5] === 'block:w1' && c !== calls[0]), 'the stale pane isn\'t asked twice')
  assert.deepEqual(calls.at(-1), select('session:work', 'window:w2'))

  // A hint to a pane that's gone, and no pane holds the harness (it runs over ssh): not Rex.
  const h = fixture()
  const gone = { ...NO_TERMINAL, rex: { session: 'session:gone', block: 'block:gone' }, tty: 'ttys011' }
  await assert.rejects(h.open({ id: 'a3', name: 'claude-ssh', harness: 'claude', harnessPid: 752, terminal: gone }), { message: "claude-ssh runs in a terminal autochat can't find (ttys011)" })
  assert.ok(!h.rexCalls().some(c => c[0] === 'focus' || c[0] === '-C'))
})

test('tmux: the hello\'s pane is selected, its client switches to it, and the terminal showing tmux comes to the front', async () => {
  const tmux = { socket: '/private/tmp/tmux-501/default', pane: '%3' }
  const f = fixture({
    answers: {
      tmux: (args) => {
        if (args.includes('list-panes')) return { code: 0, stdout: '%1\t650\tother\n%3\t701\tdev\n', stderr: '' }
        if (args.includes('list-clients')) return { code: 0, stdout: '710\tdev\t/dev/ttys004\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      }
    }
  })
  const r = await f.open({ id: 'a1', name: 'opencode-x', harness: 'opencode', harnessPid: 702, terminal: { ...NO_TERMINAL, tmux, program: 'tmux', tty: 'ttys010' } })
  assert.deepEqual(r, { opened: 'tmux', detail: 'its tmux pane (%3)' })
  const S = ['tmux', '-S', tmux.socket]
  assert.deepEqual(f.calls, [
    [...S, 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}'],
    [...S, 'list-clients', '-F', '#{client_pid}\t#{client_session}\t#{client_name}'],
    [...S, 'switch-client', '-c', '/dev/ttys004', '-t', '%3'],
    [...S, 'select-window', '-t', '%3'],
    [...S, 'select-pane', '-t', '%3'],
    ['open', '-a', '/System/Applications/Utilities/Terminal.app']
  ], 'the client runs in Terminal.app, not in a Rex pane')
  assert.ok(!f.rexCalls().some(c => c[0] === 'focus'), 'no Rex pane holds opencode')
})

test('Terminal, iTerm, Ghostty: the harness\'s terminal app comes to the front, through focusOrigin()', async () => {
  const f = fixture()
  const r = await f.open({ id: 'a1', name: 'copilot-x', harness: 'copilot', harnessPid: 303, terminal: { ...NO_TERMINAL, program: 'Apple_Terminal', bundleId: 'com.apple.Terminal', tty: 'ttys004' } })
  assert.deepEqual(r, { opened: 'terminal', detail: 'Terminal' })
  assert.deepEqual(f.focused, [{ termProgram: 'Apple_Terminal', bundleId: 'com.apple.Terminal' }])
  assert.deepEqual(f.calls, [])
  // Linux has no focusOrigin() for terminal apps.
  const g = fixture({ platform: 'linux' })
  await assert.rejects(g.open({ id: 'a1', name: 'copilot-x', harness: 'copilot', harnessPid: 303, terminal: { ...NO_TERMINAL, program: 'Apple_Terminal', tty: 'ttys004' } }), { message: "copilot-x runs in a terminal autochat can't find (ttys004)" })
})

test('the GitHub Copilot app: Copilot sessions it runs open there, at the session', async () => {
  const f = fixture()
  const app = { ...NO_TERMINAL, bundleId: 'com.github.githubapp' }
  const r = await f.open({ id: 'a1', name: 'copilot-app', harness: 'copilot', harnessPid: 501, sessionId: SID, terminal: app })
  assert.deepEqual(r, { opened: 'app', detail: 'the GitHub Copilot app, at its session' })
  assert.deepEqual(f.calls, [['open', '-b', 'com.github.githubapp', `ghapp://sessions/${SID}`]])
  assert.deepEqual(f.rexCalls(), [], 'no terminal to look for: the harness has none')
  // Without a session id: just the app. A failure is one line.
  const g = fixture({ answers: { open: () => ({ code: 1, stdout: '', stderr: 'LSOpenURLsWithRole() failed with error -10814\nmore\n' }) } })
  await assert.rejects(g.open({ id: 'a1', name: 'copilot-app', harness: 'copilot', harnessPid: 501, terminal: app }), { message: "couldn't open the GitHub Copilot app: LSOpenURLsWithRole() failed with error -10814" })
  assert.deepEqual(g.calls, [['open', '-b', 'com.github.githubapp']])
})

test('Codex in its app-server: `codex resume <id>` in a new tab of Rex\'s autochat session, created once and reused', async () => {
  const f = fixture()
  const codex = (id, title, sessionId) => ({ id, name: `codex-${id}`, title, harness: 'codex', harnessPid: 400, shared: true, sessionId })
  const r1 = await f.open(codex('a1', 'Fix the parser', SID))
  assert.deepEqual(r1, { opened: 'new-tab', detail: `codex resume ${SID}, in a new tab of Rex's autochat session (new)` })
  const created = f.world().sessions.find(s => s.label === REX_SESSION_LABEL)
  assert.ok(created)
  const [tab] = f.world().blocks[created.session_id]
  assert.deepEqual([tab.label, tab.cwd, tab.command], ['Fix the parser', f.dir, ['codex', 'resume', SID]])
  assert.deepEqual(f.rexCalls(), [
    ['ls', '--json'],
    ['client', 'ls', '--json'],
    ['new', 'autochat', '--window=Fix the parser', '-c', f.dir, '--json', '--', 'codex', 'resume', SID],
    select(created.session_id, tab.window_id)
  ], 'the app-server serves several sessions: no pane is searched')
  assert.deepEqual(f.calls, [['open', '-a', '/Applications/Rex.app']])

  // The second one reuses the session. Without a session id yet (no tool call): the picker.
  const r2 = await f.open(codex('a2', '--weird title', null))
  assert.equal(r2.detail, "codex resume, in a new tab of Rex's autochat session")
  assert.deepEqual(f.rexCalls().find(c => c[0] === 'window'), ['window', 'new', '-s', created.session_id, 'weird title', '-c', f.dir, '--json', '--', 'codex', 'resume'])
  assert.equal(f.world().sessions.filter(s => s.label === REX_SESSION_LABEL).length, 1)

  // One Codex session alone in its app-server is no different.
  const g = fixture()
  assert.equal((await g.open({ ...codex('a3', 'x', SID), shared: false })).opened, 'new-tab')
  assert.ok(!g.rexCalls().some(c => c[1] === 'call'))
})

test('no Rex (AUTOCHAT_REX=off, no server, no app open): the resume command in a new Terminal window', async () => {
  const cases = [
    fixture({ rex: false }),
    fixture({ world: { down: true } }),
    fixture({ world: { clients: [] } })
  ]
  for (const f of cases) {
    const r = await f.open({ id: 'a1', name: 'codex-x', harness: 'codex', harnessPid: 400, shared: true, sessionId: SID })
    assert.deepEqual(r, { opened: 'new-tab', detail: `codex resume ${SID}, in a new Terminal window` })
    const script = f.calls.find(c => c[0] === 'osascript')
    assert.deepEqual(script.slice(-1), [`cd '${f.dir}' && 'codex' 'resume' '${SID}'`])
    assert.ok(script.includes('do script (item 1 of argv)'))
    assert.ok(!f.rexCalls().some(c => c[0] === 'new' || c[0] === 'window'))
  }
  // A cwd with a quote in it stays one argument; a cwd that's gone is left out.
  const g = fixture({ rex: false })
  const odd = path.join(g.dir, "it's here")
  fs.mkdirSync(odd)
  await g.open({ id: 'a1', name: 'pi-x', harness: 'pi', harnessPid: null, sessionId: 'abc123', cwd: odd })
  assert.equal(g.calls[0].at(-1), `cd '${g.dir}/it'\\''s here' && 'pi' '--session' 'abc123'`)
  await g.open({ id: 'a1', name: 'pi-x', harness: 'pi', harnessPid: null, cwd: path.join(g.dir, 'gone') })
  assert.equal(g.calls[1].at(-1), "'pi' '--resume'")
  // osascript failing.
  const h = fixture({ rex: false, answers: { osascript: () => ({ code: 1, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)\n' }) } })
  await assert.rejects(h.open({ id: 'a1', name: 'codex-x', harness: 'codex', harnessPid: 400, shared: true }), { message: "couldn't open a Terminal window: execution error: Not authorized to send Apple events to Terminal. (-1743)" })
  // Not a Mac, no Rex.
  const l = fixture({ rex: false, platform: 'linux' })
  await assert.rejects(l.open({ id: 'a1', name: 'codex-x', harness: 'codex', harnessPid: 400, shared: true }), { message: "codex-x has no terminal to open, and there's no Rex to resume it in" })
})

test('Claude Code background sessions: `claude attach <id>`, from `claude agents --json`; else `claude --resume`', async () => {
  const jobs = [
    { pid: 1, id: 'aaaa1111', cwd: '/w', kind: 'background', startedAt: 1, sessionId: 'other', state: 'working' },
    { pid: 602, id: '79c3607a', cwd: '/w', kind: 'background', startedAt: 2, sessionId: SID, name: 'fix it', status: 'busy', state: 'working' },
    { pid: 47853, cwd: '/w', kind: 'interactive', startedAt: 3, sessionId: 'x' }
  ]
  const f = fixture({ answers: { claude: () => ({ code: 0, stdout: JSON.stringify(jobs, null, 2), stderr: '' }) } })
  // Its env still names the pane `claude` was first started in: that pane holds no part of it.
  const bg = { ...NO_TERMINAL, rex: { session: 'session:work', block: 'block:w2' }, tty: 'ttys009' }
  const r = await f.open({ id: 'a1', name: 'claude-bg', title: 'Background work', harness: 'claude', harnessPid: 602, sessionId: SID, terminal: bg })
  assert.equal(r.opened, 'new-tab')
  assert.deepEqual(f.calls[0], ['claude', 'agents', '--json'])
  assert.deepEqual(f.rexCalls().find(c => c[0] === 'new').slice(-3), ['claude', 'attach', '79c3607a'])
  assert.ok(!f.rexCalls().some(c => c[1] === 'call'), 'a background session is in no pane')

  // No such job (or no `claude` on PATH): resume it by its session id.
  const g = fixture({ answers: { claude: () => ({ code: -1, stdout: '', stderr: 'spawn claude ENOENT' }) } })
  await g.open({ id: 'a1', name: 'claude-bg', harness: 'claude', harnessPid: 602, sessionId: SID, terminal: bg })
  assert.deepEqual(g.rexCalls().find(c => c[0] === 'new').slice(-3), ['claude', '--resume', SID])
  // A Claude Code that isn't a background session isn't asked.
  assert.deepEqual(await resumeCommand({ harness: 'claude', sessionId: SID }, { run: () => assert.fail('asked') }, { command: '/usr/local/bin/claude' }), ['claude', '--resume', SID])
})

test('agents that left, and harnesses autochat can\'t resume', async () => {
  // Left: its pid may be another process's by now, so no pane is looked for.
  const f = fixture()
  const r = await f.open({ id: 'a1', name: 'claude-web', harness: 'claude', harnessPid: 212, present: false, sessionId: SID, terminal: { ...NO_TERMINAL, tty: 'ttys002' } })
  assert.equal(r.opened, 'new-tab')
  assert.deepEqual(f.rexCalls().find(c => c[0] === 'new').slice(-3), ['claude', '--resume', SID])
  assert.ok(!f.rexCalls().some(c => c[1] === 'call'))

  const g = fixture()
  await assert.rejects(g.open({ id: 'a1', name: 'gemini-x', harness: 'gemini', harnessPid: null }), { message: "gemini-x has no terminal to open, and autochat can't resume Gemini CLI sessions" })
  await assert.rejects(g.open({ id: 'a1', name: 'agent-x', harness: 'agent', harnessPid: null }), { message: "agent-x has no terminal to open, and autochat can't resume agent sessions" })

  // Session ids that aren't ids are never put in a command.
  assert.deepEqual(await resumeCommand({ harness: 'copilot', sessionId: SID }), ['copilot', `--resume=${SID}`])
  assert.deepEqual(await resumeCommand({ harness: 'copilot', sessionId: '$(rm -rf ~)' }), ['copilot', '--resume'])
  assert.deepEqual(await resumeCommand({ harness: 'opencode', sessionId: 'ses_abc' }), ['opencode', '-s', 'ses_abc'])
  assert.deepEqual(await resumeCommand({ harness: 'opencode' }), ['opencode'])
})

test('the rex binary: AUTOCHAT_REX, else rex on PATH, else $REX_BIN_DIR/rex, else the Rex Server app\'s', () => {
  const have = (...paths) => (p) => paths.includes(p)
  const bundled = '/h/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex'
  const opts = (exists) => ({ exists, home: '/h' })
  assert.equal(rexBinary({ AUTOCHAT_REX: '/x/rex', PATH: '/bin' }, opts(have('/x/rex', '/bin/rex'))), '/x/rex')
  assert.equal(rexBinary({ AUTOCHAT_REX: 'off', PATH: '/bin' }, opts(have('/bin/rex', bundled))), null, 'set, but not a program: no Rex')
  assert.equal(rexBinary({ PATH: '/usr/bin:/bin' }, opts(have('/bin/rex', bundled))), '/bin/rex')
  assert.equal(rexBinary({ PATH: 'relative:/usr/bin', REX_BIN_DIR: '/r' }, opts(have('relative/rex', '/r/rex', bundled))), '/r/rex')
  assert.equal(rexBinary({ PATH: '/usr/bin' }, opts(have(bundled))), bundled)
  assert.equal(rexBinary({ PATH: '/usr/bin' }, opts(have())), null)
})

test('harnessChain: the harness and the ancestors that share its terminal', () => {
  const procs = table(BASE)
  assert.deepEqual(harnessChain(procs, 212), [212, 211, 210], 'claude, its shell, the pane\'s login')
  assert.deepEqual(harnessChain(procs, 602), [602], 'a background session: its pty is its host\'s')
  assert.deepEqual(harnessChain(procs, 400), [400], 'no terminal: only itself')
})

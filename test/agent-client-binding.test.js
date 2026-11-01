import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-binding-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
const { matchHarness, parseRemote, bindSession } = await import('../src/agent-client.js')

test('harness detection: package paths and binaries; remotes → owner/repo', () => {
  assert.equal(matchHarness('node /Users/me/.nvm/versions/node/v22/bin/copilot --autopilot'), 'copilot')
  assert.equal(matchHarness('/Users/me/.nvm/v22/lib/node_modules/@github/copilot/node_modules/@github/copilot-darwin-arm64/copilot'), 'copilot')
  assert.equal(matchHarness('claude --continue'), 'claude')
  assert.equal(matchHarness('node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js'), 'gemini')
  assert.equal(matchHarness('/opt/homebrew/bin/opencode'), 'opencode')
  assert.equal(matchHarness('node /Users/me/Library/pnpm/global/5/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'), 'pi')
  assert.equal(matchHarness('codex exec "fix it"'), 'codex')
  assert.equal(matchHarness('/bin/zsh -l'), null)
  assert.equal(matchHarness('node /x/bin/autochat.js mcp --harness copilot'), null, 'our own flags are not a harness')

  for (const url of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git/', 'ssh://git@github.com/owner/repo.git', 'https://x-access-token@ghe.example.com/owner/repo']) {
    assert.equal(parseRemote(url), 'owner/repo', url)
  }
  assert.equal(parseRemote(''), null)

  // The nearest matching ancestor; --harness picks which one.
  const table = new Map([
    [100, { ppid: 90, command: 'node /x/bin/autochat.js mcp' }],
    [90, { ppid: 80, command: '/bin/sh -c node /x/bin/autochat.js mcp' }],
    [80, { ppid: 70, command: 'claude' }],
    [70, { ppid: 1, command: 'node /n/bin/copilot' }]
  ])
  const none = path.join(tmp, 'not-a-repo')
  fs.mkdirSync(none, { recursive: true })
  const auto = bindSession({ env: {}, cwd: none, ps: () => table, pid: 100 })
  assert.deepEqual([auto.harness, auto.harnessPid], ['claude', 80])
  assert.deepEqual([auto.hello.repo, auto.hello.branch, auto.hello.worktree], [null, null, null], 'null outside git')
  const flagged = bindSession({ harness: 'copilot', env: {}, cwd: none, ps: () => table, pid: 100 })
  assert.deepEqual([flagged.harness, flagged.harnessPid], ['copilot', 70])
  const hinted = bindSession({ env: { CLAUDECODE: '1', AUTOCHAT_AGENT_NAME: 'Reviewer' }, cwd: none, ps: () => new Map(), pid: 100 })
  assert.deepEqual([hinted.harness, hinted.harnessPid, hinted.hello.name], ['claude', null, 'Reviewer'])
  assert.equal(bindSession({ env: {}, cwd: none, ps: () => new Map(), pid: 100 }).harness, 'agent')
})

test('session titles: Copilot\'s session name from its workspace.yaml, in the hello; read again by status', async () => {
  const { yamlField, sessionTitle } = await import('../src/agent-client/binding.js')
  const yaml = (v) => yamlField(`id: x\ncwd: /w\nname: ${v}\r\nsummary: s\n`, 'name')
  assert.equal(yaml('Lolchat macos menu bar app'), 'Lolchat macos menu bar app')
  assert.equal(yaml('What can you do?'), 'What can you do?')
  assert.equal(yaml('"Fix: the \\"bug\\" \\u00e9\\x41"'), 'Fix: the "bug" éA')
  assert.equal(yaml("'It''s done # here'"), "It's done # here")
  assert.equal(yaml('Fix it # a comment'), 'Fix it')
  for (const v of ['', '~', 'null', '|-', '"unterminated']) assert.equal(yaml(v), null, v)
  assert.equal(yamlField('  name: nested\n', 'name'), null, 'top-level keys only')

  // COPILOT_HOME/session-state/<COPILOT_AGENT_SESSION_ID>/workspace.yaml
  const home = path.join(tmp, 'copilot-home')
  const sid = '0b7c9d36-5b2e-4c55-9d0e-6f1f3f0a8c11'
  const ws = path.join(home, 'session-state', sid)
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `id: ${sid}\ncwd: /w\nsummary_count: 0\n`)
  const env = { COPILOT_HOME: home, COPILOT_AGENT_SESSION_ID: sid }
  const none = path.join(tmp, 'not-a-repo')
  fs.mkdirSync(none, { recursive: true })
  const unnamed = bindSession({ harness: 'copilot', env, cwd: none, ps: () => new Map(), pid: 100 })
  assert.deepEqual([unnamed.sessionId, unnamed.hello.sessionId, unnamed.hello.title], [sid, sid, null], 'not named yet')
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `id: ${sid}\ncwd: /w\nname: Lolchat macos menu bar app\nsummary_count: 0\n`)
  assert.equal(unnamed.readTitle(), 'Lolchat macos menu bar app', 'read again later')
  const named = bindSession({ harness: 'copilot', env, cwd: none, ps: () => new Map(), pid: 100 })
  assert.equal(named.hello.title, 'Lolchat macos menu bar app')
  assert.deepEqual(Object.keys(named.hello), ['type', 'v', 'harness', 'name', 'pid', 'harnessPid', 'sessionId', 'cwd', 'repo', 'branch', 'worktree', 'title', 'resume'])
  assert.equal(bindSession({ harness: 'claude', env: { ...env, CLAUDE_CODE_SESSION_ID: sid }, cwd: none, ps: () => new Map(), pid: 100 }).hello.title, null, 'only Copilot\'s')
  assert.equal(sessionTitle({ harness: 'copilot', sessionId: '../../etc', env }), null, 'session ids are checked')
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `name: "${'x'.repeat(120)}"\n`)
  assert.equal(Array.from(sessionTitle({ harness: 'copilot', sessionId: sid, env })).length, 80)
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `name: use ${['ghp', 'a'.repeat(36)].join('_')}\n`)
  assert.equal(sessionTitle({ harness: 'copilot', sessionId: sid, env }), null, 'never a secret')

  // The status tool sends the session's title when it changed since the hello, once.
  const { Tools } = await import('../src/agent-client.js')
  const sent = []
  let limited = false
  const link = { hello: { title: null }, agent: null, request: async (cmd, args) => { sent.push(args); return limited ? { ok: false, error: 'rate limited' } : { ok: true, result: { card: {} }, inbox: {} } } }
  let title = null
  const tools = new Tools({ link, session: { cwd: none, top: null, readTitle: () => title } })
  await tools.status({ summary: 'a' })
  title = 'Readable names'
  limited = true
  assert.equal((await tools.call('status', { summary: 'b' })).isError, true)
  limited = false
  await tools.status({ summary: 'b' })
  await tools.status({ summary: 'c' })
  title = 'Renamed'
  await tools.status({ title: 'My own', parent: 'lead' })
  assert.deepEqual(sent, [{ summary: 'a' }, { summary: 'b', title: 'Readable names' }, { summary: 'b', title: 'Readable names' }, { summary: 'c' }, { title: 'My own', parent: 'lead' }], 'until a status that carries it succeeds')
  assert.equal(link.hello.title, 'Renamed', 'a reconnect says hello with the newest title')

  // pi: the session's /name.
  const { register } = await import('../src/harness/pi-extension.js')
  const handlers = {}
  const pi = { on: (e, fn) => { handlers[e] = fn }, registerTool () {} }
  const out = await register(pi, { room: true, env: {}, joinDelayMs: 60000 })
  handlers.session_start({ reason: 'startup' }, { cwd: none, hasUI: false, sessionManager: { getSessionId: () => 'pi-1', getSessionName: () => 'Teach pi the room' } })
  assert.deepEqual([out.room.link.hello.harness, out.room.link.hello.sessionId, out.room.link.hello.title], ['pi', 'pi-1', 'Teach pi the room'])
  handlers.session_shutdown({ reason: 'quit' })
})

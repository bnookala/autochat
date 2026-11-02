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

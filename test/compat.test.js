// Compatibility with installs from before the lolchat → autochat rename.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { envVar } from '../src/env.js'
import { migrateLegacyHome } from '../src/paths.js'
import { parseRoom, topicFor, roomKeyFor, roomTagFor, DIRECTORY_TOPIC } from '../src/protocol.js'
import { handleFor } from '../src/identity.js'
import { appInstalled, APP_BUNDLE_ID } from '../src/launcher.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-compat-'))

// The parent env, minus anything that would point the CLI at a real home. No harness binaries
// either: `autochat uninstall` would otherwise ask the real `claude` about its MCP servers.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT)_|^(COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR)$/.test(k)))
const cli = (args, env) => spawnSync(process.execPath, [BIN, ...args], {
  env: { ...baseEnv, AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_HARNESS_PATH: path.join(tmp, 'no-harnesses'), ...env },
  encoding: 'utf8'
})
const sha = (s) => crypto.createHash('sha256').update(s).digest()

test('AUTOCHAT_* env vars fall back to LOLCHAT_*', () => {
  assert.equal(envVar('HOME', {}), undefined)
  assert.equal(envVar('HOME', { LOLCHAT_HOME: '/old' }), '/old')
  assert.equal(envVar('HOME', { LOLCHAT_HOME: '/old', AUTOCHAT_HOME: '/new' }), '/new')
  assert.equal(envVar('DEBUG', { LOLCHAT_DEBUG: '1', AUTOCHAT_DEBUG: '' }), '', 'a set AUTOCHAT_ var wins, even empty')

  const apps = path.join(tmp, 'apps')
  fs.mkdirSync(path.join(apps, 'AutoChat.app', 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(apps, 'AutoChat.app', 'Contents', 'Info.plist'), `<plist><string>${APP_BUNDLE_ID}</string></plist>`)
  assert.equal(appInstalled({ LOLCHAT_APP_DIRS: apps }), path.join(apps, 'AutoChat.app'))

  // Through the CLI: LOLCHAT_HOME alone still picks the state dir.
  const old = path.join(tmp, 'legacy-env')
  assert.equal(cli(['config', 'countdown', '7'], { LOLCHAT_HOME: old }).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'config.json'), 'utf8')).countdownSeconds, 7)
  const both = path.join(tmp, 'new-env')
  assert.equal(cli(['config', 'countdown', '9'], { LOLCHAT_HOME: old, AUTOCHAT_HOME: both }).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(both, 'config.json'), 'utf8')).countdownSeconds, 9)
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'config.json'), 'utf8')).countdownSeconds, 7)
})

test('first run moves ~/.lolchat to ~/.autochat, keeping the identity and handle', () => {
  const user = path.join(tmp, 'user')
  const legacy = path.join(user, '.lolchat')
  const home = path.join(user, '.autochat')
  // An install from before the rename: identity and config in ~/.lolchat.
  const before = cli(['whoami'], { HOME: user, LOLCHAT_HOME: legacy })
  assert.equal(before.status, 0, before.stderr)
  assert.equal(cli(['join', 'rustaceans'], { HOME: user, LOLCHAT_HOME: legacy }).status, 0)
  assert.ok(fs.existsSync(path.join(legacy, 'identity.json')))
  assert.ok(!fs.existsSync(home))

  const after = cli(['whoami'], { HOME: user })
  assert.equal(after.status, 0, after.stderr)
  assert.equal(after.stdout, before.stdout, 'same handle')
  assert.ok(!fs.existsSync(legacy), 'moved, not copied')
  assert.ok(fs.existsSync(path.join(home, 'identity.json')))
  assert.equal(cli(['config', 'room'], { HOME: user }).stdout.trim(), '"rustaceans"')

  // Only once: a ~/.lolchat that shows up later (an old CLI still running) is left alone.
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'identity.json'), '{}')
  assert.equal(cli(['whoami'], { HOME: user }).stdout, before.stdout)
  assert.equal(fs.readFileSync(path.join(legacy, 'identity.json'), 'utf8'), '{}')

  // `autochat setup` says so when it's the one doing the move.
  const user2 = path.join(tmp, 'user2')
  const old = cli(['whoami'], { HOME: user2, LOLCHAT_HOME: path.join(user2, '.lolchat') }).stdout.trim()
  const setup = cli(['setup'], { HOME: user2, COPILOT_HOME: path.join(user2, '.copilot') })
  assert.equal(setup.status, 0, setup.stderr)
  assert.match(setup.stdout, /moved .*\.lolchat → .*\.autochat/)
  assert.match(setup.stdout, new RegExp('you are +' + old))
})

test('migrateLegacyHome never clobbers, and ignores non-directories', () => {
  const a = path.join(tmp, 'm-a')
  const b = path.join(tmp, 'm-b')
  assert.equal(migrateLegacyHome(a, b), false, 'nothing to move')
  fs.writeFileSync(a, 'not a dir')
  assert.equal(migrateLegacyHome(a, b), false)
  fs.rmSync(a)
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  assert.equal(migrateLegacyHome(a, b), false, 'target exists')
  assert.ok(fs.existsSync(a))
})

test('setup replaces the stale lolchat.json hook; uninstall removes both', () => {
  const user = path.join(tmp, 'hooks-user')
  const copilot = path.join(user, '.copilot')
  const hooks = path.join(copilot, 'hooks')
  const env = { HOME: user, AUTOCHAT_HOME: path.join(user, '.autochat'), COPILOT_HOME: copilot }
  fs.mkdirSync(hooks, { recursive: true })
  fs.writeFileSync(path.join(hooks, 'lolchat.json'), '{"version":1,"hooks":{}}\n')
  fs.writeFileSync(path.join(hooks, 'other.json'), '{}\n')

  const setup = cli(['setup'], env)
  assert.equal(setup.status, 0, setup.stderr)
  assert.match(setup.stdout, /removed the old lolchat hooks/)
  assert.deepEqual(fs.readdirSync(hooks).sort(), ['autochat.json', 'other.json'])
  const cfg = JSON.parse(fs.readFileSync(path.join(hooks, 'autochat.json'), 'utf8'))
  assert.match(cfg.hooks.preToolUse[0].bash, /bin\/autochat\.js' hook preToolUse \|\| true$/)

  fs.writeFileSync(path.join(hooks, 'lolchat.json'), '{}\n')
  const un = cli(['uninstall'], env)
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /hooks removed/)
  assert.deepEqual(fs.readdirSync(hooks), ['other.json'])
  assert.match(cli(['uninstall'], env).stdout, /not installed/)
})

test('P2P identifiers keep the lolchat names, so old and new peers still meet', () => {
  const lobby = parseRoom('lobby')
  assert.deepEqual(topicFor(lobby), sha('lolchat:v1:topic:pub:lobby'))
  assert.deepEqual(roomKeyFor(lobby), sha('lolchat:v1:roomkey:pub:lobby'))
  assert.equal(roomTagFor(lobby), sha('lolchat:v1:roomtag:' + sha('lolchat:v1:roomkey:pub:lobby').toString('hex')).toString('hex').slice(0, 32))
  assert.deepEqual(DIRECTORY_TOPIC, sha('lolchat:v1:directory'))
  assert.equal(handleFor('00'.repeat(32)), 'bold-robin-2c', 'handles are derived as before')
  assert.equal(parseRoom('lc1-brave-otter-abcd2345efgh').isPublic, false, 'old invite codes still parse')
})

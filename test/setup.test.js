import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-setup-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const { configureLaunch } = await import('../src/setup.js')
const { loadConfig, saveConfig } = await import('../src/config.js')
const { APP_BUNDLE_ID } = await import('../src/launcher.js')

const apps = path.join(tmp, 'apps')
fs.mkdirSync(path.join(apps, 'AutoChat.app', 'Contents'), { recursive: true })
fs.writeFileSync(path.join(apps, 'AutoChat.app', 'Contents', 'Info.plist'), `<plist><string>${APP_BUNDLE_ID}</string></plist>`)
const withApp = { AUTOCHAT_APP_DIRS: apps }
const noApp = { AUTOCHAT_APP_DIRS: path.join(tmp, 'nowhere') }

test('configureLaunch switches to launch=app only on macOS with AutoChat.app installed', () => {
  saveConfig({ launch: 'auto' })
  assert.deepEqual(configureLaunch({ platform: 'darwin', env: noApp }), { app: null, launch: 'auto', previous: 'auto', method: 'terminal' })
  assert.deepEqual(configureLaunch({ platform: 'linux', env: withApp }), { app: null, launch: 'auto', previous: 'auto', method: 'notify' })
  assert.equal(loadConfig().launch, 'auto')

  saveConfig({ launch: 'tmux' })
  const r = configureLaunch({ platform: 'darwin', env: withApp })
  assert.deepEqual(r, { app: path.join(apps, 'AutoChat.app'), launch: 'app', previous: 'tmux', method: 'app' })
  assert.equal(loadConfig().launch, 'app')
  assert.equal(configureLaunch({ platform: 'darwin', env: withApp }).previous, 'app', 'idempotent')

  saveConfig({ launch: 'off' })
  assert.equal(configureLaunch({ platform: 'darwin', env: withApp }).launch, 'off', "doesn't undo the app's Pause")
  assert.equal(loadConfig().launch, 'off')
})

test('autochat setup says what it did about the app', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const run = (home, env) => spawnSync(process.execPath, [BIN, 'setup'], {
    env: { ...process.env, AUTOCHAT_HOME: path.join(tmp, home), ...env },
    encoding: 'utf8'
  })
  const without = run('cli-no-app', noApp)
  assert.equal(without.status, 0, without.stderr)
  assert.match(without.stdout, /launch {4}auto/)
  assert.match(without.stdout, /Get the menu bar app/)
  assert.match(without.stdout, /macos\/scripts\/build-app\.sh --install/)

  const withIt = run('cli-app', withApp)
  assert.equal(withIt.status, 0, withIt.stderr)
  assert.match(withIt.stdout, /launch {4}app \(.*AutoChat\.app\)/)
  assert.doesNotMatch(withIt.stdout, /Get the menu bar app/)
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'cli-app', 'config.json'), 'utf8'))
  assert.equal(cfg.launch, 'app')
})

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
const { APP_BUNDLE_ID } = await import('../src/launcher.js')

const apps = path.join(tmp, 'apps')
fs.mkdirSync(path.join(apps, 'AutoChat.app', 'Contents'), { recursive: true })
fs.writeFileSync(path.join(apps, 'AutoChat.app', 'Contents', 'Info.plist'), `<plist><string>${APP_BUNDLE_ID}</string></plist>`)
const withApp = { AUTOCHAT_APP_DIRS: apps }
const noApp = { AUTOCHAT_APP_DIRS: path.join(tmp, 'nowhere') }

test('autochat setup: the lounge while autochat runs, and how to get the app', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const run = (home, env) => spawnSync(process.execPath, [BIN, 'setup'], {
    env: { ...process.env, AUTOCHAT_HOME: path.join(tmp, home), ...env },
    encoding: 'utf8'
  })
  const without = run('cli-no-app', noApp)
  assert.equal(without.status, 0, without.stderr)
  assert.match(without.stdout, /While autochat runs \(autochat in a terminal\), you're in the lounge/)
  assert.match(without.stdout, /Get the menu bar app/)
  assert.match(without.stdout, /macos\/scripts\/build-app\.sh --install/)
  assert.doesNotMatch(without.stdout, /launch/)

  // A config from before always-on: its old keys change nothing, and setup leaves them be.
  const old = path.join(tmp, 'cli-app')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ launch: 'off', countdownSeconds: 5, focus: 'never', idleMs: 1000, tmuxSplit: 'h' }))
  const withIt = run('cli-app', withApp)
  assert.equal(withIt.status, 0, withIt.stderr)
  assert.match(withIt.stdout, /While autochat runs \(AutoChat\.app, in your menu bar\), you're in the lounge/)
  assert.match(withIt.stdout, /room {6}#lobby\n/)
  assert.doesNotMatch(withIt.stdout, /Get the menu bar app|paused|launch/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'config.json'), 'utf8')).launch, 'off')

  fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ lounge: 'off' }))
  assert.match(run('cli-app', withApp).stdout, /room {6}#lobby \(lounge off: autochat config lounge on\)/)
})

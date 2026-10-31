import fs from 'node:fs'
import path from 'node:path'
import { copilotHome, ensureDir } from './paths.js'
import { BIN, appInstalled, pickMethod } from './launcher.js'
import { loadConfig, saveConfig } from './config.js'

export const APP_INSTALL_URL = 'https://github.com/bnookala/autochat#macos-menu-bar-app'
export const APP_INSTALL_STEPS = [
  'git clone https://github.com/bnookala/autochat && cd autochat',
  'macos/scripts/build-app.sh --install    # → ~/Applications/AutoChat.app',
  'autochat setup                          # then switches to launch=app'
]

export const hooksFile = () => path.join(copilotHome(), 'hooks', 'autochat.json')
// Written by versions from before the lolchat → autochat rename; it runs the old CLI.
export const legacyHooksFile = () => path.join(copilotHome(), 'hooks', 'lolchat.json')

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"

function entry (event, extra = {}) {
  // `|| true` matters: preToolUse command hooks are fail-closed.
  return {
    type: 'command',
    bash: `${shq(process.execPath)} ${shq(BIN)} hook ${event} || true`,
    powershell: `& ${psq(process.execPath)} ${psq(BIN)} hook ${event}; exit 0`,
    timeoutSec: 10,
    ...extra
  }
}

export function buildHooksConfig () {
  return {
    version: 1,
    hooks: {
      userPromptSubmitted: [entry('userPromptSubmitted')],
      // preToolUse fires before every tool (so the room opens right away, even when the
      // first tool runs for minutes); postToolUse is only needed to catch task_complete.
      preToolUse: [entry('preToolUse')],
      postToolUse: [entry('postToolUse', { matcher: 'task_complete' })],
      notification: [entry('notification', { matcher: 'permission_prompt|elicitation_dialog' })],
      agentStop: [entry('agentStop')],
      sessionEnd: [entry('sessionEnd')]
    }
  }
}

export function installHooks () {
  const file = hooksFile()
  const next = JSON.stringify(buildHooksConfig(), null, 2) + '\n'
  ensureDir(path.dirname(file))
  // Keep the mtime when nothing changed: doctor compares it with Copilot process start times.
  let prev = null
  try { prev = fs.readFileSync(file, 'utf8') } catch {}
  if (prev !== next) fs.writeFileSync(file, next)
  return file
}

export function hooksInstalledAt () {
  try { return fs.statSync(hooksFile()).mtimeMs } catch { return null }
}

const unlink = (file) => { try { fs.unlinkSync(file); return true } catch { return false } }

export const removeLegacyHooks = () => unlink(legacyHooksFile())
export const legacyHooksInstalled = () => fs.existsSync(legacyHooksFile())

export function uninstallHooks () {
  const removed = unlink(hooksFile())
  return removeLegacyHooks() || removed
}

// On macOS with AutoChat.app installed, hooks should wake the app (launch=app), never a terminal.
// `off` is left alone: it's the app's own Pause switch. Returns what setup should report.
export function configureLaunch ({ platform = process.platform, env = process.env } = {}) {
  const before = loadConfig()
  const app = platform === 'darwin' ? appInstalled(env) : null
  const cfg = app && !['app', 'off'].includes(before.launch) ? saveConfig({ launch: 'app' }) : before
  return { app, launch: cfg.launch, previous: before.launch, method: pickMethod(cfg, env, platform) }
}

export function hooksInstalled () {
  try {
    const cfg = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))
    return JSON.stringify(cfg).includes(BIN.replace(/\\/g, '\\\\'))
  } catch { return false }
}

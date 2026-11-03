import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envVar } from './env.js'

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
export const APP_BUNDLE_ID = 'com.bnookala.autochat'

const asq = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0

// AUTOCHAT_APP_DIRS (path-delimited) replaces the default search dirs, for tests.
function appDirs (env) {
  const dirs = envVar('APP_DIRS', env)
  return dirs !== undefined
    ? dirs.split(path.delimiter).filter(Boolean)
    : ['/Applications', path.join(os.homedir(), 'Applications')]
}

// Path to AutoChat.app if installed. Its Info.plist holds the bundle id as plain ASCII,
// in both XML and binary plists.
export function appInstalled (env = process.env) {
  for (const dir of appDirs(env)) {
    const app = path.join(dir, 'AutoChat.app')
    try { if (fs.readFileSync(path.join(app, 'Contents', 'Info.plist')).includes(APP_BUNDLE_ID)) return app } catch {}
  }
  return null
}

function detached (cmd, args, env = process.env) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
  child.on('error', () => {})
  child.unref()
}

export function notify (title, message) {
  if (envVar('LAUNCH_RECORD') || envVar('NO_NOTIFY')) return
  if (process.platform === 'darwin') {
    detached('osascript', ['-e', `display notification ${asq(message)} with title ${asq(title)}`])
  } else if (process.platform === 'linux' && has('notify-send')) {
    detached('notify-send', [title, message])
  }
}

const APPS = { ghostty: 'Ghostty', 'iTerm.app': 'iTerm', Apple_Terminal: 'Terminal', vscode: 'Visual Studio Code', WezTerm: 'WezTerm' }

// "Pull back to reality": put focus back on the terminal running Copilot.
export function focusOrigin (origin) {
  if (!origin || envVar('LAUNCH_RECORD') || envVar('NO_FOCUS')) return
  if (origin.tmux && origin.tmuxPane) {
    const env = { ...process.env, TMUX: origin.tmux }
    spawnSync('tmux', ['select-window', '-t', origin.tmuxPane], { env, stdio: 'ignore' })
    spawnSync('tmux', ['select-pane', '-t', origin.tmuxPane], { env, stdio: 'ignore' })
    return
  }
  if (process.platform === 'darwin') {
    if (origin.bundleId && /^[A-Za-z0-9.-]+$/.test(origin.bundleId)) detached('open', ['-b', origin.bundleId])
    else if (APPS[origin.termProgram]) detached('open', ['-a', APPS[origin.termProgram]])
  }
}

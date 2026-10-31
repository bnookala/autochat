import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envVar } from './env.js'

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
export const APP_BUNDLE_ID = 'com.bnookala.autochat'
export const LAUNCH_METHODS = ['auto', 'app', 'tmux', 'ghostty', 'iterm', 'terminal', 'x-terminal-emulator', 'gnome-terminal', 'wt', 'notify', 'off']

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const asq = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function uiCommand (extra = [], envs = []) {
  // Terminals launched via `open`/AppleScript don't inherit our env, so pass it explicitly.
  const pass = { AUTOCHAT_HOME: envVar('HOME'), COPILOT_HOME: process.env.COPILOT_HOME, AUTOCHAT_BOOTSTRAP: envVar('BOOTSTRAP') }
  for (const [k, v] of Object.entries(pass)) {
    if (v) envs.push(`${k}=${v}`)
  }
  return ['/usr/bin/env', ...envs, process.execPath, BIN, 'ui', '--auto', ...extra]
}

// Wake the menu bar app in the background (no focus steal). It starts or attaches to
// `autochat daemon`, which drains the events the hook spooled meanwhile.
const appCommand = () => ['open', '-g', '-b', APP_BUNDLE_ID]

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

export function pickMethod (cfg, env, platform = process.platform) {
  if (cfg.launch && cfg.launch !== 'auto') return cfg.launch
  // With the menu bar app installed, hooks never open a terminal.
  if (platform === 'darwin' && appInstalled(env)) return 'app'
  if (env.TMUX && env.TMUX_PANE) return 'tmux'
  if (platform === 'darwin') {
    if (env.TERM_PROGRAM === 'ghostty' && fs.existsSync('/Applications/Ghostty.app')) return 'ghostty'
    if (env.TERM_PROGRAM === 'iTerm.app') return 'iterm'
    return 'terminal'
  }
  if (platform === 'linux' && env.DISPLAY) {
    if (has('x-terminal-emulator')) return 'x-terminal-emulator'
    if (has('gnome-terminal')) return 'gnome-terminal'
  }
  if (platform === 'win32') return 'wt'
  return 'notify'
}

function detached (cmd, args, env = process.env) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
  child.on('error', () => {})
  child.unref()
}

// Ghostty ≥ 1.3 is scriptable: ask the running Ghostty for exactly one new window.
// Starting a second Ghostty instance instead makes macOS restore every saved
// Ghostty window/tab into it. The window closes itself when autochat exits.
const GHOSTTY_NEW_WINDOW = [
  'on run argv',
  'tell application id "com.mitchellh.ghostty"',
  'new window with configuration {command:(item 1 of argv), wait after command:false}',
  'activate',
  'end tell',
  'end run'
]

function ghosttyNewWindow (cmd) {
  const r = spawnSync('osascript', [...GHOSTTY_NEW_WINDOW.flatMap(l => ['-e', l]), cmd.map(shq).join(' ')], { stdio: 'ignore', timeout: 5000 })
  return r.status === 0
}

// Fallback for Ghostty without AppleScript: a dedicated instance that the UI quits on exit
// (closeOwnTerminal). window-save-state=never stops it restoring all saved windows/tabs.
function ghosttyInstance () {
  detached('open', ['-na', 'Ghostty.app', '--args', '--title=autochat', '--window-width=100', '--window-height=30',
    '--window-save-state=never', '--quit-after-last-window-closed=true', '--confirm-close-surface=false',
    '-e', ...uiCommand([], ['AUTOCHAT_GHOSTTY=1'])])
}

export function launchUI ({ cfg, env, method = pickMethod(cfg, env) }) {
  const cmd = method === 'app' ? appCommand() : uiCommand()
  const record = envVar('LAUNCH_RECORD')
  if (record) {
    fs.appendFileSync(record, JSON.stringify({ method, cmd }) + '\n')
    return method
  }
  switch (method) {
    case 'app':
      detached(cmd[0], cmd.slice(1))
      break
    case 'tmux': {
      const args = ['split-window', cfg.tmuxSplit === 'h' ? '-h' : '-v', '-l', '40%', '-t', env.TMUX_PANE, cmd.map(shq).join(' ')]
      detached('tmux', args, { ...process.env, TMUX: env.TMUX })
      break
    }
    case 'ghostty':
      if (!ghosttyNewWindow(cmd)) ghosttyInstance()
      break
    case 'iterm':
      detached('osascript', ['-e', `tell application "iTerm" to create window with default profile command ${asq(cmd.map(shq).join(' '))}`])
      break
    case 'terminal':
      detached('osascript', ['-e', `tell application "Terminal"\n do script ${asq(cmd.map(shq).join(' ') + '; exit')}\n activate\nend tell`])
      break
    case 'x-terminal-emulator':
      detached('x-terminal-emulator', ['-e', ...cmd])
      break
    case 'gnome-terminal':
      detached('gnome-terminal', ['--', ...cmd])
      break
    case 'wt':
      detached('wt', ['new-tab', process.execPath, BIN, 'ui', '--auto'])
      break
    default:
      return 'off'
  }
  return method
}

export function notify (title, message) {
  if (envVar('LAUNCH_RECORD') || envVar('NO_NOTIFY')) return
  if (process.platform === 'darwin') {
    detached('osascript', ['-e', `display notification ${asq(message)} with title ${asq(title)}`])
  } else if (process.platform === 'linux' && has('notify-send')) {
    detached('notify-send', [title, message])
  }
}

// The fallback Ghostty instance stays alive after its command exits, so the UI quits the
// dedicated autochat instance it was launched in (never any other window).
export function closeOwnTerminal () {
  if (!envVar('GHOSTTY') || process.platform !== 'darwin') return
  let pid = process.ppid
  for (let i = 0; i < 6 && pid > 1; i++) {
    const r = spawnSync('ps', ['-ww', '-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' })
    const m = /^(\d+)\s+(.*)$/.exec((r.stdout || '').trim())
    if (!m) return
    if (/Ghostty\.app\/Contents\/MacOS\/ghostty/.test(m[2]) && m[2].includes('--title=autochat') && m[2].includes(BIN)) {
      detached('sh', ['-c', `sleep 0.4; kill ${pid}`])
      return
    }
    pid = Number(m[1])
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

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lolchat.js')

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const asq = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function uiCommand (extra = [], envs = []) {
  // Terminals launched via `open`/AppleScript don't inherit our env, so pass it explicitly.
  for (const k of ['LOLCHAT_HOME', 'COPILOT_HOME', 'LOLCHAT_BOOTSTRAP']) {
    if (process.env[k]) envs.push(`${k}=${process.env[k]}`)
  }
  return ['/usr/bin/env', ...envs, process.execPath, BIN, 'ui', '--auto', ...extra]
}

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0

export function pickMethod (cfg, env) {
  if (cfg.launch && cfg.launch !== 'auto') return cfg.launch
  if (env.TMUX && env.TMUX_PANE) return 'tmux'
  if (process.platform === 'darwin') {
    if (env.TERM_PROGRAM === 'ghostty' && fs.existsSync('/Applications/Ghostty.app')) return 'ghostty'
    if (env.TERM_PROGRAM === 'iTerm.app') return 'iterm'
    return 'terminal'
  }
  if (process.platform === 'linux' && env.DISPLAY) {
    if (has('x-terminal-emulator')) return 'x-terminal-emulator'
    if (has('gnome-terminal')) return 'gnome-terminal'
  }
  if (process.platform === 'win32') return 'wt'
  return 'notify'
}

function detached (cmd, args, env = process.env) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
  child.on('error', () => {})
  child.unref()
}

// Ghostty ≥ 1.3 is scriptable: ask the running Ghostty for exactly one new window.
// Starting a second Ghostty instance instead makes macOS restore every saved
// Ghostty window/tab into it. The window closes itself when lolchat exits.
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
  detached('open', ['-na', 'Ghostty.app', '--args', '--title=lolchat', '--window-width=100', '--window-height=30',
    '--window-save-state=never', '--quit-after-last-window-closed=true', '--confirm-close-surface=false',
    '-e', ...uiCommand([], ['LOLCHAT_GHOSTTY=1'])])
}

export function launchUI ({ cfg, env, method = pickMethod(cfg, env) }) {
  const cmd = uiCommand()
  if (process.env.LOLCHAT_LAUNCH_RECORD) {
    fs.appendFileSync(process.env.LOLCHAT_LAUNCH_RECORD, JSON.stringify({ method, cmd }) + '\n')
    return method
  }
  switch (method) {
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
  if (process.env.LOLCHAT_LAUNCH_RECORD || process.env.LOLCHAT_NO_NOTIFY) return
  if (process.platform === 'darwin') {
    detached('osascript', ['-e', `display notification ${asq(message)} with title ${asq(title)}`])
  } else if (process.platform === 'linux' && has('notify-send')) {
    detached('notify-send', [title, message])
  }
}

// The fallback Ghostty instance stays alive after its command exits, so the UI quits the
// dedicated lolchat instance it was launched in (never any other window).
export function closeOwnTerminal () {
  if (!process.env.LOLCHAT_GHOSTTY || process.platform !== 'darwin') return
  let pid = process.ppid
  for (let i = 0; i < 6 && pid > 1; i++) {
    const r = spawnSync('ps', ['-ww', '-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' })
    const m = /^(\d+)\s+(.*)$/.exec((r.stdout || '').trim())
    if (!m) return
    if (/Ghostty\.app\/Contents\/MacOS\/ghostty/.test(m[2]) && m[2].includes('--title=lolchat') && m[2].includes(BIN)) {
      detached('sh', ['-c', `sleep 0.4; kill ${pid}`])
      return
    }
    pid = Number(m[1])
  }
}

const APPS = { ghostty: 'Ghostty', 'iTerm.app': 'iTerm', Apple_Terminal: 'Terminal', vscode: 'Visual Studio Code', WezTerm: 'WezTerm' }

// "Pull back to reality": put focus back on the terminal running Copilot.
export function focusOrigin (origin) {
  if (!origin || process.env.LOLCHAT_LAUNCH_RECORD || process.env.LOLCHAT_NO_FOCUS) return
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

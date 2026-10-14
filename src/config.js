import fs from 'node:fs'
import path from 'node:path'
import { home, ensureDir } from './paths.js'
import { DEFAULT_ROOM, parseRoom } from './protocol.js'

export const DEFAULTS = {
  room: DEFAULT_ROOM,
  // auto | tmux | ghostty | iterm | terminal | notify | off
  launch: 'auto',
  tmuxSplit: 'v',
  idleMs: 45000,
  announce: true
}

export const configPath = () => path.join(home(), 'config.json')

export function loadConfig () {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch {}
  const merged = { ...DEFAULTS, ...cfg }
  try { parseRoom(merged.room) } catch { merged.room = DEFAULT_ROOM }
  return merged
}

export function saveConfig (patch) {
  const next = { ...loadConfig(), ...patch }
  ensureDir(home())
  const tmp = configPath() + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, configPath())
  return next
}

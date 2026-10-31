import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { envVar } from './env.js'

// Set when this process moved ~/.lolchat to ~/.autochat (see migrateLegacyHome).
export let migratedHome = null
let checkedHome = null

// Functions (not constants) so tests can point AUTOCHAT_HOME / COPILOT_HOME elsewhere.
export function home () {
  const custom = envVar('HOME')
  if (custom) return custom
  const dir = path.join(os.homedir(), '.autochat')
  if (checkedHome !== dir) {
    checkedHome = dir
    const legacy = path.join(os.homedir(), '.lolchat')
    if (migrateLegacyHome(legacy, dir)) migratedHome = { from: legacy, to: dir }
  }
  return dir
}

// One-time move of the pre-rename home dir, so the ed25519 identity (and with it the
// handle), config and room carry over. Never touches an existing ~/.autochat.
export function migrateLegacyHome (from, to) {
  try {
    if (fs.existsSync(to) || !fs.statSync(from).isDirectory()) return false
    fs.renameSync(from, to)
    return true
  } catch {
    return false
  }
}

export const copilotHome = () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
export const runDir = () => path.join(home(), 'run')
export const cacheDir = () => path.join(home(), 'cache')
export const sessionDir = (id) => path.join(copilotHome(), 'session-state', id)
export const sessionEventsPath = (id) => path.join(sessionDir(id), 'events.jsonl')

export function sockPath () {
  if (process.platform === 'win32') {
    const h = crypto.createHash('sha256').update(home()).digest('hex').slice(0, 12)
    return '\\\\.\\pipe\\autochat-' + h
  }
  return path.join(runDir(), 'ui.sock')
}

export function ensureDir (d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}

export function isValidSessionId (id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

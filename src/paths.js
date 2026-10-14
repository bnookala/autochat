import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

// Functions (not constants) so tests can point LOLCHAT_HOME / COPILOT_HOME elsewhere.
export const home = () => process.env.LOLCHAT_HOME || path.join(os.homedir(), '.lolchat')
export const copilotHome = () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
export const runDir = () => path.join(home(), 'run')
export const cacheDir = () => path.join(home(), 'cache')
export const sessionDir = (id) => path.join(copilotHome(), 'session-state', id)
export const sessionEventsPath = (id) => path.join(sessionDir(id), 'events.jsonl')

export function sockPath () {
  if (process.platform === 'win32') {
    const h = crypto.createHash('sha256').update(home()).digest('hex').slice(0, 12)
    return '\\\\.\\pipe\\lolchat-' + h
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

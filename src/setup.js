import fs from 'node:fs'
import path from 'node:path'
import { copilotHome, ensureDir } from './paths.js'
import { BIN } from './launcher.js'

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

export function hooksInstalled () {
  try {
    const cfg = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))
    return JSON.stringify(cfg).includes(BIN.replace(/\\/g, '\\\\'))
  } catch { return false }
}

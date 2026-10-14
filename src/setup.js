import fs from 'node:fs'
import path from 'node:path'
import { copilotHome, ensureDir } from './paths.js'
import { BIN } from './launcher.js'

export const hooksFile = () => path.join(copilotHome(), 'hooks', 'lolchat.json')

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
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(buildHooksConfig(), null, 2) + '\n')
  return file
}

export function uninstallHooks () {
  try { fs.unlinkSync(hooksFile()); return true } catch { return false }
}

export function hooksInstalled () {
  try {
    const cfg = JSON.parse(fs.readFileSync(hooksFile(), 'utf8'))
    return JSON.stringify(cfg).includes(BIN.replace(/\\/g, '\\\\'))
  } catch { return false }
}

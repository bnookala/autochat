// autochat's opencode plugin: tells autochat what your opencode sessions do, so it can put you in
// the lounge while one works on its own (https://github.com/bnookala/autochat). Written by
// `autochat setup --harness opencode`, removed by `autochat uninstall`; edits here get replaced.
//
// It forwards a session's start, prompts, tool calls, permission requests and questions (and
// their answers), idle, and the end of the opencode process to `autochat hook --harness opencode
// <event>`, which decides what they mean. Each says which process it's from: opencode dies
// without a word on Ctrl+C. Subagents' sessions only pass on their requests, as
// their parent's. It never throws, never waits for autochat, and does nothing when autochat
// isn't there.
import { spawn } from 'node:child_process'

// The node and autochat.js the hook runs: `autochat setup` fills these in.
const NODE = 'node'
const BIN = 'autochat.js'

const brief = (s, n) => typeof s === 'string' ? s.slice(0, n) : undefined
const strings = (o, n) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, n)]))

export const AutochatPlugin = async ({ directory } = {}) => {
  // How this opencode runs (`run …`, the TUI's worker, `serve`, …).
  const argv = process.argv.slice(1, 21).map(a => String(a).slice(0, 200))
  // Each event goes out in a process of its own, so they can arrive out of order: `at` says when
  // it happened (strictly increasing), and the core drops stale ones.
  let clock = 0
  const sessions = new Map()
  const entry = (id) => {
    if (!sessions.has(id)) sessions.set(id, {})
    return sessions.get(id)
  }
  const root = (id) => {
    for (let i = 0; i < 16 && sessions.get(id)?.parent; i++) id = sessions.get(id).parent
    return id
  }
  const send = (event, sessionID, extra = {}) => {
    try {
      if (typeof sessionID !== 'string') return
      const s = entry(sessionID)
      s.active = true
      clock = Math.max(Date.now(), clock + 1)
      const payload = { event, sessionID, at: clock, pid: process.pid, session: s.info, agent: s.agent, argv, directory, ...extra }
      const child = spawn(NODE, [BIN, 'hook', '--harness', 'opencode', event], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true })
      child.on('error', () => {})
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(payload))
      child.unref()
    } catch {}
  }
  const learn = (info) => {
    if (!info || typeof info.id !== 'string') return
    const s = entry(info.id)
    s.parent = info.parentID
    s.info = { id: info.id, parentID: info.parentID, directory: brief(info.directory, 1000), permission: Array.isArray(info.permission) ? info.permission.slice(0, 50) : undefined }
  }
  const isRoot = (id) => typeof id === 'string' && !sessions.get(id)?.parent

  return {
    event: async ({ event } = {}) => {
      try {
        const p = event?.properties || {}
        switch (event?.type) {
          case 'session.created':
            learn(p.info)
            if (isRoot(p.info?.id)) send('session.created', p.info.id)
            break
          case 'session.updated':
            learn(p.info)
            break
          case 'message.updated':
            if (p.info?.role === 'assistant' && typeof p.info.agent === 'string') entry(p.info.sessionID).agent = p.info.agent
            break
          case 'message.part.updated':
            // The last thing it said, for when it goes idle.
            if (p.part?.type === 'text' && p.part.time?.end && !p.part.synthetic) entry(p.part.sessionID).text = brief(p.part.text, 4000)
            break
          case 'permission.asked':
            send(event.type, root(p.sessionID), { properties: { id: p.id, permission: p.permission, patterns: Array.isArray(p.patterns) ? p.patterns.slice(0, 20) : undefined } })
            break
          case 'question.asked':
            send(event.type, root(p.sessionID), { properties: { id: p.id, questions: Array.isArray(p.questions) ? p.questions.slice(0, 10) : undefined } })
            break
          case 'permission.replied':
          case 'question.replied':
          case 'question.rejected':
            send(event.type, root(p.sessionID), { properties: { requestID: p.requestID, reply: p.reply } })
            break
          case 'session.idle':
            if (isRoot(p.sessionID)) send(event.type, p.sessionID, { summary: sessions.get(p.sessionID)?.text })
            break
          case 'server.instance.disposed':
            // opencode is done with this directory: `opencode run` finished, or the TUI quit.
            for (const [id, s] of sessions) if (s.active && !s.parent) send(event.type, id, { summary: s.text })
            break
        }
      } catch {}
    },
    'chat.message': async (input, output) => {
      try {
        const id = input?.sessionID
        if (typeof id !== 'string') return
        const agent = output?.message?.agent || input.agent
        if (typeof agent === 'string') entry(id).agent = agent
        if (isRoot(id)) send('chat.message', id)
      } catch {}
    },
    'tool.execute.before': async (input, output) => {
      try {
        if (isRoot(input?.sessionID)) send('tool.execute.before', input.sessionID, { properties: { tool: input.tool, args: strings(output?.args, 300) } })
      } catch {}
    }
  }
}

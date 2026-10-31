#!/usr/bin/env node
// Mock `lolchat daemon` for developing and testing LolChat.app without P2P or Copilot.
// Speaks the v1 subscribe/state/cmd protocol from issue #2 over the same unix socket
// path as src/paths.js sockPath() (respects LOLCHAT_HOME). No dependencies.
//
//   node macos/dev/mock-daemon.mjs [daemon] [--scenario full|lounge|room|request|countdown]
//        [--countdown 30] [--speed 1] [--loop] [--sock PATH] [--quiet]
//
// The leading `daemon` argument is accepted and ignored, so the app can spawn this file
// in place of the real CLI: LOLCHAT_BIN=macos/dev/mock-daemon.mjs. Options can also come
// from LOLCHAT_MOCK_SCENARIO / LOLCHAT_MOCK_COUNTDOWN / LOLCHAT_MOCK_SPEED for that case.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2).filter(a => a !== 'daemon'),
  options: {
    scenario: { type: 'string', default: process.env.LOLCHAT_MOCK_SCENARIO || 'full' },
    countdown: { type: 'string', default: process.env.LOLCHAT_MOCK_COUNTDOWN || '30' },
    speed: { type: 'string', default: process.env.LOLCHAT_MOCK_SPEED || '1' },
    loop: { type: 'boolean', default: false },
    sock: { type: 'string' },
    quiet: { type: 'boolean', default: false }
  }
})

const MAX_LINE = 256 * 1024
const MAX_SUBSCRIBERS = 8
const BANNER_MS = 6000
const speed = Math.max(0.05, Number(values.speed) || 1)
const countdownSecs = Math.max(1, Number(values.countdown) || 30)
const home = process.env.LOLCHAT_HOME || path.join(os.homedir(), '.lolchat')
const sock = path.resolve(values.sock || path.join(home, 'run', 'ui.sock'))

const log = (...a) => { if (!values.quiet) process.stderr.write(`[mock ${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}\n`) }

// --- world ------------------------------------------------------------------------

// Colors are #rrggbb, converted from the TUI's xterm-256 palette like the core does.
const xterm = (i) => {
  const lv = [0, 95, 135, 175, 215, 255]
  const n = i - 16
  return '#' + [lv[Math.floor(n / 36)], lv[Math.floor(n / 6) % 6], lv[n % 6]].map(v => v.toString(16).padStart(2, '0')).join('')
}
const ME = { handle: 'stormy-newt-59', color: xterm(39) }
const PEERS = {
  jade: { handle: 'jade-lynx-0c', color: xterm(213) },
  brisk: { handle: 'brisk-otter-7a', color: xterm(114) },
  heron: { handle: 'quiet-heron-d1', color: xterm(179) }
}
const CWD = '~/code/api-server'
const SUMMARY = 'Refactored the API client onto the new retry helper and updated 14 tests. All tests pass.'
const REQUEST = { sid: 'mock-session-1', cwd: CWD, title: 'Copilot needs you', message: 'Run the database migrations against staging before continuing? (yes / no / skip)', resolved: false }

const s = {
  phase: 'lounge',
  room: null,
  members: [],
  messages: [],
  request: null,
  sessions: [],
  countdown: null,
  banner: null
}

let nextMessageId = 1
let timers = []
let countdownTimer = null
let tickTimer = null
let bannerTimer = null

const at = (sec, fn) => { timers.push(setTimeout(fn, (sec * 1000) / speed)) }
const clearScenario = () => { for (const t of timers) clearTimeout(t); timers = [] }

function snapshot () {
  const now = Date.now()
  return {
    type: 'state',
    v: 1,
    now,
    phase: s.phase,
    room: s.room || { display: '#lobby', isHost: false, activeCount: 0, hostHandle: null, peers: 0 },
    me: ME,
    members: s.members,
    messages: s.messages,
    request: s.request,
    sessions: s.sessions,
    countdown: s.countdown && { ...s.countdown, remaining: Math.max(0, Math.ceil((s.countdown.endsAt - now) / 1000)) },
    banner: s.banner,
    mock: true
  }
}

function push (m) {
  s.messages.push({ id: nextMessageId++, ts: Date.now(), from: null, color: null, you: false, ...m })
  if (s.messages.length > 400) s.messages.splice(0, s.messages.length - 400)
  changed()
}
const sys = (text, color) => push({ kind: 'sys', text, color })
const chat = (p, text) => push({ kind: 'chat', from: p.handle, text, color: p.color })

function member (p, extra = {}) {
  return { handle: p.handle, color: p.color, status: 'active', isHost: false, you: false, needed: false, ...extra }
}

// Like the core: you first, `needed` flags a pending Copilot question, `away` = spectating.
function setMembers () {
  s.members = [
    member(ME, { you: true, needed: !!(s.request && !s.request.resolved) }),
    member(PEERS.jade, { isHost: true }),
    member(PEERS.brisk),
    member(PEERS.heron, { status: 'away' })
  ]
  if (s.room) {
    s.room.activeCount = s.members.filter(m => m.status !== 'away').length
    s.room.peers = s.members.length - 1
  }
}

function enterRoom (manual = false) {
  clearTimeout(bannerTimer)
  s.phase = 'room'
  s.banner = null
  s.messages = []
  s.room = { display: '#lobby', isHost: false, activeCount: 1, hostHandle: PEERS.jade.handle, peers: 0 }
  s.sessions = [{ sid: manual ? 'manual' : 'mock-session-1', state: 'running', cwd: CWD }]
  s.members = [member(ME, { you: true })]
  sys('entering #lobby, looking for other autopiloters…')
}

function joinPeers () {
  if (s.phase !== 'room') return
  setMembers()
  sys(`joined a live room hosted by ${PEERS.jade.handle}`)
}

function startCountdown (reason = 'complete') {
  s.sessions = []
  s.countdown = { endsAt: Date.now() + countdownSecs * 1000, total: countdownSecs, reason, summary: SUMMARY, cwd: CWD }
  sys(`your copilot finished. back to reality in ${countdownSecs}s (keep chatting)`)
  clearTimeout(countdownTimer)
  countdownTimer = setTimeout(expire, countdownSecs * 1000)
  clearInterval(tickTimer)
  // The core re-emits once per second during a countdown so simple clients can re-render.
  tickTimer = setInterval(changed, 1000)
}

function expire () {
  clearTimeout(countdownTimer)
  clearInterval(tickTimer)
  const c = s.countdown
  s.countdown = null
  s.phase = 'reality'
  s.banner = { kind: 'reality', reason: c?.reason || 'complete', summary: c?.summary || SUMMARY, cwd: c?.cwd || CWD }
  s.room = null
  s.members = []
  s.request = null
  log('back to reality')
  afterBanner()
}

function afterBanner () {
  clearTimeout(bannerTimer)
  bannerTimer = setTimeout(() => {
    s.phase = 'lounge'
    s.banner = null
    changed()
    if (values.loop) { log('looping scenario'); runScenario('full', 4) }
  }, BANNER_MS)
  changed()
}

function runScenario (name, delay = 0) {
  clearScenario()
  const t = (sec, fn) => at(delay + sec, fn)
  if (name === 'lounge') return
  if (name === 'room' || name === 'request' || name === 'countdown') {
    enterRoom()
    joinPeers()
    chat(PEERS.jade, "anyone else's copilot rewriting their whole test suite rn")
    chat(PEERS.brisk, 'mine is 40 tool calls deep into a yaml file')
    push({ kind: 'chat', from: ME.handle, text: 'lol same. it keeps renaming things back and forth', color: ME.color, you: true })
    if (name === 'request') {
      s.request = { ...REQUEST }
      setMembers()
    }
    if (name === 'countdown') startCountdown()
    changed()
    return
  }
  // full: lounge → room → request → countdown → reality banner → lounge
  t(3, () => { log('autopilot started'); enterRoom() })
  t(4.5, joinPeers)
  t(6, () => chat(PEERS.jade, "anyone else's copilot rewriting their whole test suite rn"))
  t(9, () => chat(PEERS.brisk, 'mine is 40 tool calls deep into a yaml file'))
  t(12, () => {
    if (s.phase !== 'room') return
    log('copilot request')
    s.request = { ...REQUEST }
    s.sessions = [{ sid: 'mock-session-1', state: 'needed', cwd: CWD }]
    setMembers()
    changed()
  })
  t(14, () => chat(PEERS.jade, 'lol mine asked about migrations too'))
  t(18, () => {
    if (!s.request) return
    s.request = { ...s.request, resolved: true }
    s.sessions = [{ sid: 'mock-session-1', state: 'running', cwd: CWD }]
    setMembers()
    changed()
  })
  t(24, () => { if (s.request) { s.request = null; changed() } })
  t(26, () => chat(PEERS.brisk, 'say ping and I pong. scientifically proven'))
  t(28, () => { if (s.phase === 'room') { log('copilot finished: countdown'); startCountdown() } })
  t(28 + countdownSecs * 0.3, () => { if (s.countdown) chat(PEERS.brisk, 'gl out there') })
  t(28 + countdownSecs * 0.6, () => { if (s.countdown) chat(PEERS.jade, 'see you on the other side') })
}

// --- commands -----------------------------------------------------------------------

function command (msg) {
  switch (msg.cmd) {
    case 'say': {
      const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 500) : ''
      if (s.phase !== 'room') return { ok: false, error: 'not in a room' }
      if (!text) return { ok: false, error: 'empty message' }
      push({ kind: 'chat', from: ME.handle, text, color: ME.color, you: true })
      if (/\bping\b/i.test(text)) setTimeout(() => { if (s.phase === 'room') chat(PEERS.brisk, 'pong') }, 600)
      return { ok: true }
    }
    case 'returnNow':
      if (!s.countdown) return { ok: false, error: 'no countdown running' }
      expire()
      return { ok: true }
    case 'leaveRoom':
      if (s.phase !== 'room' && s.phase !== 'spectating') return { ok: false, error: 'not in a room' }
      clearScenario()
      clearTimeout(countdownTimer)
      clearInterval(tickTimer)
      s.countdown = null
      s.request = null
      s.room = null
      s.members = []
      s.phase = 'left'
      s.banner = { kind: 'left' }
      afterBanner()
      return { ok: true }
    case 'jumpToCopilot':
      log('jumpToCopilot (would focus the Copilot terminal)')
      return { ok: true }
    case 'dismissRequest':
      s.request = null
      if (s.phase === 'room') setMembers()
      changed()
      return { ok: true }
    case 'joinNow':
      if (s.phase === 'room') return { ok: true }
      clearScenario()
      enterRoom(true)
      at(1, joinPeers)
      changed()
      return { ok: true }
    default:
      return { ok: false, error: 'unknown command: ' + String(msg.cmd) }
  }
}

function oneShot (msg) {
  if (msg?.type === 'ping') return { ok: true, pong: true, phase: s.phase, daemon: true, pid: process.pid }
  if (msg?.type === 'status') return { ok: true, phase: s.phase, room: s.room?.display || '#lobby', sessions: s.sessions }
  if (msg?.type === 'hook') return { ok: true, tracked: false }
  return { ok: false }
}

// --- socket ---------------------------------------------------------------------------

const subscribers = new Set()
let flushTimer = null
let lastFlush = 0

function changed () {
  if (flushTimer) return
  // Coalesce to at most 20 snapshots per second.
  const wait = Math.max(0, 50 - (Date.now() - lastFlush))
  flushTimer = setTimeout(() => {
    flushTimer = null
    lastFlush = Date.now()
    const line = JSON.stringify(snapshot()) + '\n'
    for (const c of subscribers) write(c, line)
  }, wait)
}

function write (c, line) {
  if (c.writableLength > 4 * 1024 * 1024) { subscribers.delete(c); c.destroy(); return }
  c.write(line)
}

const server = net.createServer((c) => {
  let buf = ''
  let subscribed = false
  c.setEncoding('utf8')
  c.on('error', () => {})
  c.on('close', () => subscribers.delete(c))
  c.on('data', (d) => {
    buf += d
    if (buf.length > MAX_LINE) { c.destroy(); return }
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg = null
      try { msg = JSON.parse(line) } catch {}
      if (!subscribed) {
        if (msg?.type === 'subscribe') {
          if (subscribers.size >= MAX_SUBSCRIBERS) { c.end(JSON.stringify({ type: 'error', v: 1, error: 'too many subscribers' }) + '\n'); return }
          subscribed = true
          subscribers.add(c)
          log(`subscriber connected (${msg.client || '?'}), ${subscribers.size} total`)
          write(c, JSON.stringify(snapshot()) + '\n')
          continue
        }
        c.end(JSON.stringify(oneShot(msg)) + '\n')
        return
      }
      if (msg?.type !== 'cmd') { write(c, JSON.stringify({ type: 'reply', id: msg?.id ?? null, ok: false, error: msg ? 'unknown message type' : 'invalid json' }) + '\n'); continue }
      let reply
      try { reply = command(msg) } catch (err) { reply = { ok: false, error: err.message } }
      write(c, JSON.stringify({ type: 'reply', id: msg.id, ...reply }) + '\n')
    }
  })
})

// macOS caps unix socket paths at 103 bytes; bind long paths relative to their directory.
function listenPath () {
  if (Buffer.byteLength(sock) <= 100) return sock
  process.chdir(path.dirname(sock))
  return './' + path.basename(sock)
}

function listen (retried) {
  server.once('error', (err) => {
    if (err.code !== 'EADDRINUSE' || retried) { log('listen failed:', err.message); process.exit(1) }
    const probe = net.connect(listenPath())
    probe.on('connect', () => { log('another daemon is already running on', sock); process.exit(1) })
    probe.on('error', () => { try { fs.unlinkSync(sock) } catch {}; listen(true) })
  })
  server.listen(listenPath(), () => {
    try { fs.chmodSync(sock, 0o600) } catch {}
    log(`listening on ${sock} (scenario ${values.scenario}, countdown ${countdownSecs}s, speed ${speed}x)`)
    runScenario(values.scenario)
  })
}

fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 })
listen(false)

let stopping = false
async function shutdown (sig) {
  if (stopping) return
  stopping = true
  log(`${sig}: leaving the room cleanly`)
  clearScenario()
  clearTimeout(countdownTimer)
  clearInterval(tickTimer)
  clearTimeout(bannerTimer)
  await new Promise(resolve => setTimeout(resolve, 200))
  for (const c of subscribers) c.destroy()
  server.close()
  try { fs.unlinkSync(sock) } catch {}
  log('bye')
  process.exit(0)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig))

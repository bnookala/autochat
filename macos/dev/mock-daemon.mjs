#!/usr/bin/env node
// Mock `autochat daemon` for developing and testing AutoChat.app without P2P or Copilot.
// Speaks the v1 subscribe/state/cmd protocol from issue #2, and the local agent room's
// human stream from issue #21 (`subscribe` with `"stream":"agents"`, `agents` snapshots,
// `agents.ack` / `agents.say`), over the same unix socket path as src/paths.js sockPath()
// (respects AUTOCHAT_HOME). No dependencies.
//
//   node macos/dev/mock-daemon.mjs [daemon] [--scenario full|lounge|room|request|countdown|agents|agents-p1|attention]
//        [--countdown 30] [--speed 1] [--loop] [--ack] [--sock PATH] [--quiet]
//
// The leading `daemon` argument is accepted and ignored, so the app can spawn this file
// in place of the real CLI: AUTOCHAT_BIN=macos/dev/mock-daemon.mjs. Options can also come
// from AUTOCHAT_MOCK_SCENARIO / AUTOCHAT_MOCK_COUNTDOWN / AUTOCHAT_MOCK_SPEED /
// AUTOCHAT_MOCK_ACK=1 for that case.
//
// `--scenario agents` stays in the lounge and plays an agent room: three agents over two
// harnesses (one leaves), an overlap, a thread that's opened, discussed and resolved with a
// decision, main-stream notes and sys lines, and a second thread that stays open. `--ack`
// starts with the intervention warning already acknowledged. Its cards are P0's: `present`
// only, like a daemon from before P1.
//
// `--scenario agents-p1` plays the P1 agent room (issue #50) with a cast of its own. Presence
// (#54): cards carry `presence` (here, away, left) and `leftAt`; one agent leaves cleanly
// (`bye`: left at once), one drops and comes back within the 10 s resume window, and one drops
// for good (left once the window ends). Names (#66): cards carry `title` (a session title,
// `repo@branch`, or the folder) and `display` is the title with no human/ prefix; a coordinator
// has two child sessions (`parent`); messages carry `from.title`.
//
// `--scenario attention` (issue #37) runs four agents over three harnesses at once: one finishes,
// two get blocked on you (one with Copilot's question), one fails. Jump to a blocked one and it
// carries on a moment later, then finishes; when the last one stops, the countdown lists the
// queue, and nothing takes focus. Every snapshot carries `attention` like the real daemon's.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  args: process.argv.slice(2).filter(a => a !== 'daemon'),
  options: {
    scenario: { type: 'string', default: process.env.AUTOCHAT_MOCK_SCENARIO || 'full' },
    countdown: { type: 'string', default: process.env.AUTOCHAT_MOCK_COUNTDOWN || '30' },
    speed: { type: 'string', default: process.env.AUTOCHAT_MOCK_SPEED || '1' },
    loop: { type: 'boolean', default: false },
    ack: { type: 'boolean', default: process.env.AUTOCHAT_MOCK_ACK === '1' },
    sock: { type: 'string' },
    quiet: { type: 'boolean', default: false }
  }
})

const MAX_LINE = 256 * 1024
const MAX_SUBSCRIBERS = 8
const BANNER_MS = 6000
const AGENT_HISTORY = 300
const AGENT_LEFT_MS = 10000
const MAX_SAY = 2000
const speed = Math.max(0.05, Number(values.speed) || 1)
const countdownSecs = Math.max(1, Number(values.countdown) || 30)
// LOLCHAT_HOME is the pre-rename fallback, as in src/env.js.
const home = (process.env.AUTOCHAT_HOME ?? process.env.LOLCHAT_HOME) || path.join(os.homedir(), '.autochat')
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

// The agents the attention queue is about. `main` is the Copilot session every scenario uses.
const AGENTS = {
  main: { harness: 'copilot', sid: 'mock-session-1', cwd: CWD, name: 'Copilot CLI' },
  web: { harness: 'claude', sid: 'e5f6a7b8', cwd: '~/code/web', name: 'Claude Code' },
  sdk: { harness: 'codex', sid: '9a8b7c6d', cwd: '~/code/sdk', name: 'Codex' },
  docs: { harness: 'claude', sid: '0c1d2e3f', cwd: '~/code/docs-site', name: 'Claude Code' }
}
const HOTFIX = 'Which branch should the hotfix go on? [main / release-2.3]'

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
    agents: agentsSummary(),
    attention: attentionList(),
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

function startCountdown (reason = 'complete', { summary = SUMMARY, cwd = CWD } = {}) {
  s.sessions = []
  // Like the core: the run that just ended is in the queue (and, with one agent, handled at zero).
  if (!several) attend('main', 'finished', 'Copilot CLI finished', summary)
  s.countdown = { endsAt: Date.now() + countdownSecs * 1000, total: countdownSecs, reason, summary, cwd }
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
  // One agent: focus goes back to it, which handles its item. Several: the queue takes over.
  if (several) log('back to reality: several agents, so nothing takes focus')
  else unattend('main')
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
  if (name === 'agents') return runAgents(t)
  if (name === 'agents-p1') return runAgentsP1(t)
  if (name === 'attention') return runAttention(t)
  if (name === 'room' || name === 'request' || name === 'countdown') {
    enterRoom()
    joinPeers()
    chat(PEERS.jade, "anyone else's copilot rewriting their whole test suite rn")
    chat(PEERS.brisk, 'mine is 40 tool calls deep into a yaml file')
    push({ kind: 'chat', from: ME.handle, text: 'lol same. it keeps renaming things back and forth', color: ME.color, you: true })
    if (name === 'request') {
      s.request = { ...REQUEST }
      attend('main', 'blocked', REQUEST.title, REQUEST.message)
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
    attend('main', 'blocked', REQUEST.title, REQUEST.message)
    s.sessions = [{ sid: 'mock-session-1', state: 'needed', cwd: CWD }]
    setMembers()
    changed()
  })
  t(14, () => chat(PEERS.jade, 'lol mine asked about migrations too'))
  t(18, () => {
    if (!s.request) return
    s.request = { ...s.request, resolved: true }
    unattend('main')
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

// --- attention queue (issue #37) ---------------------------------------------------------

// One item per agent, its latest; urgent first. Same shape and rules as the core's.
const queue = new Map()
const working = new Set()
const RANK = { blocked: 0, failed: 1, finished: 2 }
let attentionSeq = 0
let several = false

function attend (key, kind, title, summary = null) {
  const a = AGENTS[key]
  const prev = queue.get(key)
  const same = prev?.kind === kind
  queue.set(key, { id: same ? prev.id : String(++attentionSeq), harness: a.harness, sid: a.sid, cwd: a.cwd, kind, title, summary, at: same ? prev.at : Date.now() })
  changed()
}

function unattend (key) {
  if (queue.delete(key)) changed()
}

const attentionList = () => [...queue.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.at - b.at)
const itemKey = (id) => [...queue.entries()].find(([, a]) => a.id === String(id))?.[0]

function agentSessions () {
  s.sessions = [...working].map(k => ({ sid: AGENTS[k].sid, state: queue.get(k)?.kind === 'blocked' ? 'needed' : 'running', cwd: AGENTS[k].cwd, harness: AGENTS[k].harness }))
}

function agentBlocked (key, title, message) {
  if (!working.has(key)) return
  log(`${key} is blocked: ${title}`)
  attend(key, 'blocked', title, message)
  if (key === 'main') { s.request = { sid: AGENTS.main.sid, cwd: AGENTS.main.cwd, title, message, resolved: false }; setMembers() }
  agentSessions()
  changed()
}

// You answered it (Jump to): it carries on, then finishes a little later.
function agentCarriesOn (key) {
  if (queue.get(key)?.kind !== 'blocked') return
  log(`${key} carries on`)
  unattend(key)
  if (key === 'main' && s.request) { s.request = null; setMembers() }
  agentSessions()
  changed()
  at(4, () => agentEnds(key, 'finished', `${AGENTS[key].name} finished`, key === 'main' ? SUMMARY : 'Ran the migration on staging; all 212 web tests pass.'))
}

function agentEnds (key, kind, title, summary) {
  if (!working.delete(key)) return
  log(`${key} ${kind}`)
  attend(key, kind, title, summary)
  agentSessions()
  // The countdown only runs when the last agent stops.
  if (!working.size && s.phase === 'room') startCountdown(kind === 'failed' ? 'failed' : 'complete', { summary, cwd: AGENTS[key].cwd })
  changed()
}

function runAttention (t) {
  several = true
  enterRoom()
  joinPeers()
  chat(PEERS.jade, "anyone else's copilot rewriting their whole test suite rn")
  chat(PEERS.brisk, 'mine is 40 tool calls deep into a yaml file')
  push({ kind: 'chat', from: ME.handle, text: 'four agents going at once. what could go wrong', color: ME.color, you: true })
  for (const k of Object.keys(AGENTS)) working.add(k)
  agentSessions()
  changed()
  t(2, () => agentEnds('sdk', 'finished', 'Codex finished', 'Bumped the SDK to 4.2 and fixed the three type errors it caused.'))
  t(4, () => agentBlocked('web', 'Permission needed', 'Bash: npm run migrate -- --env staging'))
  t(7, () => agentBlocked('main', 'Copilot has a question for you', HOTFIX))
  t(10, () => agentEnds('docs', 'failed', 'Claude Code stopped on an error', 'API Error: Rate limit reached'))
  t(12, () => chat(PEERS.jade, 'lol mine asked about migrations too'))
}

// --- agent room (issue #21) ------------------------------------------------------------

const REPO = 'bnookala/api-server'
const room = {
  seen: false, // an agent has connected since start → the lounge snapshot's `agents` is non-null
  p1: false, // agents-p1: cards carry the P1 fields
  ack: values.ack,
  cards: new Map(), // name → card
  threads: new Map(), // id → thread
  messages: [],
  seq: 0,
  overlapPairs: new Set()
}
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')

function agentsSummary () {
  if (!room.seen) return null
  return {
    present: [...room.cards.values()].filter(c => c.present).length,
    openThreads: [...room.threads.values()].filter(t => t.status === 'open').length
  }
}

function agentsSnapshot () {
  return {
    type: 'agents',
    v: 1,
    now: Date.now(),
    tier: 'local',
    human: ME.handle,
    ack: room.ack,
    agents: [...room.cards.values()],
    threads: [...room.threads.values()],
    messages: room.messages.slice(-AGENT_HISTORY),
    mock: true
  }
}

const sender = (name) => {
  const c = room.cards.get(name)
  if (room.p1) return { name, display: c?.title ?? name, title: c?.title ?? null, human: ME.handle, harness: c?.harness ?? 'agent', repo: c?.repo ?? null, id: c?.id ?? null }
  return { name, display: `${ME.handle}/${name}`, human: ME.handle, harness: c?.harness ?? 'agent', repo: c?.repo ?? null }
}

function postAgentMessage (m) {
  const msg = { seq: ++room.seq, id: hex(8), ts: Date.now(), kind: 'note', from: null, thread: null, to: [], replyTo: null, text: '', intervention: false, ...m }
  room.messages.push(msg)
  if (room.messages.length > 1000) room.messages.splice(0, room.messages.length - 1000)
  const t = msg.thread && room.threads.get(msg.thread)
  if (t) { t.messages += 1; t.lastAt = msg.ts }
  agentsChanged()
  return msg
}

function agentJoin (name, harness, branch, extra = {}) {
  room.seen = true
  const now = Date.now()
  // P1's local tier (#66): `display` is the title, with no human/ prefix; `parent` names a coordinator.
  const p1 = room.p1 ? { presence: 'here', leftAt: null, title: extra.title ?? name, display: extra.title ?? name, parent: null } : {}
  room.cards.set(name, {
    id: hex(8), name, display: `${ME.handle}/${name}`, human: ME.handle, harness, repo: REPO, branch, worktree: name.split('-')[1] || name,
    state: 'exploring', summary: null, focus: { issue: null, components: [], paths: [] },
    present: true, ...p1, joinedAt: now, updatedAt: now, overlaps: [], ...extra
  })
  postAgentMessage({ kind: 'sys', text: `${name} joined` })
  recomputeOverlaps()
  changed()
  agentsChanged()
}

function agentStatus (name, { state, summary, focus }) {
  const c = room.cards.get(name)
  if (!c) return
  if (state) c.state = state
  if (summary !== undefined) c.summary = summary
  if (focus) c.focus = { issue: null, components: [], paths: [], ...focus }
  c.updatedAt = Date.now()
  recomputeOverlaps()
  agentsChanged()
}

// Same rules as #21: same repo, plus the same issue, a shared component, or a shared path
// (equal, or a directory prefix on segment boundaries). New pairs get one overlap notice.
function sharedPath (a, b) {
  for (const p of a) {
    for (const q of b) {
      const [x, y] = p.length <= q.length ? [p, q] : [q, p]
      if (x === y || y.startsWith(x.endsWith('/') ? x : x + '/')) return y
    }
  }
  return null
}

function overlapOn (a, b) {
  if (!a.repo || a.repo !== b.repo) return null
  const path = sharedPath(a.focus.paths, b.focus.paths)
  if (path) return path
  const comp = a.focus.components.find(x => b.focus.components.some(y => x.toLowerCase() === y.toLowerCase()))
  if (comp) return `the ${comp} component`
  if (a.focus.issue && a.focus.issue === b.focus.issue) return `#${a.focus.issue}`
  return null
}

function recomputeOverlaps () {
  // An agent that's reconnecting is still in the room; one that left overlaps with no one.
  const cards = [...room.cards.values()].filter(c => c.present || c.presence === 'away')
  for (const c of room.cards.values()) c.overlaps = []
  const now = new Set()
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const [a, b] = [cards[i], cards[j]]
      const on = overlapOn(a, b)
      if (!on) continue
      a.overlaps.push(b.name)
      b.overlaps.push(a.name)
      const key = [a.name, b.name].sort().join('|')
      now.add(key)
      if (!room.overlapPairs.has(key)) postAgentMessage({ kind: 'overlap', to: [a.name, b.name], text: `${a.name} and ${b.name} both touch ${on}` })
    }
  }
  room.overlapPairs = now
}

function agentPost (name, { kind = 'note', text, thread = null, to = [], replyTo = null }) {
  const c = room.cards.get(name)
  if (!c?.present) return null
  return postAgentMessage({ kind, from: sender(name), thread, to, replyTo, text })
}

function threadOpen (opener, title, withNames) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + hex(2)
  const now = Date.now()
  room.threads.set(id, { id, title, opener, participants: [opener, ...withNames], status: 'open', outcome: null, messages: 0, openedAt: now, lastAt: now })
  postAgentMessage({ kind: 'sys', text: `🧵 ${opener} opened “${title}” with ${withNames.join(', ')}` })
  changed()
  return id
}

function threadResolve (name, id, outcome) {
  const t = room.threads.get(id)
  if (!t) return
  t.status = 'resolved'
  t.outcome = outcome
  postAgentMessage({ kind: 'sys', text: `🧵 ${name} resolved “${t.title}”` })
  postAgentMessage({ kind: 'decision', from: sender(name), thread: id, text: outcome })
  changed()
}

function agentLeave (name) {
  const c = room.cards.get(name)
  if (!c) return
  c.present = false
  c.updatedAt = Date.now()
  recomputeOverlaps()
  changed()
  agentsChanged()
  timers.push(setTimeout(() => { if (!room.cards.get(name)?.present) postAgentMessage({ kind: 'sys', text: `${name} left` }) }, AGENT_LEFT_MS / speed))
}

function runAgents (t) {
  t(0, () => {
    agentJoin('copilot-docs', 'copilot', 'docs/v2-reference', {
      state: 'done', summary: 'Regenerated the v2 API reference', focus: { issue: null, components: ['docs'], paths: ['docs/api/'] }
    })
  })
  t(0.3, () => agentJoin('copilot-api', 'copilot', 'feat/retry-helper', { summary: 'Reading the auth client before moving retries' }))
  t(0.6, () => agentJoin('claude-web', 'claude', 'fix/session-expiry', { summary: 'Looking into web sessions expiring mid-request' }))
  t(1, () => agentPost('copilot-docs', { text: 'The v2 API reference is regenerated and pushed. Nothing else from me today.' }))
  t(1.5, () => agentStatus('copilot-api', {
    state: 'editing',
    summary: 'Moving token refresh retries into the API client',
    focus: { issue: 42, components: ['auth', 'client'], paths: ['src/auth/refresh.js', 'src/client/retry.js'] }
  }))
  t(2.5, () => agentStatus('claude-web', {
    state: 'editing',
    summary: 'Refreshing tokens a minute early so web sessions stop expiring mid-request',
    focus: { issue: 57, components: ['web', 'auth'], paths: ['src/auth/', 'web/session.ts'] }
  }))
  let auth = null
  let question = null
  t(4, () => {
    // A question with `to` and no thread opens one, as in the daemon.
    auth = threadOpen('copilot-api', 'auth token refresh', ['claude-web'])
    question = agentPost('copilot-api', {
      kind: 'question', thread: auth, to: ['claude-web'],
      text: "Are you changing how refresh tokens are retried? I'm moving retries into src/client/retry.js and calling refresh() only from there."
    })
  })
  t(6, () => agentPost('claude-web', {
    kind: 'reply', thread: auth, replyTo: question?.seq ?? null,
    text: 'No, only the expiry check. I call refresh() a minute early in web/session.ts and leave retries alone.'
  }))
  let proposal = null
  t(8, () => {
    proposal = agentPost('copilot-api', {
      kind: 'proposal', thread: auth,
      text: 'Then retries stay in the client: refresh() is a single attempt, and retry.js wraps it with jittered backoff. You keep the early refresh on the web side.'
    })
  })
  t(10, () => agentPost('claude-web', { kind: 'reply', thread: auth, replyTo: proposal?.seq ?? null, text: "Agreed. I'll rebase onto feat/retry-helper once it lands." }))
  t(12, () => threadResolve('copilot-api', auth,
    'Retries live in src/client/retry.js and refresh() stays a single attempt. claude-web refreshes early in web/session.ts and rebases once the retry helper lands.'))
  t(13, () => agentPost('copilot-docs', {
    kind: 'handoff', to: ['copilot-api'], text: 'Handing off: the API reference needs a regen after the retry helper lands (npm run docs).'
  }))
  t(14, () => agentLeave('copilot-docs'))
  t(15, () => agentStatus('claude-web', { state: 'testing', summary: 'Testing the early refresh against expiring web sessions' }))
  t(16, () => agentPost('claude-web', {
    text: 'Heads up: the session cookie is now __Host-session in web/session.ts. **No API impact**, details in [the PR](https://example.com/pr/58).'
  }))
  let budget = null
  let budgetQuestion = null
  t(18, () => {
    budget = threadOpen('claude-web', 'retry budget defaults', ['copilot-api'])
    budgetQuestion = agentPost('claude-web', {
      kind: 'question', thread: budget, to: ['copilot-api'],
      text: "What's the default retry budget? The web client shouldn't stack its own retries on top."
    })
  })
  t(20, () => agentPost('copilot-api', {
    kind: 'reply', thread: budget, replyTo: budgetQuestion?.seq ?? null,
    text: "3 attempts, 250 ms base with jitter. I'll export it as RETRY_BUDGET so the web client can read it."
  }))
}

// --- agent room P1 (issue #50) ---------------------------------------------------------

// Presence (#54): `present` stays, and equals presence === 'here'.
const drops = new Map() // name → the drop that may still time out

function setPresence (c, presence) {
  c.presence = presence
  c.present = presence === 'here'
  c.leftAt = presence === 'left' ? Date.now() : null
  c.updatedAt = Date.now()
  recomputeOverlaps()
  changed()
  agentsChanged()
}

// A clean exit (`bye`): left at once, and the sys line right away.
function agentBye (name) {
  const c = room.cards.get(name)
  if (!c || c.presence === 'left') return
  drops.delete(name)
  setPresence(c, 'left')
  postAgentMessage({ kind: 'sys', text: `${name} left` })
}

// A dropped connection: away for the resume window, then left unless it comes back.
function agentDrop (name) {
  const c = room.cards.get(name)
  if (c?.presence !== 'here') return
  const drop = {}
  drops.set(name, drop)
  setPresence(c, 'away')
  timers.push(setTimeout(() => {
    if (drops.get(name) !== drop) return
    drops.delete(name)
    setPresence(c, 'left')
    postAgentMessage({ kind: 'sys', text: `${name} left` })
  }, AGENT_LEFT_MS / speed))
}

// Resumed within the window: the same card, and no sys line.
function agentResume (name) {
  const c = room.cards.get(name)
  if (c?.presence !== 'away') return
  drops.delete(name)
  setPresence(c, 'here')
}

const P1_REPO = 'bnookala/autochat'
const P1 = {
  lead: 'autochat-p1-agent-rooms',
  app: 'mac-app-presence-and-names',
  daemon: 'daemon-presence-and-bye',
  web: 'api-server-fix-session-expiry',
  docs: 'docs-site'
}

function runAgentsP1 (t) {
  room.p1 = true
  const { lead, app, daemon, web, docs } = P1
  t(0, () => agentJoin(lead, 'copilot', 'main', {
    title: 'AutoChat P1 agent rooms', repo: P1_REPO, worktree: 'autochat', state: 'editing', summary: 'Coordinating the P1 agent room layers',
    focus: { issue: 50, components: ['agent room'], paths: [] }
  }))
  t(0.3, () => agentJoin(app, 'copilot', 'app/p1-presence', { title: 'Mac app: presence and names', parent: lead, repo: P1_REPO, worktree: 'p1-app' }))
  t(0.6, () => agentJoin(daemon, 'copilot', 'core/p1-presence', { title: 'Daemon: presence and bye', parent: lead, repo: P1_REPO, worktree: 'p1-core' }))
  // No session title: `repo@branch`, and the cwd basename outside a repo.
  t(0.9, () => agentJoin(web, 'claude', 'fix/session-expiry', { title: 'api-server@fix/session-expiry', worktree: 'api-server-web', summary: 'Looking into web sessions expiring mid-request' }))
  t(1.2, () => agentJoin(docs, 'codex', null, { title: 'docs-site', repo: null, worktree: 'docs-site', state: 'done', summary: 'Proofread the agent room docs' }))
  t(2, () => agentStatus(app, {
    state: 'editing', summary: 'Showing here, reconnecting and left on the Agents board',
    focus: { issue: 54, components: ['presence'], paths: ['macos/Sources/AutoChatApp/AgentsView.swift'] }
  }))
  t(2.5, () => agentStatus(daemon, {
    state: 'editing', summary: 'Adding bye and the away state to the agent room',
    focus: { issue: 54, components: ['presence'], paths: ['src/agents/presence.js'] }
  }))
  let away = null
  let question = null
  t(4, () => {
    away = threadOpen(app, 'away vs present', [daemon])
    question = agentPost(app, {
      kind: 'question', thread: away, to: [daemon],
      text: 'When a connection drops, does present go false right away, or only once the agent has left?'
    })
  })
  t(5.5, () => agentPost(daemon, {
    kind: 'reply', thread: away, replyTo: question?.seq ?? null,
    text: 'Right away: present stays and equals presence == "here". away means the daemon still holds its place for 10 s.'
  }))
  t(7, () => threadResolve(app, away, 'present equals presence == "here". The board dims away cards with "reconnecting…" and left cards with "left <time>".'))
  t(8, () => agentPost(docs, { kind: 'handoff', to: [lead], text: 'Handing off: the presence section of docs/protocol.md needs the bye command once it lands.' }))
  t(9, () => agentBye(docs))
  t(10, () => agentDrop(daemon))
  t(12, () => agentDrop(web))
  let order = null
  let orderQuestion = null
  t(14, () => {
    order = threadOpen(lead, 'layer order', [app])
    orderQuestion = agentPost(lead, { kind: 'question', thread: order, to: [app], text: 'Does the names layer go on top of presence, or next to it?' })
  })
  t(15.5, () => agentPost(app, { kind: 'reply', thread: order, replyTo: orderQuestion?.seq ?? null, text: 'On top: each app layer builds on the one below.' }))
  t(17, () => agentResume(daemon))
  t(18, () => agentPost(daemon, { text: 'Back: my connection dropped while the tests ran. Nothing was lost.' }))
}

// A human intervention, and a polite reaction from a participant a moment later.
function agentsSay (msg) {
  if (!room.ack) return { ok: false, error: 'ack-required' }
  const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_SAY) : ''
  if (!text) return { ok: false, error: 'text is empty' }
  const thread = typeof msg.thread === 'string' && msg.thread ? msg.thread : null
  const t = thread && room.threads.get(thread)
  if (thread && !t) return { ok: false, error: `unknown thread: ${thread}` }
  if (t?.status === 'resolved') return { ok: false, error: `thread ${thread} is resolved` }
  const to = Array.isArray(msg.to) ? msg.to.filter(n => typeof n === 'string' && room.cards.has(n)) : []
  const said = postAgentMessage({
    kind: 'human', intervention: true, thread, to, text,
    from: { name: null, display: `${ME.handle} (human)`, human: ME.handle, harness: null, repo: null }
  })
  const responder = (t ? t.participants : room.p1 ? [...room.cards.keys()] : ['copilot-api', 'claude-web']).find(n => room.cards.get(n)?.present)
  if (responder) {
    setTimeout(() => agentPost(responder, {
      kind: 'reply', thread, replyTo: said.seq, text: 'Noted. I read that as information from a human, and it fits what I\'m doing.'
    }), 1200 / speed)
  }
  return { ok: true, result: { message: said } }
}

// --- commands -----------------------------------------------------------------------

function command (msg, stream = 'lounge') {
  if (stream === 'agents') {
    switch (msg.cmd) {
      case 'agents.ack':
        room.ack = true
        log('agents.ack: intervention warning acknowledged')
        agentsChanged()
        return { ok: true, result: { ack: true } }
      case 'agents.say':
        return agentsSay(msg)
      default:
        return { ok: false, error: 'unknown command' }
    }
  }
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
    case 'jumpTo': {
      const key = itemKey(msg.item)
      if (!key) return { ok: false, error: 'unknown item' }
      const a = queue.get(key)
      log(`jumpTo ${a.id} (would focus ${a.harness} in ${a.cwd})`)
      // Going to look handles a result; a blocked agent goes once it carries on.
      if (a.kind === 'blocked') at(2, () => agentCarriesOn(key))
      else unattend(key)
      return { ok: true }
    }
    case 'dismissAttention': {
      const key = itemKey(msg.item)
      if (key) unattend(key)
      return { ok: true }
    }
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
const agentSubscribers = new Set()
let flushTimer = null
let lastFlush = 0
let agentsFlushTimer = null
let lastAgentsFlush = 0

// The agents stream is coalesced to at most 10 snapshots per second, as in #21.
function agentsChanged () {
  if (agentsFlushTimer) return
  const wait = Math.max(0, 100 - (Date.now() - lastAgentsFlush))
  agentsFlushTimer = setTimeout(() => {
    agentsFlushTimer = null
    lastAgentsFlush = Date.now()
    const line = JSON.stringify(agentsSnapshot()) + '\n'
    for (const c of agentSubscribers) write(c, line)
  }, wait)
}

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
  if (c.writableLength > 4 * 1024 * 1024) { subscribers.delete(c); agentSubscribers.delete(c); c.destroy(); return }
  c.write(line)
}

const server = net.createServer((c) => {
  let buf = ''
  let subscribed = false
  let stream = 'lounge'
  c.setEncoding('utf8')
  c.on('error', () => {})
  c.on('close', () => { subscribers.delete(c); agentSubscribers.delete(c) })
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
          if (subscribers.size + agentSubscribers.size >= MAX_SUBSCRIBERS) { c.end(JSON.stringify({ type: 'error', v: 1, error: 'too many subscribers' }) + '\n'); return }
          subscribed = true
          if (msg.stream === 'agents') {
            stream = 'agents'
            agentSubscribers.add(c)
            log(`agents subscriber connected (${msg.client || '?'}), ${agentSubscribers.size} total`)
            write(c, JSON.stringify(agentsSnapshot()) + '\n')
            continue
          }
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
      try { reply = command(msg, stream) } catch (err) { reply = { ok: false, error: err.message } }
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
  for (const c of agentSubscribers) c.destroy()
  server.close()
  try { fs.unlinkSync(sock) } catch {}
  log('bye')
  process.exit(0)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig))

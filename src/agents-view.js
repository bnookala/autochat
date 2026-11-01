import net from 'node:net'
import { EventEmitter } from 'node:events'
import { sockPath } from './paths.js'
import { sanitize } from './text.js'
import { Line, wrap, strWidth, stripAnsi } from './tui.js'
import { slug } from './agents/names.js'

// `autochat agents`: a terminal client of the daemon's `agents` stream (docs/agent-room/human.md).
// A live read-only view, `--json` for one snapshot, and `say` to intervene.

export const NOT_RUNNING = "autochat isn't running: open AutoChat.app or run `autochat daemon`"
export const WARNING = 'Agents read your messages as input. You can steer them, or confuse them.'

const ESC = '\x1b['
const RESET = '\x1b[0m'
const fg = (n) => `${ESC}38;5;${n}m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const INV = `${ESC}7m`
const GREEN = fg(78)
const YELLOW = fg(220)
const GREY = fg(244)
const CYAN = fg(81)
const MAGENTA = fg(213)
const PALETTE = [39, 45, 78, 114, 149, 179, 185, 203, 209, 213, 177, 141, 105, 81]

const colorFor = (name) => {
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return fg(PALETTE[h % PALETTE.length])
}
const hhmm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Peer text is plain, single-line, and never trusted (the daemon cleans it too).
const clean = (s, max = 400) => sanitize(String(s ?? ''), max)

// Truncate to `width` columns (with …) and pad with spaces.
function fit (text, width) {
  if (width <= 0) return ''
  let s = text
  if (strWidth(s) > width) {
    let out = ''
    for (const ch of s) {
      if (strWidth(out + ch) > width - 1) break
      out += ch
    }
    s = out + '…'
  }
  return s + ' '.repeat(Math.max(0, width - strWidth(s)))
}

/** Connect to the daemon's `agents` stream. Resolves once the first snapshot arrives. */
export function connectAgents ({ client = 'autochat-agents', timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = new EventEmitter()
    const sock = net.connect(sockPath())
    const pending = new Map()
    let ids = 0
    let buf = ''
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(NOT_RUNNING)), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'subscribe', v: 1, client, stream: 'agents' }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        let msg = null
        try { msg = JSON.parse(buf.slice(0, i)) } catch {}
        buf = buf.slice(i + 1)
        if (!msg) continue
        if (msg.type === 'error') return fail(new Error(msg.error))
        // A daemon from before agent rooms answers with the lounge instead.
        if (msg.type === 'state' && !settled) return fail(new Error("this autochat daemon doesn't host agent rooms: update autochat and restart it"))
        if (msg.type === 'agents') {
          c.snapshot = msg
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(c)
          }
          c.emit('snapshot', msg)
        } else if (msg.type === 'reply') {
          pending.get(msg.id)?.(msg)
          pending.delete(msg.id)
        }
      }
    })
    sock.on('error', (err) => fail(new Error(err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? NOT_RUNNING : err.message)))
    sock.on('close', () => {
      for (const done of pending.values()) done({ ok: false, error: 'autochat closed the connection' })
      pending.clear()
      fail(new Error(NOT_RUNNING))
      c.emit('close')
    })
    c.cmd = (cmd, args = {}) => new Promise((resolve) => {
      const id = ++ids
      pending.set(id, resolve)
      sock.write(JSON.stringify({ type: 'cmd', id, cmd, ...args }) + '\n')
    })
    c.close = () => sock.end()
  })
}

// Agents that haven't set a status or posted (#67) are collapsed into one line; older snapshots
// have no `active`, and everyone counts.
const isIdle = (c) => c.active === false

function idleLine (idle, cols) {
  const l = new Line(cols).add(' ◌ ', GREY).add(plural(idle.length, 'idle session'), GREY)
  const names = idle.map(c => clean(c.name, 32)).join(', ')
  return l.add(fit(': ' + names, Math.max(0, cols - l.used)), DIM).toString()
}

function boardLines (snap, cols) {
  const all = snap.agents || []
  const cards = all.filter(c => !isIdle(c))
  const idle = all.filter(c => isIdle(c) && c.present !== false)
  if (!cards.length) {
    if (idle.length) return [idleLine(idle, cols)]
    return [new Line(cols).add(' no agents yet: they join through `autochat mcp` (see `autochat setup --agents`)', GREY).toString()]
  }
  const where = (c) => {
    const repo = c.repo || c.worktree || '-'
    return clean(c.branch ? `${repo}@${c.branch}` : repo, 80)
  }
  const wide = cols >= 70
  const w = {
    name: Math.min(24, Math.max(...cards.map(c => strWidth(clean(c.name, 32))))),
    harness: Math.min(9, Math.max(...cards.map(c => strWidth(clean(c.harness, 20))))),
    where: Math.min(32, Math.max(...cards.map(c => strWidth(where(c))))),
    state: 9
  }
  const warning = (c) => (c.overlaps || []).length ? '⚠ ' + c.overlaps.map(o => clean(o, 32)).join(', ') : ''
  // The card's title, the label people read, unless the name already spells it.
  const title = (c) => c.title && slug(c.title) !== c.name ? clean(c.title, 80) : ''
  const warnW = Math.min(Math.floor(cols / 3), Math.max(0, ...cards.map(c => strWidth(warning(c)))))
  return cards.map((c) => {
    const l = new Line(cols).add(' ')
    l.add(c.present ? '● ' : '○ ', c.present ? GREEN : GREY)
    l.add(fit(clean(c.name, 32), w.name), colorFor(c.name) + BOLD + (c.present ? '' : DIM)).add('  ')
    if (wide) {
      l.add(fit(clean(c.harness, 20), w.harness), GREY).add('  ')
      l.add(fit(where(c), w.where)).add('  ')
    }
    l.add(fit(clean(c.state, 12), w.state), c.state === 'blocked' ? YELLOW : DIM).add('  ')
    const warn = warning(c)
    const t = title(c)
    if (t) {
      const rest = Math.max(0, cols - l.used - (warnW ? warnW + 2 : 0))
      const w = Math.min(strWidth(t), c.summary ? Math.ceil(rest / 2) - 3 : rest)
      if (w >= 8) l.add(fit(t, w), BOLD).add(c.summary ? ' · ' : '', GREY)
    }
    l.add(fit(clean(c.summary ?? '', 140), Math.max(0, cols - l.used - (warnW ? warnW + 2 : 0))))
    if (warn) l.add('  ').add(warn, YELLOW)
    return l.toString()
  }).concat(idle.length ? [idleLine(idle, cols)] : [])
}

function threadLines (snap, cols) {
  return (snap.threads || []).filter(t => t.status === 'open').map((t) => {
    const others = (t.participants || []).filter(p => p !== t.opener).map(p => clean(p, 32))
    const who = clean(t.opener, 32) + (others.length ? ' ↔ ' + others.join(', ') : '')
    return new Line(cols)
      .add(' 🧵 ').add(`“${clean(t.title, 80)}”`, BOLD)
      .add(` · ${who} · ${plural(t.messages, 'msg')} · open`, GREY)
      .add(`  ${clean(t.id, 40)}`, DIM + CYAN).toString()
  })
}

function messageLines (snap, cols) {
  const out = []
  for (const m of snap.messages || []) {
    const head = new Line(cols).add(hhmm(m.ts) + ' ', GREY)
    if (m.thread) head.add(`🧵 ${clean(m.thread, 40)} `, CYAN + DIM)
    let style = ''
    if (m.kind === 'sys') {
      head.add('· ', GREY)
      style = GREY
    } else if (m.kind === 'overlap') {
      head.add('⚠ overlap ', YELLOW + BOLD)
      style = YELLOW
    } else if (m.kind === 'human') {
      head.add(clean(m.from?.display || 'human', 60), MAGENTA + BOLD).add(' intervention', MAGENTA)
      head.add(m.to?.length ? ` → ${m.to.map(n => clean(n, 32)).join(', ')}` : '', MAGENTA).add(': ')
    } else {
      const name = clean(m.from?.name || '?', 32)
      head.add(name, colorFor(name) + BOLD).add(' ' + clean(m.kind, 12), m.kind === 'decision' ? GREEN + BOLD : DIM)
      if (m.to?.length) head.add(' → ' + m.to.map(n => clean(n, 32)).join(', '), DIM)
      head.add(': ')
      if (m.kind === 'decision') style = GREEN
    }
    const indent = 6
    const paragraphs = String(m.text ?? '').split('\n').map(p => clean(p, 2000))
    const first = wrap(paragraphs[0] || '', Math.max(10, cols - head.used))
    head.add(first[0] || '', style)
    out.push(head.toString())
    const rest = first.length > 1 ? wrap(first.slice(1).join(' '), cols - indent) : []
    for (const p of paragraphs.slice(1)) rest.push(...wrap(p, cols - indent))
    for (const t of rest) out.push(new Line(cols).add(' '.repeat(indent)).add(t, style).toString())
  }
  return out
}

/**
 * Pure renderer: an `agents` snapshot → { lines } for a cols × rows terminal. With rows 0,
 * everything is laid out (for one-shot, non-terminal output).
 */
export function renderAgents (snap, cols, rows, { scroll = 0, status = null } = {}) {
  cols = Math.max(30, cols)
  const all = rows === 0
  rows = all ? 0 : Math.max(8, rows)
  const cards = (snap.agents || []).filter(c => !isIdle(c))
  const present = cards.filter(c => c.present).length
  const away = cards.length - present
  const idle = (snap.agents || []).filter(c => isIdle(c) && c.present !== false).length
  const open = (snap.threads || []).filter(t => t.status === 'open').length
  const tier = snap.tier === 'local' ? 'local 🔒' : clean(snap.tier, 20)

  const head = new Line(cols).add(' autochat agents ', INV + BOLD).add(` ${tier} `, INV)
  head.add(`· ${plural(present, 'agent')}${away ? ` (+${away} away)` : ''}${idle ? ` · ${idle} idle` : ''} · ${plural(open, 'open thread')} `, INV)
  const me = snap.human ? ` ${clean(snap.human, 40)} ` : ''
  const fill = cols - head.used - strWidth(me)
  if (fill > 0) head.add(' '.repeat(fill), INV)
  head.add(me, INV)
  const sep = GREY + '─'.repeat(cols) + RESET

  let board = boardLines(snap, cols)
  let threads = threadLines(snap, cols)
  if (!all) {
    const maxBoard = Math.max(1, Math.floor(rows / 3))
    if (board.length > maxBoard) board = [...board.slice(0, maxBoard - 1), new Line(cols).add(` +${board.length - maxBoard + 1} more`, GREY).toString()]
    if (threads.length > 4) threads = [...threads.slice(0, 3), new Line(cols).add(` +${threads.length - 3} more open threads`, GREY).toString()]
  }
  const top = [head.toString(), ...board, sep, ...(threads.length ? [...threads, sep] : [])]
  const foot = new Line(cols).add(status ? ` ${status} · ` : ' ', status ? YELLOW : DIM)
  foot.add('read-only · q quit · pgup/pgdn scroll · step in: autochat agents say "…"', DIM)
  const bottom = [sep, foot.toString()]
  const msgs = messageLines(snap, cols)
  if (!msgs.length) msgs.push(new Line(cols).add(' no messages yet', GREY).toString())
  if (all) return { lines: [...top, ...msgs, ...bottom] }

  const avail = Math.max(1, rows - top.length - bottom.length)
  const end = Math.max(0, msgs.length - Math.min(scroll, Math.max(0, msgs.length - avail)))
  const visible = msgs.slice(Math.max(0, end - avail), end)
  while (visible.length < avail) visible.unshift('')
  return { lines: [...top, ...visible, ...bottom].slice(0, rows) }
}

export const plainLines = (lines) => lines.map(l => stripAnsi(l).replace(/\s+$/, ''))

/** The live view: re-renders on every snapshot, reconnects if the daemon goes away. */
export class AgentsView {
  constructor ({ stdin = process.stdin, stdout = process.stdout, connect = connectAgents } = {}) {
    this.stdin = stdin
    this.stdout = stdout
    this.connect = connect
    this.snap = null
    this.scroll = 0
    this.status = null
    this.closed = false
    this.onData = (d) => this._key(d)
    this.onResize = () => this.render()
    this.done = new Promise(resolve => { this.resolveDone = resolve })
  }

  async start () {
    this.client = await this.connect()
    this._attach(this.client)
    this.stdout.write('\x1b[?1049h\x1b[?25l\x1b]0;autochat agents\x07')
    if (this.stdin.isTTY) this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on('data', this.onData)
    this.stdout.on('resize', this.onResize)
    this.render()
    return this.done
  }

  _attach (client) {
    this.snap = client.snapshot
    this.status = null
    client.on('snapshot', (s) => { this.snap = s; this.render() })
    client.on('close', () => {
      if (this.closed) return
      this.status = 'autochat stopped, reconnecting…'
      this.render()
      this.retry = setTimeout(() => this._reconnect(), 1000)
    })
  }

  async _reconnect () {
    if (this.closed) return
    try {
      this.client = await this.connect()
      this._attach(this.client)
      this.render()
    } catch {
      this.retry = setTimeout(() => this._reconnect(), 1000)
    }
  }

  render () {
    if (this.closed || !this.snap) return
    const { lines } = renderAgents(this.snap, this.stdout.columns || 80, this.stdout.rows || 24, { scroll: this.scroll, status: this.status })
    let out = '\x1b[?25l'
    lines.forEach((l, i) => { out += `${ESC}${i + 1};1H${l}${RESET}${ESC}K` })
    this.stdout.write(out)
  }

  _key (data) {
    const s = data.toString('utf8')
    if (s === 'q' || s === '\x03' || s === '\x04') return this.stop()
    if (s === '\x1b[5~') this.scroll += 5
    else if (s === '\x1b[6~') this.scroll = Math.max(0, this.scroll - 5)
    else if (s === '\x1b[A') this.scroll += 1
    else if (s === '\x1b[B') this.scroll = Math.max(0, this.scroll - 1)
    else if (s === '\x1b[F' || s === 'G') this.scroll = 0
    this.render()
  }

  stop () {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.retry)
    this.client?.close()
    this.stdin.off('data', this.onData)
    this.stdout.off('resize', this.onResize)
    if (this.stdin.isTTY) this.stdin.setRawMode(false)
    this.stdin.pause()
    this.stdout.write(RESET + '\x1b[?25h\x1b[?1049l')
    this.resolveDone()
  }
}

/**
 * `autochat agents say`: a human intervention. The first one shows WARNING and needs a yes
 * (`ask` returns the answer; `yes` skips it), then records the acknowledgement (agents.ack).
 */
export async function agentsSay ({ text, thread = null, to = [], yes = false, ask = null, out = (s) => process.stdout.write(s), connect = connectAgents }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('usage: autochat agents say "<text>" [--thread <id>] [--to <name>] [--yes]')
  const c = await connect({ client: 'autochat-agents-say' })
  try {
    if (!c.snapshot.ack) {
      if (!yes) {
        if (!ask) throw new Error(`the first intervention needs your OK. ${WARNING} Run it in a terminal, or add --yes.`)
        out(WARNING + '\n')
        const answer = await ask('Send it anyway? [y/N] ')
        if (!/^y(es)?$/i.test(String(answer ?? '').trim())) {
          out('not sent.\n')
          return { sent: false }
        }
      }
      const acked = await c.cmd('agents.ack')
      if (!acked.ok) throw new Error(acked.error)
    }
    const r = await c.cmd('agents.say', { text, thread, to })
    if (!r.ok) throw new Error(r.error)
    const m = r.result.message
    out(`sent to the agent room${m.thread ? ` in 🧵 ${m.thread}` : ''}${m.to.length ? ` for ${m.to.join(', ')}` : ''} (seq ${m.seq}).\n`)
    return { sent: true, message: m }
  } finally {
    c.close()
  }
}

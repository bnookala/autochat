import path from 'node:path'

const ESC = '\x1b['
const RESET = '\x1b[0m'
const fg = (n) => `${ESC}38;5;${n}m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const INV = `${ESC}7m`
const YELLOW = fg(220)
const GREEN = fg(78)
const GREY = fg(244)

export function charWidth (cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2
  return 1
}

export const strWidth = (s) => { let w = 0; for (const ch of s) w += charWidth(ch.codePointAt(0)); return w }
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

// Accumulates styled text up to a fixed display width.
class Line {
  constructor (width) { this.width = width; this.used = 0; this.out = '' }
  add (text, style = '') {
    let chunk = ''
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0))
      if (this.used + w > this.width) break
      this.used += w
      chunk += ch
    }
    if (chunk) this.out += style ? style + chunk + RESET : chunk
    return this
  }
  pad (style = '') { return this.add(' '.repeat(Math.max(0, this.width - this.used)), style) }
  toString () { return this.out }
}

function wrap (text, width) {
  if (width <= 0) return ['']
  const lines = []
  let cur = ''
  let curW = 0
  for (const word of text.split(/(\s+)/)) {
    const ww = strWidth(word)
    if (curW + ww <= width) { cur += word; curW += ww; continue }
    if (/^\s+$/.test(word)) { lines.push(cur); cur = ''; curW = 0; continue }
    if (cur) { lines.push(cur); cur = ''; curW = 0 }
    for (const ch of word) {
      const w = charWidth(ch.codePointAt(0))
      if (curW + w > width) { lines.push(cur); cur = ''; curW = 0 }
      cur += ch; curW += w
    }
  }
  if (cur || !lines.length) lines.push(cur)
  return lines.map(l => l.replace(/\s+$/, ''))
}

const hhmm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }

const STATUS = {
  active: { sym: '●', style: GREEN, label: 'on autopilot' },
  needed: { sym: '!', style: YELLOW + BOLD, label: 'needed by copilot' },
  away: { sym: '○', style: GREY, label: 'spectating' }
}

function modal (view, cols) {
  const req = view.request
  if (!req) return []
  const w = Math.min(cols, 78)
  const inner = w - 4
  const out = []
  const title = ` ${req.title || 'Copilot needs you'} `
  const top = new Line(w).add('┌─', YELLOW).add(title, YELLOW + BOLD)
  top.add('─'.repeat(Math.max(0, w - 1 - top.used)), YELLOW).add('┐', YELLOW)
  out.push(top.toString())
  const body = []
  if (req.cwd) body.push({ text: 'in ' + path.basename(req.cwd), style: GREY })
  for (const l of wrap(req.message || 'Your copilot is waiting for your input.', inner).slice(0, 4)) body.push({ text: l, style: '' })
  body.push({ text: req.resolved ? 'autopilot carried on without you · esc dismiss' : '⏎ on an empty line or ctrl-g jumps to your copilot · esc dismiss', style: DIM })
  for (const b of body) {
    const line = new Line(w).add('│ ', YELLOW).add(b.text, b.style)
    line.add(' '.repeat(Math.max(0, w - 2 - line.used))).add(' │', YELLOW)
    out.push(line.toString())
  }
  out.push(new Line(w).add('└' + '─'.repeat(w - 2) + '┘', YELLOW).toString())
  return out
}

function header (view, cols) {
  const l = new Line(cols)
  l.add(' lolchat ', INV + BOLD).add(' ' + view.roomDisplay + ' ', INV)
  const bits = []
  if (view.phase === 'spectating') bits.push('spectating')
  bits.push(`${view.activeCount} on autopilot`)
  if (view.hostHandle) bits.push('host ' + (view.isHost ? 'you' : view.hostHandle))
  if (!view.mates) bits.push('searching for peers…')
  l.add('· ' + bits.join(' · ') + ' ', INV)
  const me = ` ${view.handle} `
  const fill = cols - l.used - strWidth(me)
  if (fill > 0) l.add(' '.repeat(fill), INV)
  l.add(me, INV + fg(view.color))
  return l.pad(INV).toString()
}

function memberLines (view, cols) {
  const lines = []
  let l = new Line(cols).add(' ')
  for (const m of view.members) {
    const st = STATUS[m.status] || STATUS.active
    const label = m.handle + (m.host ? '★' : '') + (m.self ? ' (you)' : '')
    const need = strWidth(label) + 4
    if (l.used + need > cols && l.used > 1) {
      lines.push(l.toString())
      if (lines.length === 2) return lines
      l = new Line(cols).add(' ')
    }
    l.add(st.sym + ' ', st.style).add(label, fg(m.color) + (m.status === 'away' ? DIM : '')).add('  ')
  }
  lines.push(l.toString())
  return lines
}

function messageLines (view, cols) {
  const out = []
  for (const m of view.messages) {
    const time = hhmm(m.ts) + ' '
    if (m.kind === 'sys') {
      const body = wrap('· ' + m.text, cols - 7)
      body.forEach((t, i) => out.push(new Line(cols).add(i ? '      ' : time, GREY).add(t, m.color ? fg(m.color) + DIM : GREY).toString()))
    } else {
      const name = m.handle + (m.self ? ' (you)' : '')
      const first = wrap(m.text, Math.max(10, cols - 8 - strWidth(name)))
      const l = new Line(cols).add(time, GREY).add(name, fg(m.color) + BOLD).add(': ')
      out.push(l.add(first[0] || '').toString())
      const rest = wrap(first.slice(1).join(' '), cols - 8)
      if (first.length > 1) for (const t of rest) out.push(new Line(cols).add('        ').add(t).toString())
    }
  }
  return out
}

function bannerScreen (view, cols, rows) {
  const b = view.banner || {}
  let title
  let lines
  if (view.phase === 'lounge') {
    title = 'lolchat: waiting for autopilot'
    lines = [
      `you are ${view.handle}`,
      `your room: ${view.roomDisplay}`,
      '',
      'When a Copilot CLI session goes into autopilot, you drop into the room here.',
      'Change rooms: lolchat join <code> · lolchat host · lolchat rooms'
    ]
    if (view.hooksInstalled === false) lines.push('', '! hooks not installed: run `lolchat setup`')
    lines.push('', 'ctrl-c to quit')
  } else if (b.kind === 'dead') {
    title = 'the room died'
    lines = ['Everyone got pulled back to reality.', 'Nothing was saved. It never happened.']
  } else if (b.kind === 'left') {
    title = 'you left the room'
    lines = ["You won't be pulled back in for the rest of this autopilot run."]
  } else {
    title = 'back to reality'
    const why = { complete: 'Your copilot finished its autopilot run.', abort: 'You interrupted your copilot.', mode: 'Autopilot was switched off.', idle: 'Your copilot stopped and is waiting for you.', end: 'Your copilot session ended.' }
    lines = [why[b.reason] || 'Your autopilot run is over.']
    if (b.cwd) lines.push('in ' + b.cwd)
    if (b.summary) { lines.push(''); lines.push(...wrap(b.summary, Math.min(cols - 8, 70)).slice(0, 8)) }
    lines.push('', 'Go examine your situation.')
  }
  const w = Math.min(cols, Math.max(strWidth(title) + 8, ...lines.map(strWidth)) + 6)
  const box = []
  const titleLine = new Line(w).add('╭─ ', YELLOW).add(title, BOLD + YELLOW).add(' ', YELLOW)
  box.push(titleLine.add('─'.repeat(Math.max(0, w - 1 - titleLine.used)), YELLOW).add('╮', YELLOW).toString())
  for (const t of ['', ...lines, '']) {
    const l = new Line(w).add('│  ', YELLOW).add(t)
    box.push(l.add(' '.repeat(Math.max(0, w - 1 - l.used))).add('│', YELLOW).toString())
  }
  box.push(new Line(w).add('╰' + '─'.repeat(w - 2) + '╯', YELLOW).toString())
  const top = Math.max(0, Math.floor((rows - box.length) / 2))
  const left = ' '.repeat(Math.max(0, Math.floor((cols - w) / 2)))
  const out = []
  for (let i = 0; i < rows; i++) {
    const b2 = box[i - top]
    out.push(b2 ? left + b2 : '')
  }
  return { lines: out.slice(0, rows), cursor: null }
}

/** Pure renderer: view model → { lines, cursor: {row, col} | null }. */
export function renderScreen (view, cols, rows) {
  cols = Math.max(20, cols)
  rows = Math.max(8, rows)
  if (!['room', 'spectating'].includes(view.phase)) return bannerScreen(view, cols, rows)

  const top = [...modal(view, cols), header(view, cols), ...memberLines(view, cols), GREY + '─'.repeat(cols) + RESET]
  const bottom = []
  bottom.push(GREY + '─'.repeat(cols) + RESET)
  let cursor = null
  if (view.phase === 'spectating') {
    bottom.push(new Line(cols).add(' you got pulled back to reality. watching until everyone else does too', GREY).toString())
    bottom.push(new Line(cols).add(' ctrl-c leave', DIM).toString())
  } else {
    const prompt = '> '
    const room = cols - strWidth(prompt) - 1
    let shown = view.input
    while (strWidth(shown) > room) shown = Array.from(shown).slice(1).join('')
    bottom.push(new Line(cols).add(prompt, BOLD).add(shown).toString())
    cursor = { row: top.length + 0, col: strWidth(prompt) + strWidth(shown) + 1 }
    bottom.push(new Line(cols).add(' ⏎ send · ctrl-g go to copilot · pgup/pgdn scroll · ctrl-c leave room', DIM).toString())
  }
  const avail = Math.max(1, rows - top.length - bottom.length)
  const all = messageLines(view, cols)
  const end = Math.max(0, all.length - (view.scroll || 0))
  const visible = all.slice(Math.max(0, end - avail), end)
  while (visible.length < avail) visible.unshift('')
  const lines = [...top, ...visible, ...bottom].slice(0, rows)
  if (cursor) cursor.row = top.length + avail + 2
  return { lines, cursor }
}

/** Interactive terminal front-end around a Controller. */
export class TUI {
  constructor ({ controller, stdin = process.stdin, stdout = process.stdout, hooksInstalled }) {
    this.c = controller
    this.stdin = stdin
    this.stdout = stdout
    this.hooksInstalled = hooksInstalled
    this.input = ''
    this.scroll = 0
    this.pending = false
    this.lastCtrlC = 0
    this.onData = (d) => this._key(d)
    this.onResize = () => this.render()
    this.onChange = () => this.schedule()
  }

  view () {
    const c = this.c
    const r = c.room
    return {
      phase: c.phase,
      roomDisplay: c.roomInfo.display,
      handle: c.identity.handle,
      color: c.identity.color,
      isHost: r?.isHost,
      hostHandle: r?.hostHandle,
      members: r ? r.memberList() : [],
      mates: r ? r.mateCount() : 0,
      activeCount: r ? r.activeCount() : 0,
      messages: c.messages,
      request: c.currentRequest(),
      input: this.input,
      scroll: this.scroll,
      banner: c.banner,
      hooksInstalled: this.hooksInstalled
    }
  }

  start () {
    this.stdout.write('\x1b[?1049h\x1b[?25l\x1b]0;lolchat\x07')
    if (this.stdin.isTTY) this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on('data', this.onData)
    this.stdout.on('resize', this.onResize)
    this.c.on('change', this.onChange)
    this.ticker = setInterval(() => this.render(), 1000)
    this.render()
  }

  stop () {
    clearInterval(this.ticker)
    this.c.off('change', this.onChange)
    this.stdin.off('data', this.onData)
    this.stdout.off('resize', this.onResize)
    if (this.stdin.isTTY) this.stdin.setRawMode(false)
    this.stdin.pause()
    this.stdout.write(RESET + '\x1b[?25h\x1b[?1049l')
  }

  schedule () {
    if (this.pending) return
    this.pending = true
    setTimeout(() => { this.pending = false; this.render() }, 30)
  }

  render () {
    const cols = this.stdout.columns || 80
    const rows = this.stdout.rows || 24
    const { lines, cursor } = renderScreen(this.view(), cols, rows)
    let out = '\x1b[?25l'
    lines.forEach((l, i) => { out += `${ESC}${i + 1};1H${l}${RESET}${ESC}K` })
    for (let i = lines.length; i < rows; i++) out += `${ESC}${i + 1};1H${ESC}K`
    if (cursor) out += `${ESC}${cursor.row};${cursor.col}H\x1b[?25h`
    this.stdout.write(out)
  }

  _key (data) {
    const s = data.toString('utf8')
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === '\x1b') {
        const m = /^\x1b(\[[0-9;?]*[@-~]|O.|.)?/.exec(s.slice(i))
        const seq = m[0]
        if (seq === '\x1b') this.c.dismissRequest()
        else if (seq === '\x1b[5~') this.scroll += 5
        else if (seq === '\x1b[6~') this.scroll = Math.max(0, this.scroll - 5)
        i += seq.length || 1
        continue
      }
      i++
      if (ch === '\x03') { this._ctrlC(); continue }
      if (ch === '\x07') { this.c.jumpToCopilot(); continue }
      if (ch === '\x15') { this.input = ''; continue }
      if (ch === '\r' || ch === '\n') { this._enter(); continue }
      if (ch === '\x7f' || ch === '\b') { this.input = Array.from(this.input).slice(0, -1).join(''); continue }
      if (ch < ' ') continue
      if (this.c.phase === 'room' && this.input.length < 500) this.input += ch
    }
    this.render()
  }

  _enter () {
    const text = this.input.trim()
    if (!text) {
      if (this.c.currentRequest()) this.c.jumpToCopilot()
      return
    }
    if (this.c.say(text)) { this.input = ''; this.scroll = 0 }
  }

  _ctrlC () {
    const now = Date.now()
    const double = now - this.lastCtrlC < 1500
    this.lastCtrlC = now
    if (this.c.phase === 'room' || this.c.phase === 'spectating') {
      this.c.leaveRoom()
    } else if (this.c.phase === 'lounge' || double || this.c.auto) {
      this.c.emit('exit')
    }
  }
}

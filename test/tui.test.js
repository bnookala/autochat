import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderScreen, strWidth, stripAnsi, attentionLine, TUI } from '../src/tui.js'

const base = {
  phase: 'room', roomDisplay: '#lobby', handle: 'amber-otter-3f', color: 39, isHost: true, hostHandle: 'amber-otter-3f',
  members: [
    { handle: 'amber-otter-3f', status: 'active', self: true, host: true, color: 39 },
    { handle: 'jade-lynx-0c', status: 'needed', self: false, host: false, color: 78 },
    { handle: 'rusty-crab-91', status: 'away', self: false, host: false, color: 203 }
  ],
  mates: 2, activeCount: 2,
  messages: [
    { kind: 'sys', text: 'jade-lynx-0c joined', ts: 0 },
    { kind: 'chat', handle: 'jade-lynx-0c', color: 78, text: 'anyone else stuck on flaky tests? '.repeat(6) + '🙃', ts: 0 },
    { kind: 'chat', handle: 'amber-otter-3f', self: true, color: 39, text: '日本語もOK', ts: 0 }
  ],
  request: null, input: 'hello', scroll: 0, banner: null
}

const plain = (r) => r.lines.map(stripAnsi)

test('every rendered line fits the terminal width', () => {
  for (const cols of [20, 40, 80, 133]) {
    for (const view of [base, { ...base, request: { title: 'Permission needed', message: 'x'.repeat(400), cwd: '/a/b/proj' } }]) {
      const r = renderScreen(view, cols, 30)
      assert.equal(r.lines.length, 30)
      for (const l of plain(r)) assert.ok(strWidth(l) <= cols, `line too wide at ${cols}: ${l}`)
    }
  }
})

test('model requests render as a modal box above the chat', () => {
  const r = plain(renderScreen({ ...base, request: { title: 'Permission needed', message: 'Run rm -rf build?', cwd: '/w/proj' } }, 80, 24))
  assert.match(r[0], /^┌─ Permission needed/)
  assert.ok(r.some(l => l.includes('Run rm -rf build?')))
  const boxEnd = r.findIndex(l => l.startsWith('└'))
  const headerRow = r.findIndex(l => l.includes('autochat') && l.includes('#lobby'))
  assert.ok(boxEnd >= 0 && headerRow > boxEnd, 'modal sits above the room header')
  const without = plain(renderScreen(base, 80, 24))
  assert.match(without[0], /autochat/)
})

test('room view shows members, statuses, chat, and input cursor', () => {
  const r = renderScreen(base, 80, 24)
  const text = plain(r).join('\n')
  assert.match(text, /amber-otter-3f★ \(you\)/)
  assert.match(text, /! jade-lynx-0c/)
  assert.match(text, /○ rusty-crab-91/)
  assert.match(text, /jade-lynx-0c: anyone else stuck/)
  assert.match(text, /> hello/)
  assert.equal(r.cursor.row, plain(r).findIndex(l => l.startsWith('> hello')) + 1)
})

test('spectator view has no input; banners for reality and death', () => {
  const spec = plain(renderScreen({ ...base, phase: 'spectating' }, 80, 24)).join('\n')
  assert.match(spec, /pulled back to reality/)
  assert.doesNotMatch(spec, /> hello/)
  const reality = plain(renderScreen({ ...base, phase: 'reality', banner: { kind: 'reality', reason: 'complete', summary: 'Shipped the feature.', cwd: '/w/proj' } }, 80, 24)).join('\n')
  assert.match(reality, /back to reality/)
  assert.match(reality, /Shipped the feature\./)
  assert.match(reality, /examine your situation/)
  const dead = plain(renderScreen({ ...base, phase: 'dead', banner: { kind: 'dead' } }, 80, 24)).join('\n')
  assert.match(dead, /the room died/)
})

test('tiny terminals keep the cursor on screen; control chars never render', () => {
  for (const rows of [8, 9, 10, 12]) {
    const r = renderScreen({ ...base, request: { title: 'Permission needed', message: 'x '.repeat(200), cwd: '/a' } }, 60, rows)
    assert.equal(r.lines.length, rows)
    if (r.cursor) assert.ok(r.cursor.row <= rows, `cursor row ${r.cursor.row} > ${rows}`)
    assert.ok(r.cursor, 'input prompt still visible')
  }
  const evil = renderScreen({ ...base, messages: [{ kind: 'sys', text: 'a\x1b]52;c;Zm9v\x07b\x1b[2Jc', ts: 0 }] }, 80, 24)
  for (const l of evil.lines) assert.doesNotMatch(stripAnsi(l), /\x1b|\x07/)
})

test('exit countdown renders as a strip above a still-live input', () => {
  const view = { ...base, countdown: { endsAt: 0, total: 30, remaining: 23 } }
  for (const cols of [20, 40, 80]) {
    for (const rows of [8, 10, 24]) {
      const r = renderScreen(view, cols, rows)
      const p = plain(r)
      for (const l of p) assert.ok(strWidth(l) <= cols)
      assert.ok(r.cursor, 'input still focused')
      assert.ok(p[r.cursor.row - 1].startsWith('> hello'), `cursor on the prompt at ${cols}x${rows}`)
      assert.match(p[r.cursor.row - 2], /^ back to reality/)
    }
  }
  assert.ok(plain(renderScreen(view, 80, 24)).includes(' back to reality in 23s · ↵ on empty line to go now'))
  assert.doesNotMatch(plain(renderScreen(base, 80, 24)).join('\n'), /back to reality in/)
  assert.doesNotMatch(plain(renderScreen({ ...view, phase: 'spectating' }, 80, 24)).join('\n'), /back to reality in/)
})

test('enter on an empty line or /back skips the countdown; text is still sent', () => {
  const calls = []
  const c = {
    phase: 'room',
    roomInfo: { display: '#lobby' },
    identity: { handle: 'amber-otter-3f', color: 39 },
    room: null,
    messages: [],
    banner: null,
    countdown: { endsAt: Date.now() + 9000, total: 30 },
    countdownRemaining: () => 9,
    currentRequest: () => null,
    returnNow () { calls.push('returnNow'); return true },
    jumpToCopilot () { calls.push('jump') },
    say (text) { calls.push('say:' + text); return true }
  }
  const tui = new TUI({ controller: c, stdout: { columns: 80, rows: 24, write () {} } })
  tui._key('lol\r')
  tui._key('\r')
  tui._key('/back\r')
  c.countdown = null
  tui._key('/back\r')
  assert.deepEqual(calls, ['say:lol', 'returnNow', 'returnNow'])
  assert.equal(tui.input, '')
})

const attention = [
  { id: '3', harness: 'claude', sid: 'b1', cwd: '/w/web', kind: 'blocked', title: 'Permission needed', summary: 'Bash: npm test', at: 2 },
  { id: '1', harness: 'copilot', sid: 'a1', cwd: '/w/api-server', kind: 'finished', title: 'Copilot CLI finished', summary: 'done', at: 1 },
  { id: '2', harness: 'copilot', sid: 'a2', cwd: null, kind: 'finished', title: 'Copilot CLI session ended', summary: null, at: 3 }
]

test('attention queue: one line of counts and the next item, above a still-live input; the lounge shows it too', () => {
  assert.equal(attentionLine(attention).text, '1 blocked · 2 finished · claude: Permission needed (web)')
  assert.equal(attentionLine(attention, { sid: 'b1' }).text, '1 blocked · 2 finished · copilot: Copilot CLI finished (api-server)', 'the modal already shows that question')
  assert.equal(attentionLine(attention.slice(0, 1), { sid: 'b1' }), null)
  assert.equal(attentionLine([]), null)
  assert.equal(attentionLine(attention.slice(2)).sym, '✓')

  const view = { ...base, attention, countdown: { endsAt: 0, total: 30, remaining: 9 } }
  for (const cols of [20, 40, 80]) {
    for (const rows of [8, 10, 24]) {
      const r = renderScreen(view, cols, rows)
      const p = plain(r)
      for (const l of p) assert.ok(strWidth(l) <= cols)
      assert.ok(r.cursor && p[r.cursor.row - 1].startsWith('> hello'), `input still focused at ${cols}x${rows}`)
      assert.match(p[r.cursor.row - 2], /^ back to reality/)
      assert.match(p[r.cursor.row - 3], /^ ! 1 blocked/)
    }
  }
  assert.ok(plain(renderScreen(view, 80, 24)).includes(' ! 1 blocked · 2 finished · claude: Permission needed (web)'))
  assert.match(plain(renderScreen({ ...base, attention, phase: 'spectating' }, 80, 24)).join('\n'), /! 1 blocked/)
  assert.doesNotMatch(plain(renderScreen(base, 80, 24)).join('\n'), /blocked|finished/)

  const lounge = plain(renderScreen({ ...base, phase: 'lounge', attention }, 80, 24)).join('\n')
  assert.match(lounge, /! 1 blocked · 2 finished · claude: Permission needed \(web\)/)
  assert.match(lounge, /ctrl-g jumps to it/)
})

test('ctrl-g goes to the top of the attention queue, else to the agent that needs you', () => {
  const calls = []
  const c = {
    phase: 'room',
    roomInfo: { display: '#lobby' },
    identity: { handle: 'amber-otter-3f', color: 39 },
    room: null,
    messages: [],
    banner: null,
    countdown: null,
    queue: attention,
    attentionItems () { return this.queue },
    currentRequest: () => null,
    jumpTo (id) { calls.push('jumpTo:' + id); return true },
    jumpToCopilot () { calls.push('jump') }
  }
  const tui = new TUI({ controller: c, stdout: { columns: 80, rows: 24, write () {} } })
  tui._key('\x07')
  c.queue = []
  tui._key('\x07')
  assert.deepEqual(calls, ['jumpTo:3', 'jump'])
})

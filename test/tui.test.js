import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderScreen, strWidth, stripAnsi } from '../src/tui.js'

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
  const headerRow = r.findIndex(l => l.includes('lolchat') && l.includes('#lobby'))
  assert.ok(boxEnd >= 0 && headerRow > boxEnd, 'modal sits above the room header')
  const without = plain(renderScreen(base, 80, 24))
  assert.match(without[0], /lolchat/)
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

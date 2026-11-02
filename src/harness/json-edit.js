// Edits to a JSON config file's text that change only what they're about: every other byte stays,
// so the user's layout (inline arrays, key spacing, line endings) survives an install, and an
// uninstall right after it gives back the file it started from. For plain JSON with an object at
// the root (readJson() in util.js says whether a file is that).
//
// Additions go at the end of their object or array, laid out like its last entry (or, in an empty
// one, one indent deeper than its line). Removing an entry takes its separator with it, and then
// the objects and arrays it leaves empty (never the root) that `prune(keys)` says go too.

const WS = /[ \t\n\r]*/y
const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

// A tree of the text with offsets: objects have members [{key, start, keyEnd, end, value}] (start
// is the key's, end the value's), arrays have items; every node has [start, end).
export function parseTree (text) {
  let i = 0
  const fail = () => { throw new SyntaxError(`unexpected ${JSON.stringify(text[i] ?? 'end of input')} at ${i} in JSON`) }
  const ws = () => { WS.lastIndex = i; WS.exec(text); i = WS.lastIndex }
  const expect = (c) => { ws(); if (text[i] !== c) fail(); i++ }
  const string = () => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) fail()
    i++
    return { type: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) }
  }
  const value = () => {
    ws()
    const start = i
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i] === '{'
      const close = object ? '}' : ']'
      const list = []
      i++
      ws()
      if (text[i] === close) { i++; return object ? { type: 'object', start, end: i, members: list } : { type: 'array', start, end: i, items: list } }
      for (;;) {
        if (object) {
          ws()
          if (text[i] !== '"') fail()
          const key = string()
          expect(':')
          const v = value()
          list.push({ key: key.value, start: key.start, keyEnd: key.end, end: v.end, value: v })
        } else {
          list.push(value())
        }
        ws()
        if (text[i] === ',') { i++; continue }
        expect(close)
        return object ? { type: 'object', start, end: i, members: list } : { type: 'array', start, end: i, items: list }
      }
    }
    if (text[i] === '"') return string()
    SCALAR.lastIndex = i
    const m = SCALAR.exec(text)
    if (!m) fail()
    i = SCALAR.lastIndex
    return { type: 'scalar', start, end: i }
  }
  const root = value()
  ws()
  if (i !== text.length) fail()
  return root
}

const eolOf = (text) => text.includes('\r\n') ? '\r\n' : '\n'
const unitOf = (text) => (/^([ \t]+)["}\]]/m.exec(text) || [])[1] || '  '
const lineIndent = (text, pos) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos))[0]
// Duplicate keys: JSON.parse keeps the last, so do we.
const memberOf = (node, key) => node?.type === 'object' ? node.members.findLast(m => m.key === key) ?? null : null

function render (text, value, indent, multiline) {
  return multiline ? JSON.stringify(value, null, unitOf(text)).split('\n').join(eolOf(text) + indent) : JSON.stringify(value)
}

// Adds an entry at the end of an object or array: `entry(indent, multiline, colon)` renders it.
function append (text, node, root, entry) {
  const list = node.members || node.items
  if (list.length) {
    const last = list.at(-1)
    const before = text.slice(list.length > 1 ? list.at(-2).end : node.start + 1, last.start).replace(/^[^,]*,/, '')
    const multiline = before.includes('\n')
    const indent = multiline ? before.slice(before.lastIndexOf('\n') + 1) : ''
    const colon = node.members ? text.slice(last.keyEnd, last.value.start) : ''
    // After a lone entry there's no comma to copy: a file that spaces its colons spaces commas too.
    const sep = multiline ? eolOf(text) + indent : before || (list.length === 1 && /": /.test(text) ? ' ' : '')
    return text.slice(0, last.end) + ',' + sep + entry(indent, multiline, colon) + text.slice(last.end)
  }
  const multiline = node === root || text.trimEnd().includes('\n')
  if (!multiline) return text.slice(0, node.start + 1) + entry('', false, ':') + text.slice(node.end - 1)
  const outer = lineIndent(text, node.start)
  const indent = outer + unitOf(text)
  const eol = eolOf(text)
  return text.slice(0, node.start + 1) + eol + indent + entry(indent, true, ': ') + eol + outer + text.slice(node.end - 1)
}

// Takes entry `idx` out of an object or array, with its separator.
function cut (text, node, idx) {
  const list = node.members || node.items
  if (list.length === 1) return text.slice(0, node.start + 1) + text.slice(node.end - 1)
  if (idx > 0) return text.slice(0, list[idx - 1].end) + text.slice(list[idx].end)
  return text.slice(0, list[0].start) + text.slice(list[1].start)
}

/** Sets the member at `keys` (object keys from the root), creating the objects on the way. */
export function jsonSet (text, keys, value) {
  const root = parseTree(text)
  let node = root
  for (let d = 0; d < keys.length; d++) {
    if (node.type !== 'object') throw new TypeError(`${keys.slice(0, d).join('.')} isn't an object`)
    const m = memberOf(node, keys[d])
    if (!m) {
      const rest = keys.slice(d + 1).reduceRight((v, k) => ({ [k]: v }), value)
      return append(text, node, root, (indent, multiline, colon) => JSON.stringify(keys[d]) + colon + render(text, rest, indent, multiline))
    }
    if (d === keys.length - 1) {
      const multiline = text.trimEnd().includes('\n')
      return text.slice(0, m.value.start) + render(text, value, lineIndent(text, m.start), multiline) + text.slice(m.value.end)
    }
    node = m.value
  }
  return text
}

/** Removes the member at `keys`, then the objects that leaves empty, if `prune(keys)` says so. */
export function jsonDelete (text, keys, { prune = () => true } = {}) {
  const root = parseTree(text)
  let node = root
  for (const k of keys.slice(0, -1)) {
    node = memberOf(node, k)?.value
    if (node?.type !== 'object') return text
  }
  const idx = node.type === 'object' ? node.members.findLastIndex(m => m.key === keys.at(-1)) : -1
  if (idx < 0) return text
  if (node.members.length === 1 && keys.length > 1 && prune(keys.slice(0, -1))) return jsonDelete(text, keys.slice(0, -1), { prune })
  return cut(text, node, idx)
}

/** Appends `value` to the array at `keys`, creating it (and the objects on the way) if needed. */
export function jsonPush (text, keys, value) {
  const root = parseTree(text)
  let node = root
  for (const k of keys) {
    node = memberOf(node, k)?.value
    if (!node) return jsonSet(text, keys, [value])
  }
  if (node.type !== 'array') throw new TypeError(`${keys.join('.')} isn't an array`)
  return append(text, node, root, (indent, multiline) => render(text, value, indent, multiline))
}

/** Removes item `index` of the array at `keys`; one left empty goes too, if `prune(keys)` says so. */
export function jsonPull (text, keys, index, { prune = () => true } = {}) {
  let node = parseTree(text)
  for (const k of keys) node = memberOf(node, k)?.value
  if (node?.type !== 'array' || !node.items[index]) return text
  if (node.items.length === 1 && prune(keys)) return jsonDelete(text, keys, { prune })
  return cut(text, node, index)
}

/**
 * Parses JSON with comments and trailing commas, which opencode reads in its config too, for
 * reading only: none of the edits above work on it. Throws on anything else that isn't JSON.
 */
export function parseJsonc (text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
      out += ' '
    } else if (c !== ',' || !trailing(text, i + 1)) {
      out += c
    }
  }
  return JSON.parse(out)
}

// A comma at `i - 1` is a trailing one: only whitespace and comments before the closing bracket.
// Each comment matches whole, so a bracket inside one never counts.
const TRAILING = /(?:\s|\/\/[^\n]*(?=\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*[}\]]/y
function trailing (text, i) {
  TRAILING.lastIndex = i
  return TRAILING.test(text)
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTree, parseJsonc, jsonSet, jsonDelete, jsonPush, jsonPull } from '../src/harness/json-edit.js'

const ENTRY = { type: 'local', command: ['/n/node', '/a/autochat.js', 'mcp'], enabled: true }
const NOTES = '/home/me/.config/opencode/autochat.md'
const install = (text) => jsonPush(jsonSet(text, ['mcp', 'autochat'], ENTRY), ['instructions'], NOTES)
const uninstall = (text, opts) => {
  const i = JSON.parse(text).instructions.lastIndexOf(NOTES)
  return jsonPull(jsonDelete(text, ['mcp', 'autochat'], opts), ['instructions'], i, opts)
}

test('additions go at the end, laid out like their neighbours; nothing else changes', () => {
  const before = '{\n  "$schema": "https://opencode.ai/config.json",\n  "instructions": ["CONTRIBUTING.md", "docs/*.md"],\n  "mcp": {\n    "github": { "type": "remote", "url": "https://x" }\n  }\n}\n'
  assert.equal(install(before), '{\n  "$schema": "https://opencode.ai/config.json",\n  "instructions": ["CONTRIBUTING.md", "docs/*.md", "/home/me/.config/opencode/autochat.md"],\n  "mcp": {\n    "github": { "type": "remote", "url": "https://x" },\n    "autochat": {\n      "type": "local",\n      "command": [\n        "/n/node",\n        "/a/autochat.js",\n        "mcp"\n      ],\n      "enabled": true\n    }\n  }\n}\n')

  // Missing containers are made at the end of the root; tabs and CRLF are kept.
  assert.equal(install('{\r\n\t"model": "x"\r\n}'), '{\r\n\t"model": "x",\r\n\t"mcp": {\r\n\t\t"autochat": {\r\n\t\t\t"type": "local",\r\n\t\t\t"command": [\r\n\t\t\t\t"/n/node",\r\n\t\t\t\t"/a/autochat.js",\r\n\t\t\t\t"mcp"\r\n\t\t\t],\r\n\t\t\t"enabled": true\r\n\t\t}\r\n\t},\r\n\t"instructions": [\r\n\t\t"/home/me/.config/opencode/autochat.md"\r\n\t]\r\n}')

  // A file on one line stays on one line; an empty root gets a layout.
  assert.equal(install('{"model": "x", "instructions": []}'), '{"model": "x", "instructions": ["/home/me/.config/opencode/autochat.md"], "mcp": {"autochat":{"type":"local","command":["/n/node","/a/autochat.js","mcp"],"enabled":true}}}')
  assert.equal(jsonPush('{}\n', ['instructions'], NOTES), '{\n  "instructions": [\n    "/home/me/.config/opencode/autochat.md"\n  ]\n}\n')
  assert.equal(jsonPush('{\n  "instructions": [\n    "a.md"\n  ]\n}', ['instructions'], NOTES), '{\n  "instructions": [\n    "a.md",\n    "/home/me/.config/opencode/autochat.md"\n  ]\n}')
  assert.equal(jsonSet('{\n  "mcp": {}\n}', ['mcp', 'x'], 1), '{\n  "mcp": {\n    "x": 1\n  }\n}')
  // After a lone entry, a comma is spaced the way the file spaces its colons.
  assert.equal(jsonPush('{\n  "instructions": ["a.md"]\n}', ['instructions'], 'b.md'), '{\n  "instructions": ["a.md", "b.md"]\n}')
  assert.equal(jsonPush('{\n  "instructions": [ "a.md" ]\n}', ['instructions'], 'b.md'), '{\n  "instructions": [ "a.md", "b.md" ]\n}')
  assert.equal(jsonPush('{"instructions":["a.md"]}', ['instructions'], 'b.md'), '{"instructions":["a.md","b.md"]}')
  assert.equal(jsonSet('{"a": 1}', ['b'], 2), '{"a": 1, "b": 2}')
})

test('setting a member replaces only its value; strings that look like JSON are not structure', () => {
  const text = '{\n  "a": "},{\\"mcp\\": [",\n  "mcp": {\n    "autochat": {"command": ["/old"], "environment": {"X": "1"}},\n    "other": {"command": ["y"]}\n  }\n}\n'
  const next = jsonSet(text, ['mcp', 'autochat'], { command: ['/new'], environment: { X: '1' } })
  assert.equal(next, '{\n  "a": "},{\\"mcp\\": [",\n  "mcp": {\n    "autochat": {\n      "command": [\n        "/new"\n      ],\n      "environment": {\n        "X": "1"\n      }\n    },\n    "other": {"command": ["y"]}\n  }\n}\n')
  // Duplicate keys: JSON.parse keeps the last, and so does the edit.
  assert.equal(jsonSet('{"k": 1, "k": 2}', ['k'], 3), '{"k": 1, "k": 3}')
  assert.equal(jsonSet('{"k": 1}', ['k'], 'x'), '{"k": "x"}')
})

test('removing takes the separator, then the containers left empty, unless prune says keep', () => {
  const m = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n'
  assert.equal(jsonDelete(m, ['a']), '{\n  "b": 2,\n  "c": 3\n}\n')
  assert.equal(jsonDelete(m, ['b']), '{\n  "a": 1,\n  "c": 3\n}\n')
  assert.equal(jsonDelete(m, ['c']), '{\n  "a": 1,\n  "b": 2\n}\n')
  assert.equal(jsonDelete(m, ['nope']), m)
  assert.equal(jsonDelete(m, ['a', 'b']), m, 'a path through a non-object changes nothing')
  assert.equal(jsonPull('{"i": ["a", "b", "c"]}', ['i'], 0), '{"i": ["b", "c"]}')
  assert.equal(jsonPull('{"i": ["a", "b", "c"]}', ['i'], 1), '{"i": ["a", "c"]}')
  assert.equal(jsonPull('{"i": ["a", "b", "c"]}', ['i'], 3), '{"i": ["a", "b", "c"]}')

  // The root stays, even empty; other containers go when they're left empty...
  assert.equal(jsonDelete('{\n  "mcp": {\n    "autochat": {}\n  }\n}\n', ['mcp', 'autochat']), '{}\n')
  assert.equal(jsonPull('{\n  "x": 1,\n  "instructions": ["a"]\n}', ['instructions'], 0), '{\n  "x": 1\n}')
  // ...unless prune(keys) says to keep them.
  const keep = { prune: () => false }
  assert.equal(jsonDelete('{\n  "mcp": {\n    "autochat": {}\n  }\n}\n', ['mcp', 'autochat'], keep), '{\n  "mcp": {}\n}\n')
  assert.equal(jsonPull('{"x": 1, "instructions": ["a"]}', ['instructions'], 0, keep), '{"x": 1, "instructions": []}')
})

test('install then uninstall gives back every layout byte-for-byte', () => {
  const layouts = [
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "instructions": ["CONTRIBUTING.md"],\n  "mcp": {\n    "github": {"type": "remote", "url": "https://x"}\n  }\n}\n',
    '{\n  "model": "x"\n}\n',
    '{}\n',
    '{"theme":"dark","mcp":{"a":{"type":"local","command":["a"]}}}',
    '{\r\n    "model": "x",\r\n    "instructions": [\r\n        "a.md"\r\n    ]\r\n}\r\n',
    '{\n\t"instructions": [ "a.md", "b.md" ],\n\t"mcp": { "x": { "type": "local", "command": [ "x" ] } }\n}'
  ]
  for (const before of layouts) {
    const after = install(before)
    assert.deepEqual(JSON.parse(after), { ...JSON.parse(before), mcp: { ...JSON.parse(before).mcp, autochat: ENTRY }, instructions: [...(JSON.parse(before).instructions || []), NOTES] })
    assert.equal(uninstall(after), before, JSON.stringify(before))
  }
  // Empty containers the file had before are kept when prune says so.
  const had = '{\n  "mcp": {},\n  "instructions": []\n}\n'
  assert.equal(uninstall(install(had), { prune: () => false }), had)
})

test('the parser keeps offsets, and refuses what is not JSON', () => {
  const t = parseTree(' {"a" : [1, {"b": null}], "c": -1.5e3 } ')
  assert.deepEqual([t.type, t.start, t.end, t.members.map(m => m.key)], ['object', 1, 39, ['a', 'c']])
  assert.equal(t.members[0].value.items[1].members[0].value.type, 'scalar')
  for (const bad of ['{', '{"a": }', '{"a": 1,}', '// x\n{}', '{} x', '{"a": tru}']) assert.throws(() => parseTree(bad), SyntaxError, bad)
})

test('parseJsonc reads what opencode reads: comments and trailing commas, never inside strings', () => {
  assert.deepEqual(parseJsonc('{\n  // a comment, with "quotes"\n  "url": "https://x//y", /* block,\n  ] */ "a": [1, 2, /* x */],\n  "s": "a, ] /* not */ //",\n  "o": {"k": 1,\n  // last\n  },\n}\n'), { url: 'https://x//y', a: [1, 2], s: 'a, ] /* not */ //', o: { k: 1 } })
  assert.deepEqual(parseJsonc('{"q": "say \\"hi\\", // still a string"}'), { q: 'say "hi", // still a string' })
  // Brackets inside comments don't make a comma trailing.
  assert.deepEqual(parseJsonc('{"a": 1, // note ]\n "b": 2, /* } */ "c": 3}'), { a: 1, b: 2, c: 3 })
  for (const bad of ['{"a": 1,,}', '{"a": tru}', '{"a": "x}']) assert.throws(() => parseJsonc(bad), SyntaxError, bad)
})

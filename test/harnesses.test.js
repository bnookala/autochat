import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-harnesses-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
const { harnessContext, planAgents, setupAgents, removeAgents, agentsStatus, describePlan } = await import('../src/harnesses.js')
const { describeAgentStatus } = await import('../src/harness/index.js')
const { etiquetteSource } = await import('../src/harness/opencode.js')
const { instructions, TOOLS } = await import('../src/agent-client.js')

let n = 0
// A fresh fake user: its own HOME (and COPILOT_HOME, XDG_CONFIG_HOME, CODEX_HOME), harness
// binaries only from bin/, and a stand-in for the `claude` CLI that never runs the real one.
function user ({ bins = [], claude = null } = {}) {
  const root = path.join(tmp, 'u' + (++n))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  for (const b of bins) { fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, b), 0o755) }
  const env = { HOME: home, PATH: '/usr/bin:/bin', AUTOCHAT_HARNESS_PATH: bin }
  const calls = []
  const run = (cmd, args) => {
    calls.push([path.basename(cmd), ...args])
    return claude ? claude(args) : { status: 1, stdout: '', stderr: 'no claude' }
  }
  // The node and autochat.js a registration points at must exist for doctor to call it valid.
  const node = path.join(root, 'node')
  const autochat = path.join(root, 'autochat', 'bin', 'autochat.js')
  fs.mkdirSync(path.dirname(autochat), { recursive: true })
  fs.writeFileSync(node, '')
  fs.writeFileSync(autochat, '')
  const ctx = harnessContext({ env, node, bin: autochat, run })
  const file = (...p) => path.join(home, ...p)
  return { root, home, bin, env, ctx, calls, node, autochat, file }
}
const read = (f) => fs.readFileSync(f, 'utf8')
const quiet = { out: () => {} }

// What `claude mcp get/add/remove` do, from Claude Code 2.1's CLI, kept in memory.
function fakeClaude () {
  let server = null
  return (args) => {
    const [, sub] = args
    if (sub === 'get') {
      if (!server) return { status: 1, stdout: 'No MCP server named "autochat". Run `claude mcp add` to add one.\n', stderr: '' }
      return { status: 0, stdout: `autochat:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: ${server.command}\n  Args: ${server.args.join(' ')}\n  Environment:\n\nTo remove this server, run: claude mcp remove autochat -s user\n`, stderr: '' }
    }
    if (sub === 'add') {
      if (server) return { status: 1, stdout: '', stderr: 'MCP server autochat already exists in user config\n' }
      const i = args.indexOf('--')
      server = { command: args[i + 1], args: args.slice(i + 2) }
      return { status: 0, stdout: 'Added stdio MCP server autochat\n', stderr: '' }
    }
    if (sub === 'remove') { server = null; return { status: 0, stdout: 'Removed\n', stderr: '' } }
    return { status: 2, stdout: '', stderr: 'unknown' }
  }
}

test('Copilot CLI: mcpServers.autochat in $COPILOT_HOME/mcp-config.json; rerun is a no-op; uninstall; other servers untouched', () => {
  const u = user({ bins: ['copilot'] })
  const copilotHome = path.join(u.root, 'copilot-home')
  const ctx = harnessContext({ env: { ...u.env, COPILOT_HOME: copilotHome }, node: u.node, bin: u.autochat, run: () => ({ status: 1 }) })
  const file = path.join(copilotHome, 'mcp-config.json')
  fs.mkdirSync(copilotHome, { recursive: true })
  const before = '{\n  "mcpServers": {\n    "github": {\n      "type": "http",\n      "url": "https://api.githubcopilot.com/mcp/"\n    }\n  },\n  "theme": "dark"\n}\n'
  fs.writeFileSync(file, before)

  const r = setupAgents({ ctx, ...quiet })
  assert.deepEqual(r.applied, ['copilot'])
  const cfg = JSON.parse(read(file))
  assert.deepEqual(cfg.mcpServers.autochat, { type: 'local', command: u.node, args: [u.autochat, 'mcp', '--harness', 'copilot'], tools: ['*'] })
  assert.deepEqual(cfg.mcpServers.github, { type: 'http', url: 'https://api.githubcopilot.com/mcp/' })
  assert.equal(cfg.theme, 'dark')
  assert.deepEqual(Object.keys(cfg.mcpServers), ['github', 'autochat'], 'appended after the existing servers')
  assert.equal(read(file + '.autochat.bak'), before, 'one-time backup')

  const mtime = fs.statSync(file).mtimeMs
  const again = setupAgents({ ctx, ...quiet })
  assert.deepEqual(again.applied, [])
  assert.equal(again.plans.find(p => p.id === 'copilot').action, 'none')
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'rerunning writes nothing')

  assert.deepEqual(removeAgents({ ctx, ...quiet }), ['copilot'])
  assert.deepEqual(JSON.parse(read(file)), JSON.parse(before))
  assert.equal(read(file + '.autochat.bak'), before, 'the backup is never overwritten')
  assert.deepEqual(removeAgents({ ctx, ...quiet }), [])
})

test('Gemini CLI and opencode: their formats, the file indentation is kept, comments are refused', () => {
  const u = user({ bins: ['gemini', 'opencode'] })
  fs.mkdirSync(u.file('.gemini'), { recursive: true })
  fs.writeFileSync(u.file('.gemini', 'settings.json'), '{\n\t"theme": "Dracula",\n\t"mcpServers": {\n\t\t"other": {\n\t\t\t"command": "x"\n\t\t}\n\t}\n}\n')
  const r = setupAgents({ ctx: u.ctx, ...quiet })
  assert.deepEqual(r.applied, ['gemini', 'opencode'])
  const gemini = read(u.file('.gemini', 'settings.json'))
  assert.match(gemini, /^\{\n\t"theme": "Dracula",\n\t"mcpServers": \{\n\t\t"other"/, 'tabs stay tabs')
  assert.deepEqual(JSON.parse(gemini).mcpServers, { other: { command: 'x' }, autochat: { command: u.node, args: [u.autochat, 'mcp', '--harness', 'gemini'] } })
  const opencode = JSON.parse(read(u.file('.config', 'opencode', 'opencode.json')))
  assert.deepEqual(opencode, {
    $schema: 'https://opencode.ai/config.json',
    mcp: { autochat: { type: 'local', command: [u.node, u.autochat, 'mcp', '--harness', 'opencode'], enabled: true, timeout: 60000 } },
    instructions: [u.file('.config', 'opencode', 'autochat.md')]
  })
  assert.equal(fs.existsSync(u.file('.config', 'opencode', 'opencode.json.autochat.bak')), false, 'nothing to back up for a new file')
  assert.deepEqual(setupAgents({ ctx: u.ctx, ...quiet }).applied, [], 'idempotent')

  // An entry the user extended keeps their extra settings when it's updated.
  const g = JSON.parse(read(u.file('.gemini', 'settings.json')))
  g.mcpServers.autochat = { command: '/old/node', args: ['/old/autochat.js', 'mcp', '--harness', 'gemini'], trust: true }
  fs.writeFileSync(u.file('.gemini', 'settings.json'), JSON.stringify(g, null, 2) + '\n')
  const plan = planAgents(u.ctx).find(p => p.id === 'gemini')
  assert.equal(plan.action, 'update')
  plan.apply()
  assert.deepEqual(JSON.parse(read(u.file('.gemini', 'settings.json'))).mcpServers.autochat, { command: u.node, args: [u.autochat, 'mcp', '--harness', 'gemini'], trust: true })

  // JSON with comments isn't rewritten: setup says what to add by hand.
  const jsonc = '{\n  // my settings\n  "theme": "x",\n}\n'
  fs.writeFileSync(u.file('.gemini', 'settings.json'), jsonc)
  const manual = planAgents(u.ctx).find(p => p.id === 'gemini')
  assert.equal(manual.action, 'manual')
  assert.equal(manual.apply, undefined)
  assert.match(describePlan(manual, u.ctx).join('\n'), /~\/\.gemini\/settings\.json isn't plain JSON \(comments\?\), so autochat won't rewrite it\. Add this yourself:\n\s+\{\n\s+"autochat": \{/)
  setupAgents({ ctx: u.ctx, ...quiet })
  assert.equal(read(u.file('.gemini', 'settings.json')), jsonc)

  removeAgents({ ctx: u.ctx, ...quiet })
  assert.equal(fs.existsSync(u.file('.config', 'opencode', 'opencode.json')), false, 'autochat made it, and nothing else is in it')
  assert.deepEqual(fs.readdirSync(u.file('.config', 'opencode')), [])
})

test('Codex: [mcp_servers.autochat] in $CODEX_HOME/config.toml, edited as text', () => {
  const u = user()
  fs.mkdirSync(u.file('.codex'), { recursive: true })
  const before = '# my codex config\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x" # keep me\n\n[profiles.fast]\nmodel = "o4-mini"\n'
  fs.writeFileSync(u.file('.codex', 'config.toml'), before)
  assert.deepEqual(setupAgents({ ctx: u.ctx, ...quiet }).applied, ['codex'], 'an existing ~/.codex counts as installed')
  const text = read(u.file('.codex', 'config.toml'))
  assert.equal(text, before + `\n[mcp_servers.autochat]\ncommand = ${JSON.stringify(u.node)}\nargs = [${JSON.stringify(u.autochat)}, "mcp", "--harness", "codex"]\n`)
  assert.deepEqual(setupAgents({ ctx: u.ctx, ...quiet }).applied, [], 'idempotent')

  // Moved install: command and args are rewritten in place (even a multi-line args array), other
  // settings in the table and sub-tables stay.
  const moved = text.replace(/command = "[^"]*node"\nargs = \[.*\]/, 'command = "/old/node"\nargs = [\n  "/old/autochat.js",\n  "mcp",\n]\ntool_timeout_sec = 90\n\n[mcp_servers.autochat.env]\nFOO = "1"')
  fs.writeFileSync(u.file('.codex', 'config.toml'), moved)
  assert.deepEqual(agentsStatus(u.ctx).find(h => h.id === 'codex').valid, false)
  assert.deepEqual(setupAgents({ ctx: u.ctx, ...quiet }).applied, ['codex'])
  const updated = read(u.file('.codex', 'config.toml'))
  assert.match(updated, /\[mcp_servers\.autochat\]\ncommand = ".*node"\nargs = \[".*autochat\.js", "mcp", "--harness", "codex"\]\ntool_timeout_sec = 90\n\n\[mcp_servers\.autochat\.env\]\nFOO = "1"/)
  assert.equal(agentsStatus(u.ctx).find(h => h.id === 'codex').valid, true)

  assert.deepEqual(removeAgents({ ctx: u.ctx, ...quiet }), ['codex'])
  assert.equal(read(u.file('.codex', 'config.toml')), before, 'the table and its sub-tables go; the rest is byte-for-byte')
})

test('Claude Code: through `claude mcp`, checked with `claude mcp get` first; a stale path is re-added', () => {
  const u = user({ bins: ['claude'], claude: fakeClaude() })
  const p = planAgents(u.ctx).find(x => x.id === 'claude')
  assert.equal(p.action, 'add')
  assert.match(describePlan(p, u.ctx)[0], /^claude {3}run: claude mcp add --scope user autochat -- .*node .*autochat\.js mcp --harness claude$/)
  assert.deepEqual(setupAgents({ ctx: u.ctx, plans: [p], ...quiet }).applied, ['claude'])
  assert.deepEqual(u.calls, [
    ['claude', 'mcp', 'get', 'autochat'],
    ['claude', 'mcp', 'add', '--scope', 'user', 'autochat', '--', u.node, u.autochat, 'mcp', '--harness', 'claude']
  ])
  const st = agentsStatus(u.ctx).find(h => h.id === 'claude')
  assert.deepEqual([st.installed, st.registered, st.valid], [true, true, true])
  u.calls.length = 0
  assert.equal(planAgents(u.ctx).find(x => x.id === 'claude').action, 'none', 'already registered with this path')

  // The install moved: remove, then add again.
  const moved = harnessContext({ env: u.env, node: u.node, bin: path.join(u.root, 'new', 'autochat.js'), run: u.ctx.run })
  const up = planAgents(moved).find(x => x.id === 'claude')
  assert.equal(up.action, 'update')
  up.apply()
  assert.deepEqual(u.calls.slice(-2).map(c => c.slice(0, 3)), [['claude', 'mcp', 'remove'], ['claude', 'mcp', 'add']])
  assert.equal(agentsStatus(moved).find(h => h.id === 'claude').valid, false, "the new path doesn't exist on disk")

  assert.deepEqual(removeAgents({ ctx: moved, ...quiet }), ['claude'])
  assert.deepEqual(u.calls.at(-1), ['claude', 'mcp', 'remove', '--scope', 'user', 'autochat'])
  assert.equal(agentsStatus(moved).find(h => h.id === 'claude').registered, false)
})

test('detection: missing harnesses are skipped, pi gets its extension, nothing found says so', () => {
  const none = user()
  const lines = []
  const r = setupAgents({ ctx: none.ctx, out: (l) => lines.push(l) })
  assert.deepEqual(r.plans.map(p => [p.id, p.action]), [['copilot', 'absent'], ['claude', 'absent'], ['gemini', 'absent'], ['opencode', 'absent'], ['codex', 'absent'], ['pi', 'absent']])
  assert.match(lines.at(-1), /No agent harnesses found/)
  assert.deepEqual(none.calls, [], 'no claude binary, no claude calls')
  const pi = user({ bins: ['pi'] })
  const out = []
  setupAgents({ ctx: pi.ctx, out: (l) => out.push(l) })
  assert.ok(out.includes('  pi       add to ~/.pi/agent/extensions/autochat.ts'), out.join('\n'))
  assert.ok(out.includes('✔ pi connected'), out.join('\n'))
  assert.deepEqual(fs.readdirSync(path.join(pi.home, '.pi', 'agent', 'extensions')), ['autochat.ts'], 'pi has no MCP: its tools come with the autochat extension')
})

test('CLI: setup --agents --dry-run changes nothing; setup --agents, rerun, uninstall; plain setup only hints', () => {
  const u = user({ bins: ['gemini'] })
  fs.mkdirSync(u.file('.gemini'), { recursive: true })
  fs.writeFileSync(u.file('.gemini', 'settings.json'), '{"theme":"x"}\n')
  const env = { ...process.env, ...u.env, AUTOCHAT_HOME: path.join(u.root, 'ac'), COPILOT_HOME: u.file('.copilot'), XDG_CONFIG_HOME: u.file('.config'), CODEX_HOME: u.file('.codex'), AUTOCHAT_APP_DIRS: path.join(u.root, 'no-apps') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const dry = cli('setup', '--agents', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /gemini {3}add to ~\/\.gemini\/settings\.json\n {11}\+ "autochat": \{"command":/)
  assert.match(dry.stdout, /Dry run: nothing changed\./)
  assert.equal(read(u.file('.gemini', 'settings.json')), '{"theme":"x"}\n')

  const real = cli('setup', '--agents')
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /✔ gemini connected/)
  assert.equal(JSON.parse(read(u.file('.gemini', 'settings.json'))).mcpServers.autochat.args.at(-1), 'gemini')
  assert.match(cli('setup', '--agents').stdout, /gemini {3}already connected[^\n]*\n[\s\S]*Nothing to change\./)

  // Plain setup without a terminal never prompts or touches harness configs.
  const plain = cli('setup')
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /Connect your coding agents to the agent room \(preview\): autochat setup --agents/)
  assert.ok(fs.existsSync(u.file('.copilot', 'hooks', 'autochat.json')), 'hooks as before')

  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /^hooks removed\.\nremoved the autochat MCP server from Gemini CLI \(~\/\.gemini\/settings\.json\)\n$/)
  assert.deepEqual(JSON.parse(read(u.file('.gemini', 'settings.json'))), { theme: 'x', mcpServers: {} })
})

test('changes made between showing the plan and applying it are kept; symlinked configs stay symlinks', () => {
  const u = user({ bins: ['gemini'] })
  fs.mkdirSync(u.file('.gemini'), { recursive: true })
  fs.writeFileSync(u.file('.gemini', 'settings.json'), '{"theme":"x"}\n')
  const plan = planAgents(u.ctx).find(p => p.id === 'gemini')
  // Meanwhile (say, while the [Y/n] prompt waits), something else adds a server.
  fs.writeFileSync(u.file('.gemini', 'settings.json'), '{"theme":"x","mcpServers":{"added":{"command":"y"}}}\n')
  plan.apply()
  assert.deepEqual(Object.keys(JSON.parse(read(u.file('.gemini', 'settings.json'))).mcpServers), ['added', 'autochat'])

  // dotfile managers: ~/.codex/config.toml -> ~/dotfiles/codex.toml
  const dot = path.join(u.root, 'dotfiles')
  fs.mkdirSync(dot, { recursive: true })
  fs.writeFileSync(path.join(dot, 'codex.toml'), 'model = "o3"\n')
  fs.mkdirSync(u.file('.codex'), { recursive: true })
  fs.symlinkSync(path.join(dot, 'codex.toml'), u.file('.codex', 'config.toml'))
  assert.deepEqual(setupAgents({ ctx: u.ctx, ...quiet }).applied, ['codex'])
  assert.ok(fs.lstatSync(u.file('.codex', 'config.toml')).isSymbolicLink(), 'still a symlink')
  assert.match(read(path.join(dot, 'codex.toml')), /^model = "o3"\n\n\[mcp_servers\.autochat\]\n/, 'the target got the entry')
  assert.equal(read(u.file('.codex', 'config.toml.autochat.bak')), 'model = "o3"\n')
  removeAgents({ ctx: u.ctx, ...quiet })
  assert.ok(fs.lstatSync(u.file('.codex', 'config.toml')).isSymbolicLink())
  assert.equal(read(path.join(dot, 'codex.toml')), 'model = "o3"\n')
})

const ETIQUETTE_LINE = "         + ~/.config/opencode/autochat.md: the agent-room etiquette (opencode doesn't show MCP server instructions to the model)"

test('opencode: the etiquette goes in a file of autochat\'s own, listed under "instructions"; every other byte stays; uninstall gives the file back', () => {
  const u = user({ bins: ['opencode'] })
  const dir = u.file('.config', 'opencode')
  const file = path.join(dir, 'opencode.json')
  const notes = path.join(dir, 'autochat.md')
  fs.mkdirSync(path.join(dir, 'plugin'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'my rules\n')
  fs.writeFileSync(path.join(dir, 'plugin', 'notify.js'), 'export default async () => ({})\n')
  const before = [
    '{',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "model": "github-copilot/claude-opus-5.5",',
    '  "instructions": ["CONTRIBUTING.md", "docs/*.md"],',
    '  "mcp": {',
    '    "github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/" }',
    '  },',
    '  "provider": { "github-copilot": { "models": { "claude-opus-5.5": { "provider": { "api": "https://api.githubcopilot.com" } } } } }',
    '}',
    ''
  ].join('\n')
  fs.writeFileSync(file, before)

  // Shown, then made.
  const lines = []
  assert.deepEqual(setupAgents({ ctx: u.ctx, out: (l) => lines.push(l) }).applied, ['opencode'])
  const at = lines.indexOf('  opencode add to ~/.config/opencode/opencode.json')
  assert.ok(at > 0, lines.join('\n'))
  assert.match(lines[at + 1], /^ {11}\+ "autochat": \{"type":"local","command":\[.*\],"enabled":true,"timeout":60000\}$/)
  assert.deepEqual(lines.slice(at + 2, at + 4), ['           + "instructions": […, "~/.config/opencode/autochat.md"]', '  ' + ETIQUETTE_LINE])

  // The etiquette is what `autochat mcp` serves, with opencode's names for the tools.
  const text = read(notes)
  assert.equal(text, etiquetteSource())
  assert.match(text, /^<!-- autochat's etiquette for opencode: .* -->\n## autochat agent room\n/)
  assert.ok(text.includes(instructions((tool) => `autochat_${tool}`)))
  const named = [...text.matchAll(/`(autochat_\w+)`/g)].map(m => m[1])
  assert.ok(named.length >= 5, named.join(' '))
  for (const name of named) assert.ok(TOOLS.some(t => `autochat_${t.name}` === name), `${name} is one of the tools`)
  assert.doesNotMatch(text, new RegExp('`(' + TOOLS.map(t => t.name).join('|') + ')`'), 'no bare tool names')

  // opencode.json: our two entries at the end of their lists, every other byte as it was.
  const entry = { type: 'local', command: [u.node, u.autochat, 'mcp', '--harness', 'opencode'], enabled: true, timeout: 60000 }
  assert.equal(read(file), before
    .replace('"docs/*.md"]', `"docs/*.md", ${JSON.stringify(notes)}]`)
    .replace('/mcp/" }\n  }', `/mcp/" },\n    "autochat": ${JSON.stringify(entry, null, 2).replace(/\n/g, '\n    ')}\n  }`))
  assert.equal(read(file + '.autochat.bak'), before)
  assert.equal(read(path.join(dir, 'AGENTS.md')), 'my rules\n')
  assert.equal(read(path.join(dir, 'plugin', 'notify.js')), 'export default async () => ({})\n')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['AGENTS.md', 'autochat.md', 'opencode.json', 'opencode.json.autochat.bak', 'plugin'])

  // Doctor: connected, and the etiquette reaches the model.
  assert.deepEqual(describeAgentStatus(agentsStatus(u.ctx).find(h => h.id === 'opencode')), [
    [true, 'opencode: connected to the agent room (~/.config/opencode/opencode.json)'],
    [true, 'opencode: the etiquette reaches the model from ~/.config/opencode/autochat.md, listed under "instructions" (opencode doesn\'t show MCP server instructions)']
  ])

  // Rerunning writes nothing.
  const mtimes = [file, notes].map(f => fs.statSync(f).mtimeMs)
  const again = setupAgents({ ctx: u.ctx, ...quiet })
  assert.deepEqual([again.applied, again.plans.find(p => p.id === 'opencode').action], [[], 'none'])
  assert.deepEqual([file, notes].map(f => fs.statSync(f).mtimeMs), mtimes)

  // Uninstall: our entries and our file go, and opencode.json is byte-for-byte what it was.
  const out = []
  assert.deepEqual(removeAgents({ ctx: u.ctx, out: (l) => out.push(l) }), ['opencode'])
  assert.deepEqual(out, ["removed the autochat MCP server and autochat's etiquette from opencode (~/.config/opencode/opencode.json, ~/.config/opencode/autochat.md)"])
  assert.equal(read(file), before)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['AGENTS.md', 'opencode.json', 'opencode.json.autochat.bak', 'plugin'])
  assert.equal(read(path.join(dir, 'AGENTS.md')), 'my rules\n')
  assert.deepEqual(removeAgents({ ctx: u.ctx, ...quiet }), [], 'nothing left to remove')
})

test('opencode: a registration from before gets the etiquette; a stale etiquette or a moved install is updated in place; someone else\'s autochat.md and unparseable configs are left alone', () => {
  const u = user({ bins: ['opencode'] })
  const dir = u.file('.config', 'opencode')
  const file = path.join(dir, 'opencode.json')
  const notes = path.join(dir, 'autochat.md')
  fs.mkdirSync(dir, { recursive: true })
  const entry = { type: 'local', command: [u.node, u.autochat, 'mcp', '--harness', 'opencode'], enabled: true, timeout: 60000 }
  const status = (ctx = u.ctx) => describeAgentStatus(agentsStatus(ctx).find(h => h.id === 'opencode'))
  const plan = (ctx = u.ctx) => planAgents(ctx).find(p => p.id === 'opencode')

  // What setup --agents wrote before there was an etiquette file: doctor says what that means.
  const old = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { autochat: entry } }, null, 2) + '\n'
  fs.writeFileSync(file, old)
  assert.deepEqual(status()[1], [false, 'opencode: opencode doesn\'t show MCP server instructions to the model, and autochat\'s etiquette isn\'t listed under "instructions", so opencode agents get the tool descriptions alone (run autochat setup --agents)'])
  const up = plan()
  assert.deepEqual(describePlan(up, u.ctx), ['opencode update in ~/.config/opencode/opencode.json', '         + "instructions": ["~/.config/opencode/autochat.md"]', ETIQUETTE_LINE])
  up.apply()
  assert.equal(read(file), old.replace(/\n}\n$/, `,\n  "instructions": [\n    ${JSON.stringify(notes)}\n  ]\n}\n`))
  assert.equal(read(notes), etiquetteSource())
  assert.equal(status()[1][0], true)

  // An etiquette from another autochat version is rewritten; the config isn't touched.
  fs.writeFileSync(notes, etiquetteSource().replace('1. Start', '1. Begin'))
  assert.deepEqual(status()[1], [false, 'opencode: ~/.config/opencode/autochat.md holds an older etiquette (run autochat setup --agents)'])
  const config = read(file)
  const stale = plan()
  assert.deepEqual(describePlan(stale, u.ctx), ['opencode update in ~/.config/opencode/opencode.json', ETIQUETTE_LINE])
  stale.apply()
  assert.deepEqual([read(notes), read(file)], [etiquetteSource(), config])

  // A moved install: our server entry is replaced where it is, keeping what the user added to it.
  fs.writeFileSync(file, config.replace('"timeout": 60000', '"timeout": 60000,\n      "environment": { "AUTOCHAT_DEBUG": "1" }'))
  const moved = harnessContext({ env: u.env, node: u.node, bin: path.join(u.root, 'new', 'autochat.js'), run: u.ctx.run })
  const mv = plan(moved)
  assert.equal(mv.action, 'update')
  mv.apply()
  const cfg = JSON.parse(read(file))
  assert.deepEqual(cfg.mcp.autochat, { ...entry, command: [u.node, path.join(u.root, 'new', 'autochat.js'), 'mcp', '--harness', 'opencode'], environment: { AUTOCHAT_DEBUG: '1' } })
  assert.deepEqual(cfg.instructions, [notes], 'listed once')
  assert.equal(plan(moved).action, 'none')

  // Someone else's autochat.md is never overwritten, nor removed.
  fs.writeFileSync(notes, 'my own notes\n')
  const foreign = plan()
  assert.deepEqual([foreign.action, foreign.apply], ['manual', undefined])
  assert.match(describePlan(foreign, u.ctx)[0], /~\/\.config\/opencode\/autochat\.md isn't autochat's, so autochat won't overwrite it \(move it aside and rerun\)\. Add this yourself:$/)
  assert.equal(status()[1][0], false)
  removeAgents({ ctx: u.ctx, ...quiet })
  assert.equal(read(notes), 'my own notes\n')
  fs.rmSync(notes)

  // "instructions" that isn't a list isn't rewritten.
  fs.writeFileSync(file, '{"instructions": "AGENTS.md"}\n')
  assert.match(describePlan(plan(), u.ctx)[0], /"instructions" in ~\/\.config\/opencode\/opencode\.json isn't a list/)
  fs.rmSync(file)

  // Nor is JSON with comments: setup shows both entries to add by hand, then a rerun writes the
  // etiquette file they list, and doctor reads the file as opencode does.
  const jsonc = path.join(dir, 'opencode.jsonc')
  fs.writeFileSync(jsonc, '{\n  // mine\n  "model": "x",\n}\n')
  const manual = plan()
  assert.equal(manual.action, 'manual')
  const shown = describePlan(manual, u.ctx)
  assert.match(shown[0], /opencode\.jsonc isn't plain JSON \(comments\?\), so autochat won't rewrite it\. Add this yourself:$/)
  assert.deepEqual(JSON.parse(shown.slice(1, -1).join('\n')), { mcp: { autochat: entry }, instructions: [notes] })
  assert.equal(shown.at(-1), '         Then rerun autochat setup --agents, which writes ~/.config/opencode/autochat.md.')
  setupAgents({ ctx: u.ctx, ...quiet })
  assert.equal(fs.existsSync(notes), false)
  const pasted = `{\n  // mine\n  "model": "x",\n  "mcp": { "autochat": ${JSON.stringify(entry)} }, // added by hand\n  "instructions": [${JSON.stringify(notes)}],\n}\n`
  fs.writeFileSync(jsonc, pasted)
  assert.deepEqual(status()[1], [false, 'opencode: ~/.config/opencode/autochat.md is listed under "instructions", but missing (run autochat setup --agents)'])
  const rerun = plan()
  assert.deepEqual(describePlan(rerun, u.ctx), ['opencode update in ~/.config/opencode/opencode.jsonc', ETIQUETTE_LINE])
  rerun.apply()
  assert.deepEqual([read(notes), read(jsonc)], [etiquetteSource(), pasted])
  assert.deepEqual(status(), [[true, 'opencode: connected to the agent room (~/.config/opencode/opencode.jsonc)'], [true, 'opencode: the etiquette reaches the model from ~/.config/opencode/autochat.md, listed under "instructions" (opencode doesn\'t show MCP server instructions)']])
  const out = []
  removeAgents({ ctx: u.ctx, out: (l) => out.push(l) })
  assert.deepEqual(out, ["removed autochat's etiquette from opencode (~/.config/opencode/autochat.md); ~/.config/opencode/opencode.jsonc isn't plain JSON, so take autochat's entries out of it yourself"])
  assert.deepEqual([fs.existsSync(notes), read(jsonc)], [false, pasted])
  out.length = 0
  removeAgents({ ctx: u.ctx, out: (l) => out.push(l) })
  assert.deepEqual(out, ["opencode: ~/.config/opencode/opencode.jsonc isn't plain JSON, so take autochat's entries out of it yourself"])
})

test('opencode uninstall: an "mcp" or "instructions" the file had before stays, even empty; ones autochat made go', () => {
  const u = user({ bins: ['opencode'] })
  const file = u.file('.config', 'opencode', 'opencode.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const before = '{\n  "mcp": {},\n  "instructions": []\n}\n'
  fs.writeFileSync(file, before)
  setupAgents({ ctx: u.ctx, ...quiet })
  assert.deepEqual(Object.keys(JSON.parse(read(file)).mcp), ['autochat'])
  removeAgents({ ctx: u.ctx, ...quiet })
  assert.equal(read(file), before)

  // autochat made opencode.json, and the user added a model since: that stays, and uninstall takes
  // no backup, so the next round still knows the rest was autochat's.
  const v = user({ bins: ['opencode'] })
  const made = v.file('.config', 'opencode', 'opencode.json')
  setupAgents({ ctx: v.ctx, ...quiet })
  fs.writeFileSync(made, read(made).replace('"$schema": "https://opencode.ai/config.json",', '"$schema": "https://opencode.ai/config.json",\n  "model": "x",'))
  removeAgents({ ctx: v.ctx, ...quiet })
  const kept = '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "x"\n}\n'
  assert.equal(read(made), kept)
  assert.equal(fs.existsSync(made + '.autochat.bak'), false)
  setupAgents({ ctx: v.ctx, ...quiet })
  removeAgents({ ctx: v.ctx, ...quiet })
  assert.equal(read(made), kept)

  // A config that holds only autochat's entries is autochat's: setting it up again (a moved
  // install, or one from before the etiquette file) takes no backup, and uninstall still deletes it.
  const w = user({ bins: ['opencode'] })
  const own = w.file('.config', 'opencode', 'opencode.json')
  fs.mkdirSync(path.dirname(own), { recursive: true })
  fs.writeFileSync(own, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { autochat: { type: 'local', command: ['/old/node', '/old/autochat.js', 'mcp', '--harness', 'opencode'], enabled: true, timeout: 60000 } } }, null, 2) + '\n')
  assert.deepEqual(setupAgents({ ctx: w.ctx, ...quiet }).applied, ['opencode'])
  assert.equal(fs.existsSync(own + '.autochat.bak'), false, 'nothing of the user\'s to keep')
  removeAgents({ ctx: w.ctx, ...quiet })
  assert.deepEqual(fs.readdirSync(path.dirname(own)), [])

  // A backup that does hold only autochat's entries (an older autochat took it) counts as autochat's.
  fs.writeFileSync(own, '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "x"\n}\n')
  setupAgents({ ctx: w.ctx, ...quiet })
  fs.writeFileSync(own + '.autochat.bak', JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { autochat: {} }, instructions: [w.file('.config', 'opencode', 'autochat.md')] }))
  removeAgents({ ctx: w.ctx, ...quiet })
  assert.equal(read(own), '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "x"\n}\n')
})

test('Copilot CLI: its allowlist for server instructions is built in, so setup adds nothing and doctor says how to pass them on', () => {
  const u = user({ bins: ['copilot'] })
  const status = () => describeAgentStatus(agentsStatus(u.ctx).find(h => h.id === 'copilot'))
  assert.deepEqual(status(), [[null, 'copilot: installed, not connected to the agent room (autochat setup --agents)']])
  setupAgents({ ctx: u.ctx, ...quiet })
  const [connected, note] = status()
  assert.deepEqual(connected, [true, 'copilot: connected to the agent room (~/.copilot/mcp-config.json)'])
  assert.equal(note[0], null, "a note: autochat can't change it")
  assert.match(note[1], /^copilot: autochat's instructions reach the model only when Copilot CLI runs with --allow-all-mcp-server-instructions \(its allowlist is built in, and no setting adds to it\); without it, Copilot agents get the tool descriptions alone\. To always pass it: alias copilot='copilot --allow-all-mcp-server-instructions'$/)
  assert.deepEqual(fs.readdirSync(u.file('.copilot')), ['mcp-config.json'], 'nothing else to write')
  assert.deepEqual(describeAgentStatus({ id: 'opencode', installed: false, registered: false }), [[null, 'opencode: not installed']])
})

test('CLI: setup --agents --dry-run shows the opencode etiquette and writes nothing; uninstall says what it removed', () => {
  const u = user({ bins: ['opencode'] })
  const env = { ...process.env, ...u.env, AUTOCHAT_HOME: path.join(u.root, 'ac'), COPILOT_HOME: u.file('.copilot'), XDG_CONFIG_HOME: u.file('.config'), CODEX_HOME: u.file('.codex'), AUTOCHAT_APP_DIRS: path.join(u.root, 'no-apps') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const dry = cli('setup', '--agents', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /opencode add to ~\/\.config\/opencode\/opencode\.json\n.*\n {11}\+ "instructions": \["~\/\.config\/opencode\/autochat\.md"\]\n {11}\+ ~\/\.config\/opencode\/autochat\.md: the agent-room etiquette/)
  assert.equal(fs.existsSync(u.file('.config', 'opencode')), false)
  assert.match(cli('setup', '--agents').stdout, /✔ opencode connected/)
  assert.equal(read(u.file('.config', 'opencode', 'autochat.md')), etiquetteSource())
  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /removed the autochat MCP server and autochat's etiquette from opencode \(~\/\.config\/opencode\/opencode\.json, ~\/\.config\/opencode\/autochat\.md\)\n$/)
  assert.deepEqual(fs.readdirSync(u.file('.config', 'opencode')), [])
})

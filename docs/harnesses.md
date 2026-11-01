# Harness adapters

autochat follows coding agents ("harnesses": Copilot CLI, Claude Code, Codex, opencode, pi, Gemini
CLI, …) through one **adapter** per harness, in `src/harness/<id>.js`. An adapter owns everything
autochat knows about its harness: where it's installed, its hooks, how its hook payloads read, which
of its modes count as working on its own, an optional fallback watcher, terminal focus, and
registering `autochat mcp` for the [agent room](agents.md). The rest of autochat only ever sees
`SessionEvent`s.

```
harness ──hook──▶ autochat hook --harness <id> <event> ──▶ adapter.normalize() + autonomy()
                                                              │ SessionEvent, sent as a hook message
                                                              ▼
                     unix socket (or the spool while the core starts) ──▶ Controller
adapter.observe() ── fallback: sessions without hooks ─────────────────▶ controller.adopt(live, id)
adapter.follow(sid) ── the harness's own session log, for what no hook reports ─▲
```

The Controller keys sessions by `${harness}:${sid}` and puts you in the lounge while at least one of
them works **autonomously**: without you taking turns. See [the autonomy rule](#autonomy-and-autochat-config-trigger).

## The adapter

`src/harness/index.js` lists the adapters (`ADAPTERS`, in the order setup shows them). Each module
exports one object:

| Member | Required | What it does |
| --- | --- | --- |
| `id`, `name` | yes | `claude`, `Claude Code`. The id is the `--harness` value and the session key prefix. |
| `modes` | yes | Every mode name `autochat config trigger <id>` accepts, including `headless` if the harness has non-interactive runs. |
| `trigger` | yes | The modes that count as autonomous by default. |
| `detect(ctx)` | yes | `{installed, binary, paths}`: is it installed (binary on the path, or its config dir exists), and the config files the adapter touches. Never spawns: [`versionOf(ctx, binary)`](../src/harness/util.js) is there when a version is needed. |
| `normalize(event, payload, env)` | yes | One hook call → a [`SessionEvent`](#sessionevent), or `null` when it names no session. Fills in `mode` and `headless`; leaves `autonomy` to `autonomy()`. Must never throw on odd input. |
| `autonomy(payload, session)` | yes | `'autonomous' \| 'interactive' \| 'unknown'`. `session` is the SessionEvent so far plus `env` and `trigger` (this harness's trigger list, or `'never'`). Most adapters use `defaultAutonomy`: `byTrigger(modesOf(session), session.trigger)`. |
| `planHooks(ctx)`, `unplanHooks(ctx)`, `hookStatus(ctx)` | for hooks | Install, remove, check the hooks. See [Hooks](#hooks). |
| `observe(ctx, emit)` | no | Fallback watcher for sessions that never call the hooks (started before setup, or no hooks at all). Calls `emit(live)` with **every** live session it sees, each time (`[{sid, running, mode, cwd, lastStart, scannedAt}]`), so the Controller can release the ones that are gone. Returns a stop function. `ctx` is `{idleMs, trigger(id), intervalMs}`. |
| `follow(sid)` | no | The harness's own session log, for what no hook reports. An EventEmitter like Copilot's `SessionLog`: `start({since})`, `poll()`, `stop()`, and events `mode`, `task-complete`, `abort`, `shutdown`, `activity`. |
| `continues(session)` | no | After `idle`, true keeps the session in the room a while longer (Copilot: an active autopilot objective). |
| `focus(origin)` | no | Put focus back on the agent's terminal. Default: `focusOrigin` (tmux pane, else the terminal app). |
| `mcp` | yes | `where`, `status`, `plan`, `unplan`: registering `autochat mcp` (`autochat setup --agents`). `jsonServer()` in `mcp-config.js` covers harnesses with a JSON config file. |

`ctx` is `harnessContext()` from `src/harness/util.js`: `env`, `home`, `node`, `bin` (the absolute
paths hooks run), `copilotHome`, `claudeHome` (`$CLAUDE_CONFIG_DIR`), `configHome`
(`$XDG_CONFIG_HOME`), `codexHome`, `which(name)` (honours `AUTOCHAT_HARNESS_PATH`), and `run(cmd,
args)`. Tests pass their own.

## SessionEvent

```js
{ harness, sid, kind, autonomy, mode, headless, cwd, repo, branch, origin, request, summary, reason, files }
```

| Field | Meaning |
| --- | --- |
| `harness`, `sid` | adapter id and the harness's session id (`[A-Za-z0-9_-]{1,128}`) |
| `kind` | see below |
| `autonomy` | `autonomous`, `interactive` or `unknown` |
| `mode` | the harness's own name for its current mode (`autopilot`, `auto`, `acceptEdits`, …), or null |
| `headless` | true for a non-interactive run (`claude -p`, `codex exec`, …) |
| `cwd`, `repo`, `branch` | where it works (repo and branch are optional) |
| `origin` | `originFrom(env)`: `{tmux, tmuxPane, termProgram, bundleId}` from the hook's environment, for focus |
| `request` | `{title, message}` for `kind: 'request'` |
| `summary` | what it did, for `complete` (and optionally `idle`: its last message) |
| `reason` | why it ended, for `end` |
| `files` | paths a tool call edits, when the payload says |

| `kind` | Meaning | What the Controller does |
| --- | --- | --- |
| `start` | the session started; nothing to do yet | nothing (it doesn't start tracking) |
| `activity` | it's working: a prompt went in, a tool runs | tracks it while autonomous; `running` |
| `request` | it's blocked on you: an approval or an answer | `needed`: the request card, `!` in the room |
| `waiting` | it finished its turn and waits at its prompt | done now (`idle`) |
| `idle` | its turn ended; it may carry on by itself | done after `idleMs` without activity, unless `continues()` |
| `complete` | it says it's done | done, with `summary` |
| `end` | the session or its process ended | done |
| `notice` | a hook fired and nothing changed | refreshes `cwd` and `origin` |

When a tracked session's `activity`, `request`, `idle` or `waiting` says `autonomy: 'interactive'`
(you switched modes), it's done right away (reason `mode`). `unknown` neither starts nor stops
anything.

## Autonomy and `autochat config trigger`

You're in the lounge only while an agent works **without you taking turns**. Chatting with an agent
never counts, however long a turn runs. Approval-bypass modes (`yolo`, `bypassPermissions`,
`acceptEdits`) are about permissions, not about you being away, so they don't count by default.
**Join now** (the menu bar, or `autochat ui --now`) is the manual switch.

The rule (`byTrigger` in `src/harness/event.js`): a session counts as autonomous when one of its
modes, `mode` plus `headless` for non-interactive runs, is in its harness's trigger list. It's
interactive when its mode is known and isn't, and unknown when nothing says.

| Harness | Counts by default |
| --- | --- |
| Copilot CLI | `autopilot` |
| Claude Code | `auto`, `headless` (`claude -p`) |
| Gemini CLI, Codex, opencode, pi | `headless` (`gemini -p`, `codex exec`, `opencode run`, `pi -p`) |

```sh
autochat config trigger                         # every harness's list
autochat config trigger copilot                 # ["autopilot"]
autochat config trigger copilot autopilot,plan  # plan mode counts too
autochat config trigger claude never            # Claude Code never puts you in the lounge
autochat config trigger claude default          # back to the default
```

Overrides live in `config.json` as `trigger: {<id>: [modes] | "never"}`. Hooks read the config on
every call, and so does the core when it decides from a mode alone (session logs, the fallback
observers, hook messages from older versions).

## Hooks

**The hook command** is `'<node>' '<autochat.js>' hook --harness <id> <Event> || true`, with the
absolute paths of node and `bin/autochat.js`, so nvm and `PATH` don't matter. It always exits 0
and prints nothing: some harnesses block a tool call on a failing hook, or read a hook's stdout
as instructions. `autochat hook <event>` without `--harness` means Copilot: that's what every
install from before adapters runs, and what Copilot's hooks still say.

**Installing** (`planHooks(ctx)`) returns a plan, `{id, action, file, entries, apply}` with action
`add`, `update`, `none` or `manual`. Build it with `planned(compute, ctx)` from `util.js`, so
`apply()` recomputes it from the file as it is when applied (setup may show a plan, then wait on
a prompt). Rules:

- **Merge, never replace.** Users have their own hooks on the same events. Append ours, keep every
  other entry and the file's formatting (`readJson`/`writeJson` keep the indentation and the final
  newline), and write with `writeFileSafely` (atomic, a one-time `<file>.autochat.bak`, symlinks
  written through).
- **Reruns are no-ops**, and a moved install updates our entries in place.
- **Uninstall removes only ours**, recognised by the command (`autochat.js' hook --harness <id>`),
  and leaves the file byte-for-byte as it was before we added them.
- A file autochat can't parse (JSON with comments) gets `action: 'manual'` and the snippet to add.
- Test it: an existing config with other hooks must stay byte-for-byte unchanged apart from our
  entries, through install, rerun and uninstall.

**Commands:**

- `autochat setup` installs the hooks in `DEFAULT_HOOKS` (Copilot), then offers every other
  installed harness that has hooks, one prompt each (in a terminal; otherwise it prints the command).
- `autochat setup --harness claude,codex [--dry-run]` installs exactly those (`all`: every adapter
  with hooks), showing each change first.
- `autochat uninstall` runs every adapter's `unplanHooks()`, then removes the MCP registrations.
- `autochat doctor` shows `hookStatus()` per installed harness, and the trigger lists in effect.

## The hook message

On the socket (and in the spool while a core starts) a SessionEvent travels as a one-shot `hook`
message (`hookMessage()`), in the shape every daemon has read, plus the new fields:

```json
{"type":"hook","event":"PreToolUse","sessionId":"5d0c…","harness":"claude","autonomy":"autonomous",
 "mode":"auto","cwd":"/Users/me/code/x","origin":{"tmuxPane":"%3"},"kind":"activity","ts":1730400000000}
```

`sessionId` is the session id, and `idle` travels as `stop`. Messages without `harness` (or
`autonomy`) are from before adapters: they're Copilot's, and the core decides autonomy from their
`mode`. Lounge snapshots list each session's `harness` (see [protocol.md](protocol.md#state)).

## Adding an adapter

1. **Verify the harness first.** Hook names, payload fields and mode names change between
   versions: check them against the installed version (load hooks from a temp settings file;
   never touch the user's real config), and record payloads as fixtures under
   `test/fixtures/<id>/`, with paths scrubbed.
2. Write `src/harness/<id>.js` and add it to `ADAPTERS` in `src/harness/index.js`.
3. `normalize()`: map each hook event to a kind (table above). Requests (permission prompts,
   questions to the user) are `request`; tool calls are `activity`; the end of a turn is `idle`.
4. Autonomy: set `mode` from the payload and `headless` from whatever reliably marks a
   non-interactive run (an env var the harness sets for its hooks, a payload field). If nothing
   does, leave it unknown. Fill in `modes` and `trigger`.
5. Hooks: `planHooks`, `unplanHooks`, `hookStatus`, following the rules above.
6. Optional: `observe()` for sessions without hooks, `follow()`, `continues()`, `focus()`.
7. Tests in temp homes only (`HOME`, `AUTOCHAT_HOME`, `COPILOT_HOME`, `CLAUDE_CONFIG_DIR`, …): the
   fixtures through `normalize()`, the autonomy rule, and install/rerun/uninstall around a config
   that already has other hooks.
8. Document it here and in the README.

## Harnesses

| Harness | Hooks | Autonomy signal | Fallback observer | MCP |
| --- | --- | --- | --- | --- |
| Copilot CLI | `$COPILOT_HOME/hooks/autochat.json` (a file of our own) | `autopilot`, from `session-state/<id>/events.jsonl` | the session-state scan | `mcp-config.json` |
| Claude Code | not yet | | | `claude mcp add` |
| Gemini CLI | not yet | | | `~/.gemini/settings.json` |
| opencode | not yet | | | `opencode.json` |
| Codex | not yet | | | `config.toml` |
| pi | `$PI_CODING_AGENT_DIR/extensions/autochat.ts`, an extension of our own ([below](#pi)) | `headless`: print and json mode (`ctx.hasUI` is false) | none: pi reports nothing without the extension | the same extension |

## pi

`src/harness/pi.js`, verified against pi 0.74.0 (`@earendil-works/pi-coding-agent`). pi has no hooks
and no MCP: it has TypeScript extensions, which it loads with jiti from
`$PI_CODING_AGENT_DIR/extensions/` (`~/.pi/agent/extensions/`), and `pi -e <file>` for one run. So
autochat ships one, `src/harness/pi-extension.js`, and setup writes a small stub that loads it,
`extensions/autochat.ts`, a file of autochat's own:

```ts
const AUTOCHAT = {"node":"/…/node","bin":"/…/bin/autochat.js","module":"/…/src/harness/pi-extension.js","lounge":true,"room":true}
export default async function autochat (pi: any) { … await import(AUTOCHAT.module) … register(pi, AUTOCHAT) }
```

The stub has two switches. `lounge` (`autochat setup --harness pi`, which doctor and uninstall
treat as pi's hooks) forwards pi's lifecycle events; `room` (`autochat setup --agents`) registers the
agent-room tools ([agents.md](agents.md#pi)). Each install turns its switch on and points the stub at
this install; uninstall turns its switch off, and the file goes when both are off. Setup never
touches any other extension, pi's `settings.json`, or an `autochat.ts` that isn't autochat's (it
prints the stub instead). pi loads extensions when a session starts: running sessions pick it up on
`/reload`. Runs started with `--no-extensions` don't load it.

**Events.** The extension sends each of these to `autochat hook --harness pi <event>`, with a JSON
payload on stdin: `hook_event_name`, `session_id` (pi's, a UUID), `cwd`, `mode`, `has_ui`, and per
event `reason`, `tool_name`, `files` or `last_assistant_message`. One hook runs at a time, in order;
activity events queued behind a running hook collapse into the newest. pi never waits for a hook,
except when it shuts a session down: then it waits up to 3 s for the rest.

| pi event | Kind | Notes |
| --- | --- | --- |
| `session_start` | `start` | `reason`: `startup`, `new`, `resume`, `fork`, `reload` |
| `agent_start` | `activity` | once per prompt |
| `tool_call` | `activity` | before each tool runs; `files` for `edit` and `write` |
| `agent_end` | `waiting` in the TUI, `idle` otherwise | the last assistant text becomes the summary |
| `session_shutdown` | `end`; `notice` for `reload` | `reason`: `quit`, `new`, `resume`, `fork`, `reload` |

pi has no permission prompts and no tool that asks the user, so it never reports a `request`.

**Autonomy.** Extensions only see `ctx.hasUI`: false in print mode (`pi -p`, or a prompt on piped
stdin) and json mode (`--mode json`), true in the TUI and in rpc mode (`--mode rpc`). The extension
reports pi's own name for the mode, `print`, `json`, `interactive` or `rpc` (`--mode` tells print
from json and rpc from the TUI), and print and json runs are `headless`. By default only `headless`
counts. An rpc client may or may not have someone at it: `autochat config trigger pi rpc,headless`
counts those too.

**Verified** with `pi -e <stub>` in a throwaway `HOME` and `PI_CODING_AGENT_DIR`, against a local
stand-in for an OpenAI-compatible API (a custom provider in the throwaway `models.json`) and an
`autochat daemon` with its own `AUTOCHAT_HOME`: print, json and rpc runs, the TUI driven through a
pseudo-terminal, `/new` and `/reload`. The payloads are in `test/fixtures/pi/`.

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
process scan (ps) ── which agents run at all: a hint, never a session ──▶ snapshots (detected), doctor
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
| `planHooks(ctx)`, `unplanHooks(ctx)`, `hookStatus(ctx)` | for hooks | Install, remove, check the hooks. See [Hooks](#hooks). `hookStatus` returns `{installed, file}`, plus `partial`, `valid` (the node and autochat.js it runs exist) and `disabled` when it can tell. |
| `hooksNote` | no | What setup says after installing: when the harness starts running the new hooks. |
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
{ harness, sid, kind, autonomy, mode, headless, cwd, repo, branch, origin, request, summary, reason, stopped, files, at, pid }
```

| Field | Meaning |
| --- | --- |
| `harness`, `sid` | adapter id and the harness's session id (`[A-Za-z0-9_-]{1,128}`) |
| `kind` | see below |
| `autonomy` | `autonomous`, `interactive` or `unknown` |
| `mode` | the harness's own name for its current mode (`autopilot`, `auto`, `acceptEdits`, …), or null |
| `headless` | true for a non-interactive run (`claude -p`, `codex exec`, …), false when someone's there, null when the harness doesn't say |
| `cwd`, `repo`, `branch` | where it works (repo and branch are optional) |
| `origin` | `originFrom(env)`: `{tmux, tmuxPane, termProgram, bundleId}` from the hook's environment, for focus |
| `request` | `{title, message}` for `kind: 'request'` |
| `summary` | what it did, for `complete` (and optionally `idle` and `end`: its last message); what went wrong, for `failed` |
| `reason` | why it ended, for `end`; what kind of error, for `failed` (say `rate_limit`) |
| `stopped` | for `failed`: true when the error ended its turn |
| `files` | paths a tool call edits, when the payload says |
| `at` | when it happened (ms), from harnesses whose events can reach the core out of order (opencode's plugin runs a process per event). The Controller drops one older than the last it saw for that session, finished or not |
| `pid` | the harness process the session lives in, from harnesses that can die without a word (opencode on Ctrl+C). The Controller ends a tracked session (reason `end`) once that process is gone |

| `kind` | Meaning | What the Controller does |
| --- | --- | --- |
| `start` | the session started; nothing to do yet | nothing (it doesn't start tracking) |
| `activity` | it's working: a prompt went in, a tool runs | tracks it while autonomous; `running`. Its attention item is handled |
| `request` | it's blocked on you: an approval or an answer | `needed`: the request card, `!` in the room, a `blocked` attention item |
| `waiting` | it finished its turn and waits at its prompt | done now (`idle`); a `finished` item |
| `idle` | its turn ended; it may carry on by itself | done after `idleMs` without activity, unless `continues()`; then a `finished` item |
| `complete` | it says it's done | done, with `summary`; a `finished` item |
| `failed` | it hit an error: `stopped` when it ended its turn (Claude's `StopFailure`), otherwise it carries on (a refused tool call, `PermissionDenied`) | a `failed` item. `stopped`: done (reason `failed`). Otherwise still `running`, and its activity doesn't clear the item |
| `end` | the session or its process ended | done, with `summary` if it has one; a `finished` item |
| `notice` | a hook fired and nothing changed | refreshes `cwd` and `origin` |

When a tracked session's `activity`, `request`, `idle`, `waiting` or `failed` says
`autonomy: 'interactive'` (you switched modes), it's done right away (reason `mode`), and its
attention item goes: you took over. `unknown` neither starts nor stops anything. The attention
items are the queue in lounge snapshots ([protocol.md](protocol.md#attention-queue)); Copilot's
abort (from its session log) is a `failed` one too.

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
- **Plugins.** A harness that runs in-process plugins instead of hook commands (opencode) gets a
  plugin of autochat's own that hands each event to the same hook command, so `normalize()` and
  the trigger rule still run in `autochat hook`. A file of our own: setup writes it whole when it
  changed, uninstall deletes it, and one by that name that isn't ours is never replaced. Its
  events are separate processes that can arrive out of order, so it stamps them with `at`.
- Test it: an existing config with other hooks must stay byte-for-byte unchanged apart from our
  entries, through install, rerun and uninstall.

**Commands:**

- `autochat setup` installs the hooks in `DEFAULT_HOOKS` (Copilot), then offers every other
  installed harness that has hooks, one prompt each (in a terminal; otherwise it prints the command).
- `autochat setup --harness claude,codex [--dry-run]` installs exactly those (`all`: every adapter
  with hooks), showing each change first.
- `autochat uninstall` runs every adapter's `unplanHooks()`, then removes the MCP registrations.
- `autochat doctor` shows `hookStatus()` per installed harness, and the trigger lists in effect.
  `hookStatus()` may add `disabledBy` (where the harness's hooks are switched off) and `note`
  (something doctor can't check, such as Codex's hook trust).

## The hook message

On the socket (and in the spool while a core starts) a SessionEvent travels as a one-shot `hook`
message (`hookMessage()`), in the shape every daemon has read, plus the new fields:

```json
{"type":"hook","event":"PreToolUse","sessionId":"5d0c…","harness":"claude","autonomy":"autonomous",
 "mode":"auto","cwd":"/Users/me/code/x","origin":{"tmuxPane":"%3"},"kind":"activity","ts":1730400000000}
```

`sessionId` is the session id, and `idle` travels as `stop`. `at`, when there is one, is when the
event happened (`ts` is when it was sent). Messages without `harness` (or
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
5. Hooks: `planHooks`, `unplanHooks`, `hookStatus`, following the rules above (or a plugin of
   our own that forwards to `autochat hook`, like opencode's).
6. Optional: `observe()` for sessions without hooks, `follow()`, `continues()`, `focus()`.
7. Tests in temp homes only (`HOME`, `AUTOCHAT_HOME`, `COPILOT_HOME`, `CLAUDE_CONFIG_DIR`, …): the
   fixtures through `normalize()`, the autonomy rule, and install/rerun/uninstall around a config
   that already has other hooks.
8. Document it here and in the README.

## Harnesses

| Harness | Hooks | Autonomy signal | Fallback observer | MCP |
| --- | --- | --- | --- | --- |
| Copilot CLI | `$COPILOT_HOME/hooks/autochat.json` (a file of our own) | `autopilot`, from `session-state/<id>/events.jsonl` | the session-state scan | `mcp-config.json` |
| Claude Code | `$CLAUDE_CONFIG_DIR/settings.json`, merged ([below](#claude-code)) | `auto` (`permission_mode`); headless: `CLAUDE_CODE_SESSION_ATTENDED=0` | none needed: running sessions pick up new hooks | `claude mcp add` |
| Gemini CLI | not yet | | | `~/.gemini/settings.json` |
| opencode | a plugin of our own, `$XDG_CONFIG_HOME/opencode/plugin/autochat.js` ([below](#opencode)) | headless: `opencode run` (the plugin's `process.argv`), or a server's session that denies the question tool (`run --attach`); never the TUI; the agent is the mode | none yet: opencode processes started before setup don't have the plugin | `opencode.json` |
| Codex | `$CODEX_HOME/hooks.json`, merged ([below](#codex)); Codex runs them once you trust them | `headless`: `codex exec`, from the session's rollout; `bypassPermissions` for approval policy `never` | none yet | `config.toml` |
| pi | `$PI_CODING_AGENT_DIR/extensions/autochat.ts`, an extension of our own ([below](#pi)) | `headless`: print and json mode (`ctx.hasUI` is false) | none: pi reports nothing without the extension | the same extension |

## Claude Code

`src/harness/claude.js`, verified against Claude Code 2.1.273. The fixtures in
`test/fixtures/claude/` are payloads recorded from the real binary, with the hooks loaded from a
temp file (`--settings <file> --setting-sources project,local`), in a throwaway `HOME` and
`CLAUDE_CONFIG_DIR`, against a local stand-in for the Messages API: `claude -p` in several
permission modes, a session in a terminal (driven through a pseudo-terminal), and `claude --bg`.

**Hooks** go in the user settings, `$CLAUDE_CONFIG_DIR/settings.json` (`~/.claude/settings.json`):
one matcher group of ours per event, appended after the user's own, each running
`… hook --harness claude <Event> || true` with a 10 s timeout. `Notification` only matches
`permission_prompt|idle_prompt|elicitation_dialog`. Claude Code picks up changes to that file in
running sessions too, so there's no fallback observer. Hooks don't run under `--bare`, or with
`disableAllHooks` (doctor says so).

| Event | Kind | Notes |
| --- | --- | --- |
| `SessionStart` | `start` | `source`, and `model` in a terminal; no `permission_mode` |
| `UserPromptSubmit` | `activity` | |
| `PreToolUse` | `activity`; `request` for `AskUserQuestion` | `files` for Write, Edit, MultiEdit, NotebookEdit |
| `PostToolUse` | `activity` | `files` as above |
| `PermissionRequest` | `request` | fires whenever a dialog would ask (`AskUserQuestion` too, and in `-p`) |
| `Notification` | `request` (`permission_prompt`, `elicitation_dialog`), `waiting` (`idle_prompt`) | no `permission_mode`. `permission_prompt` comes about 6 s after the PermissionRequest with only "Claude needs your permission", so the request keeps the PermissionRequest's text. `idle_prompt` comes after a minute at the prompt |
| `Stop` | `idle` | `last_assistant_message` becomes the summary |
| `SessionEnd` | `end` | `reason`: `prompt_input_exit` (/exit), `other` (end of `-p`), … |

**Autonomy.** `permission_mode` is in the payloads of `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest` and `Stop`. Manual mode arrives as `default`, which autochat
calls `manual`, as `--permission-mode` does; the others are `acceptEdits`, `plan`, `auto`,
`dontAsk` and `bypassPermissions`. For headless, Claude Code sets `CLAUDE_CODE_SESSION_ATTENDED` in
its hooks' environment: `0` for `claude -p` and `claude --bg` sessions, `1` in a terminal. A
`--bg` session you attach to still says `0`. `CLAUDE_CODE_ENTRYPOINT` (`sdk-cli` for `-p`, `cli`
otherwise, `--bg` included) is the fallback for versions without it. When neither is there, a
mode that doesn't count by itself leaves the session `unknown`. By default `auto` and `headless`
count.

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

## Codex

`src/harness/codex.js`. Codex isn't installed where this adapter was written, so it follows
Codex's hooks documentation (developers.openai.com/codex/hooks) and, where that's silent, the
source and generated hook schemas of Codex `rust-v0.166.0` (`codex-rs/hooks`,
`codex-rs/core/src/hook_runtime.rs`). The fixtures in `test/fixtures/codex/` are built from those
documented payloads, not recorded: [what isn't verified](#what-isnt-verified-live).

**Hooks** go in `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json`): one matcher group of ours per
event, appended after the user's own, each running `… hook --harness codex <Event> || true`,
synchronously (`async` hooks may finish out of order, and Codex cancels them when a session ends).
No matcher, so every tool and every start source. Codex rejects top-level keys other than
`description` and `hooks` in that file, so that's all autochat writes. Installing rewrites the file
in its own indentation (like every JSON config autochat edits); uninstall puts back the exact bytes
it found there (from the one-time backup) when your own hooks haven't changed since, and otherwise
removes only ours. A file of its own goes away again. autochat never writes hooks into
`config.toml` (an inline `[hooks]` there and a `hooks.json` both load, with a startup warning).

**Trust.** Codex runs a hook only after you've reviewed and trusted its exact definition: open
`/hooks` in Codex after `autochat setup --harness codex` (setup and doctor say so; autochat can't
see Codex's trust records). Codex records trust by file, event and position, so reruns change
nothing and keep it, and a moved install updates our entries where they are, but needs trusting
again. `codex exec --dangerously-bypass-hook-trust` runs them untrusted, for that run.
`hooks = false` under `[features]` in `config.toml` turns every hook off (doctor says so).

| Event | Kind | Notes |
| --- | --- | --- |
| `SessionStart` | `start` | `source`: `startup`, `resume`, `clear`, `compact`, `fork` |
| `UserPromptSubmit` | `activity` | |
| `PreToolUse` | `activity`; `request` for `request_user_input` | `files` from `apply_patch` (the patch's `*** Add/Update/Delete File:` and `Move to:` lines) |
| `PermissionRequest` | `request` | the command (or the patch's files) and Codex's `description` |
| `PostToolUse` | `activity` | after an approved tool runs, this resolves the request; `files` as above |
| `Stop` | `idle` | `last_assistant_message` becomes the summary |
| `Interrupt` | `waiting` | you stopped the turn, so you're at its prompt; 3 s timeout, its maximum |
| `SessionEnd` | `end` | `reason` is `other`; no `permission_mode`; 3 s timeout |

**Autonomy.** `permission_mode` is in every payload but `SessionEnd`, and Codex computes it from the
approval policy alone: `bypassPermissions` for `never` (`-a never`,
`--dangerously-bypass-approvals-and-sandbox`, and `codex exec` by default), `default` for every
policy that asks. That's an approval-bypass mode, not "nobody's there", so it doesn't count by
default (`autochat config trigger codex bypassPermissions,headless` makes it). Nothing in a payload
says `codex exec`; its session's rollout (`transcript_path`) does: the first line is the
`session_meta`, with `source: "exec"` (before `source`, `originator: "codex_exec"`). `cli`,
`vscode` and `mcp` sessions aren't headless; a subagent's payload (`agent_id`, the parent's
`session_id`) points at the subagent's own rollout, which can't say, so it's `unknown`, and so is a
run without a rollout (`--ephemeral`): neither starts nor ends anything. By default `headless`
counts.

### What isn't verified live

None of this ran against a real Codex. From the documentation: the location and shape of
`hooks.json`, the event list and payload fields (checked against the generated schemas), the
trust flow, `SessionEnd`'s and `Interrupt`'s timeouts, that an exit 0 with nothing on stdout is a
success (`Stop` and `Interrupt` reject plain text), and that hooks run through your login shell
(`$SHELL -lc`) in the session's directory. From the source, not the documentation:
`permission_mode` as above; that the rollout exists, with its `session_meta`, before the first
hook runs; the rollout line format and the `source` values; `request_user_input` and its input
(`questions` with `options`); that subagent hooks carry `agent_id` with the parent's session id;
and how trust is keyed. Not checked at all: how long a login shell plus node takes per tool call on
your machine, and whether Codex shows anything while our hooks run. There's no fallback observer
for Codex yet: rollouts under `~/.codex/sessions` say what a session did, but not whether its
process is still alive.

## Process scan (detection only)

`src/harness/procscan.js` (#38). Hooks only reach autochat from agents that have them: sessions
started before `autochat setup`, harnesses whose hooks you haven't installed, and harnesses with no
adapter hooks yet stay silent. To explain that, `autochat daemon` scans the process table every
15 s (`ps -A -o pid,ppid,uid,lstart,command`) for the coding agents of your OS user, and reads the
working directory of each new one (`lsof` on macOS, `/proc` on Linux). The result is `detected`
in the lounge snapshot and the `status` reply ([protocol.md](protocol.md#detected)), and
`autochat doctor` scans once itself:

```
… 3 coding agents running: claude, copilot, gemini
✘ claude (pid 4200) in ~/code/y has no autochat hooks, so it can't open autochat (autochat setup --harness claude)
… gemini (pid 5100) in ~/code/z: autochat can't follow gemini yet
```

**It's detection only.** It can't use an adapter's `observe()`: whatever `observe()` reports goes
to `controller.adopt()`, and adopted sessions count as running. A process says nothing about
whether its agent works on its own or with you, so the scan never tracks a session and never puts
you in the lounge, and it never signals a process (not even signal 0 to check it's alive).

**What counts as an agent:**

- a harness binary, by its exact name (`copilot`, `claude`, `codex`, `gemini`, `opencode`, `pi`), or
  a script that node or bun runs from the harness's package (`@github/copilot`,
  `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, `opencode-ai`,
  `pi-coding-agent`), or Claude Code's native binary, named after its version under
  `…/claude/versions/`;
- only the outermost process of each: a wrapper and the binary it starts (Codex, Copilot CLI) or a
  CLI that relaunches itself (Gemini CLI) are one agent;
- not the desktop apps (`Claude`, `Copilot`: names match exactly), not a harness binary running a
  script (Copilot's extension workers), not `--version`, `--help`, `login`, `update` and the like,
  and not a harness serving others (`claude mcp serve`, `codex mcp-server`, `codex app-server`,
  `opencode serve`);
- your processes only, at most 64. Binaries under paths with spaces in them (inside an app bundle)
  aren't matched.

Each agent's `hooks` says whether autochat hears from it: `installed` when its harness's
`hookStatus()` says so, `missing` when the harness has hooks that aren't installed,
`unsupported` for a harness without them, and for Copilot CLI, `stale` when the process started
before its hooks were installed (it loads them only at start).

## opencode

`src/harness/opencode.js`, verified against opencode 1.2.6. The fixtures in
`test/fixtures/opencode/` are every call the real binary made into a plugin, recorded by a capture
plugin in a throwaway project's `.opencode/plugin/`, in a throwaway `HOME` (so opencode's own XDG
config, data and cache dirs too), against a local stand-in for an OpenAI-compatible API:
`opencode run` in several scenarios, `opencode run --attach` to an `opencode serve`, and the TUI
driven through a pseudo-terminal.

**The plugin.** opencode loads every `{plugin,plugins}/*.{js,ts}` in its config dirs at startup and
calls each export with `{client, project, worktree, directory, serverUrl, $}`.
`autochat setup --harness opencode` writes `plugin/autochat.js` (`plugins/autochat.js` when that's
the directory you have) in `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode`), made from
`src/harness/opencode-plugin.js` with the absolute node and `bin/autochat.js` filled in. New
opencode processes load it; running ones (a TUI, `opencode serve`) don't until they restart. It
forwards these to `autochat hook --harness opencode <event>`, each in a detached process (so the
last ones outlive `opencode run`), never waiting for it and never throwing:

| Event | Kind | Notes |
| --- | --- | --- |
| `session.created` | `start` | carries the session's `permission` rules |
| `chat.message` (a hook) | `activity` | a prompt went in; its agent is the mode |
| `tool.execute.before` (a hook) | `activity` | `files` for edit, write, multiedit |
| `permission.asked` | `request` | the permission and its patterns: `bash: touch x` |
| `question.asked` | `request` | the questions and their options |
| `permission.replied`, `question.replied`, `question.rejected` | `activity` | answered |
| `session.idle` | `idle` | the last text it wrote is the summary |
| `server.instance.disposed` | `end` (`exit`) | opencode is done with the directory: `run` finished, or the TUI quit. One per session it forwarded, with its summary |

Subagents work in child sessions (`parentID`) with their own prompts, tools and idle: the plugin
leaves those out, and passes their permission requests and questions on as their root session's.
It doesn't forward `message.updated` (several per message; it keeps the agent and the last text
from them), `session.status`, `session.error` (an idle follows), `tool.execute.after`, or the
`permission.ask` hook, which 1.2.6 doesn't call.

**Order.** Each event is its own `autochat hook` process, so events milliseconds apart (a tool call
and the question it asks; `run` rejecting a permission 4 ms after it's asked; idle, then the end)
can reach the core in either order. The plugin stamps every event with `at`, strictly increasing,
and the Controller drops one older than the last it saw for that session, finished or not.

**Ctrl+C.** opencode has no signal handlers: Ctrl+C (or a closed terminal) kills it on the spot,
with no `server.instance.disposed`. So every event says which process it's from (`pid`), and the
Controller ends the session once that process is gone (within 5 s).

**Autonomy.** The plugin passes its `process.argv` along: `opencode run` is
`[bun, /$bunfs/root/src/index.js, run, …]` (whether it starts a session or continues one with
`--continue` or `--session`), and the TUI runs plugins in its worker,
`[bun, /$bunfs/root/src/cli/cmd/tui/worker.js]`. `run` is headless; the TUI, and an editor over
`opencode acp`, never are. A server (`opencode serve`, `web`) runs sessions for whoever connects:
there, the session's own rules decide. `opencode run` creates its session denying the `question`,
`plan_enter` and `plan_exit` permissions (`opencode github` denies `question`), and
`session.created` and `session.updated` carry those rules, so `run --attach` counts too (no
`server.instance.disposed` follows on a server: it's done after `idleMs`). A session keeps those
rules for good, which is why the TUI going on with a session `run` started still counts as
attended; a server can't tell, so a run session continued in the web UI or `opencode attach` would
count. The mode is the agent (`build`, `plan`, or one of your own), from `chat.message`. By default
only `headless` counts: `autochat config trigger opencode build,headless` would count the TUI's
build agent too.

`run` rejects its own session's permission requests, within milliseconds, but a subagent's it
leaves waiting, and it never answers a question: either hangs `opencode run`, which shows as a
request until you stop it (Ctrl+C, see above).

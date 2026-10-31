# lolchat local protocol (v1)

How GUI clients (the macOS menu bar app) talk to the lolchat core. The core is
`lolchat daemon`: a headless process that runs the same Controller as the terminal UI
(rooms, P2P, Copilot session tracking). Clients render state and send commands; they
never talk to peers directly.

```
copilot CLI ──hooks──▶ lolchat hook ──unix socket──▶ lolchat daemon ◀──▶ Hyperswarm P2P
                                                       ▲
                               subscribe / state / cmd │
                                                  LolChat.app
```

## The daemon process

```sh
lolchat daemon            # or: node <install>/bin/lolchat.js daemon
```

- Headless: no TTY needed, nothing on stdout. One status line per lifecycle event on stderr.
- Never exits on its own. When autopilot ends it shows the banner, then returns to `lounge`.
- `SIGTERM`, `SIGINT` (and `SIGHUP`) leave the room cleanly, stop tailing session logs,
  close all subscriber connections, remove the socket, and exit `0` (forced after 5 s).
- Single instance. If the socket is already owned by a live lolchat process, the daemon
  prints `lolchat: already running in …` and exits with status **3**. Ping the socket to
  find out whether it's another daemon (`daemon: true`) or a terminal UI.
- While a daemon runs, `lolchat` / `lolchat ui` print `lolchat is running in the menu bar app
  (lolchat daemon, pid N).` and exit `0` instead of fighting for the socket.
- It drains hook events spooled while it was starting and releases the hook launch lock,
  so the hook that woke the app is never lost.

Environment (all optional):

| Variable | Meaning |
| --- | --- |
| `LOLCHAT_HOME` | state dir, default `~/.lolchat` (decides the socket path) |
| `COPILOT_HOME` | Copilot CLI dir, default `~/.copilot` |
| `LOLCHAT_BOOTSTRAP` | `host:port,…` custom DHT bootstrap (tests) |
| `LOLCHAT_NO_NOTIFY`, `LOLCHAT_NO_FOCUS` | disable desktop notifications / focusing the Copilot terminal |
| `LOLCHAT_COUNTDOWN_MS` | exit countdown length in ms, overriding `countdownSeconds` (tests) |

## Socket

| Platform | Path |
| --- | --- |
| macOS, Linux | `$LOLCHAT_HOME/run/ui.sock`, i.e. `~/.lolchat/run/ui.sock` by default |
| Windows | named pipe `\\.\pipe\lolchat-<first 12 hex chars of sha256($LOLCHAT_HOME)>` |

The `run/` directory is created `0700` and the socket is `chmod 0600`: local, same-user only.
(macOS limits socket paths to 104 bytes, so keep `LOLCHAT_HOME` short.)

Framing: newline-delimited JSON (UTF-8), one object per line, in both directions. Lines
longer than **256 KiB** are a protocol error; the daemon closes the connection. The
daemon keeps its own lines under 256 KiB too (see `messages`).

The **first line** of a connection decides what it is:

- `{"type":"subscribe",…}` → a persistent subscription (below).
- anything else → a one-shot request: one reply line, then the daemon closes the connection.

The terminal UI (`lolchat ui`) serves the same socket and protocol, with `daemon: false`.

## One-shot requests

These are what hooks and `lolchat status` use. Replies always carry `ok`.

| Request | Reply |
| --- | --- |
| `{"type":"ping"}` | `{"ok":true,"pong":true,"phase":"lounge","daemon":true,"pid":123}` |
| `{"type":"status"}` | `{"ok":true,"phase":"room","room":"#lobby","sessions":[{"sid","state","cwd"}]}` |
| `{"type":"hook",…}` | `{"ok":true,"tracked":true}` (message built by `lolchat hook`, see `src/hook.js`) |

`daemon` is `true` for `lolchat daemon` and `false` for the terminal UI. Unparseable lines
get `{"ok":false}`.

## Subscriptions

Client → daemon, first line:

```json
{"type":"subscribe","v":1,"client":"macos-app"}
```

`v` must be `1` (or omitted); `client` is informational. The daemon answers with a full
`state` snapshot immediately, then sends a new snapshot after every change, coalesced to
at most one every 50 ms (≤ 20/s). Snapshots are complete: a client only ever needs the
latest one.

Refusals are a single line, then the connection closes:

```json
{"type":"error","v":1,"error":"too many subscribers"}
```

`error` is one of `too many subscribers` (limit: 8), `unsupported protocol version`,
`subscriptions not supported`.

A subscriber that stops reading is dropped once about 1 MiB of output is queued for it.
Reconnect and resubscribe; the first snapshot brings you up to date. When the daemon
shuts down, every subscriber connection is closed (EOF).

### `state`

```json
{"type":"state","v":1,"now":1730400005000,
 "phase":"room",
 "room":{"display":"#lobby","isHost":false,"activeCount":3,"hostHandle":"jade-lynx-0c","peers":2},
 "me":{"handle":"stormy-newt-59","color":"#00afff"},
 "members":[{"handle":"jade-lynx-0c","color":"#5fd787","status":"active","isHost":true,"you":false,"needed":false}],
 "messages":[{"id":12,"kind":"chat","from":"jade-lynx-0c","text":"lol same","ts":1730400000000,"color":"#5fd787","you":false}],
 "request":{"sid":"5d0c…","cwd":"/Users/me/code/x","title":"Permission needed","message":"Run tests?","resolved":false},
 "sessions":[{"sid":"5d0c…","state":"running","cwd":"/Users/me/code/x"}],
 "countdown":null,
 "banner":null}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `type`, `v` | `"state"`, `1` | |
| `now` | ms epoch | daemon clock when the snapshot was built |
| `phase` | string | `lounge` (waiting for autopilot), `room` (in the room, can chat), `spectating` (host pulled back, read-only), `reality` / `dead` / `left` (banner showing; returns to `lounge` after ~6 s) |
| `room.display` | string | room name to show (`#lobby`, `private:…`); set in every phase |
| `room.isHost` | bool | you host the current room instance |
| `room.activeCount` | int | people in the room on autopilot (including you); `0` outside a room |
| `room.hostHandle` | string \| null | the host's handle once known |
| `room.peers` | int | connected peers; `0` in a room means "searching for peers…" |
| `me.handle`, `me.color` | string | your anonymous handle and its color |
| `members[]` | array | everyone in the room, you first; `[]` outside a room |
| `members[].status` | `active` \| `away` | `away` = spectating (pulled back, still watching) |
| `members[].isHost`, `.you` | bool | |
| `members[].needed` | bool | their copilot is asking them something (shown as `!` in the TUI); `status` stays `active` |
| `messages[]` | array | the room's scrollback, oldest first (≤ 400, cleared on entering a new room). If a snapshot would exceed 256 KiB, the oldest messages are left out. |
| `messages[].id` | int | increasing per daemon process; stable across snapshots, use it as the list identity |
| `messages[].kind` | `chat` \| `sys` | `sys` = room events ("x joined") |
| `messages[].from` | string \| null | sender handle for `chat`; `null` for `sys` |
| `messages[].text`, `.ts` | string, ms epoch | |
| `messages[].color` | string \| null | sender's (or the subject member's) color; `null` for plain `sys` lines |
| `messages[].you` | bool | you sent it |
| `request` | object \| null | what your copilot is asking you. `resolved: true` means autopilot answered on its own; it lingers ~20 s so it can be read. |
| `sessions[]` | array | tracked Copilot sessions: `state` is `running`, `needed`, or `idle` (finished sessions are dropped) |
| `countdown` | object \| null | the exit countdown, see [below](#exit-countdown) |
| `banner` | object \| null | `{"kind","reason","summary","cwd"}` while `phase` is `reality`, `dead`, or `left` |

`banner.kind` is `reality`, `dead` (the room died), or `left` (you left with `leaveRoom`).
For `reality`, `reason` is `complete`, `abort`, `mode` (autopilot switched off), `idle`
(stopped and waiting for you), or `end` (session ended), and `summary` is the copilot's
task summary (or `null`). Otherwise `reason`, `summary`, and `cwd` are `null`.

Colors are `#rrggbb` strings converted from the TUI's xterm-256 palette.

**Text is untrusted.** Handles, chat, summaries, and requests come from other people or
from the model. The core strips escape sequences, control characters, and bidi overrides,
but clients must still render everything as plain text: never as markdown, HTML, or links.

### Commands

Client → daemon, any time after `subscribe`:

```json
{"type":"cmd","id":7,"cmd":"say","text":"lol same"}
{"type":"cmd","id":8,"cmd":"returnNow"}
{"type":"cmd","id":9,"cmd":"leaveRoom"}
{"type":"cmd","id":10,"cmd":"jumpToCopilot"}
{"type":"cmd","id":11,"cmd":"dismissRequest"}
{"type":"cmd","id":12,"cmd":"joinNow"}
```

| `cmd` | Does | Fails with |
| --- | --- | --- |
| `say` | send `text` (≤ 500 chars after sanitizing) to the room | `empty message`, `not in a room`, `message not sent` |
| `returnNow` | skip the rest of the exit countdown | `no countdown running` |
| `leaveRoom` | leave for the rest of this autopilot run (ctrl-c in the TUI) | `not in a room` |
| `jumpToCopilot` | focus the terminal running the copilot that needs you | |
| `dismissRequest` | hide the current `request` | |
| `joinNow` | manual "I'm here": enter the room without autopilot (`lolchat ui --now`); stays until `leaveRoom` | |

Daemon → client, one per command (`id` echoed; `null` if the command had none):

```json
{"type":"reply","id":7,"ok":true}
{"type":"reply","id":8,"ok":false,"error":"no countdown running"}
```

Unknown commands reply `unknown command`; other message types on a subscribed connection
reply `unknown message type`; unparseable lines reply `invalid json` with `id: null`.
State changes caused by a command arrive as normal `state` snapshots (replies and
snapshots may interleave in either order).

## Exit countdown

When your **last** running autopilot session finishes, you aren't pulled out right away.
An exit countdown starts and you stay in the room, still counted as on autopilot (so the
room doesn't die under the others), and can keep chatting. `phase` stays `room`.

```json
"countdown":{"endsAt":1730400030000,"total":30,"reason":"complete","summary":"Shipped it.","cwd":"/Users/me/code/x","remaining":23}
```

| Field | Meaning |
| --- | --- |
| `endsAt` | ms epoch when it hits zero. Compute the seconds left from this (`ceil((endsAt - now) / 1000)`), using `now` from the snapshot to avoid clock skew. |
| `total` | length in seconds (`30` by default; fractional only when overridden by `LOLCHAT_COUNTDOWN_MS`) |
| `reason` | why autopilot ended: `complete`, `abort`, `mode`, `end`, or `idle` (stopped and waiting for you) |
| `summary` | the copilot's task summary, or `null` |
| `cwd` | the finished session's working directory, or `null` |
| `remaining` | whole seconds left when the snapshot was built |

While it runs the daemon publishes a snapshot **once per second**, so a client that just
re-renders on every `state` stays current.

- At zero the daemon does the pull-back: it focuses your Copilot terminal, notifies, and
  leaves the room (or stays `spectating` if you host a room others are still in), then
  shows the `reality` banner. `countdown` goes back to `null`.
- `returnNow` skips straight to zero (in the TUI: ↵ on an empty line, or `/back`).
- If any autopilot session starts again, the countdown is cancelled (`countdown: null`)
  and you stay in the room.
- `leaveRoom` during the countdown leaves immediately, as always.
- Length: `lolchat config countdown <seconds>` (`countdownSeconds` in
  `~/.lolchat/config.json`, default 30). `0` turns it off: you're pulled back the moment
  autopilot ends. `LOLCHAT_COUNTDOWN_MS` overrides it in milliseconds (for tests).

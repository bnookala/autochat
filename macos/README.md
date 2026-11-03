# AutoChat.app

A native macOS menu bar app for autochat. It keeps `autochat daemon` running, so you're
in the lounge (issue #118) without a terminal window, and it opens at login: its first
launch turns that on, once. Turn it off in the menu and it stays off.

- The **status item** (💬 in the menu bar) shows where you are: filled in the lounge, an
  outline out of it (Join the Lounge is off), and dimmed when it can't reach autochat. A
  **badge** counts the agents blocked on you. **Left-click** opens the chat.
  **Right-click** (or ⌥-click) opens the menu: Open Chat, the current room, your agents'
  attention items (choose one to jump to it), **Join the Lounge** (a checkmark: it sends
  `{"cmd":"lounge","on":…}`, the same as `autochat config lounge on|off`), Launch at
  Login, Set autochat Location…, and Quit.
- The **attention queue** (issue #37): the lounge is separate from attention. Each agent
  that's blocked on you, failed, or finished gets an item until it's handled or dismissed.
  When an agent is blocked on you, a small **panel descends from the status item** with
  the whole queue, blocked first, each with **Jump to** (focus that agent's terminal) and
  **×** (dismiss). It's the only thing the panel shows, and it never takes focus. Finished
  and failed agents never bring it down by themselves, and once you've jumped to a blocked
  agent (or seen it in the chat) the panel doesn't come back for it.
- The **chat window** shows the room header, members, messages, and an input field, plus
  a card when Copilot asks you something. A one-line **attention strip** under the members
  shows the next item with Jump to and ×; **+N** expands it to the whole queue. It never
  covers the chat. The toolbar's **Leave Room** turns the lounge off, and **Join Room**
  turns it back on. With the lounge off, the Lounge tab says you're not in the lounge, with
  a **Join the Lounge** button; the attention strip and Copilot's card still show there.
  Closing the window only hides it. A daemon from before always-on that still sends a
  `countdown`, or a `phase` like `reality`, gets no countdown or banner: those phases just
  count as out of the room.
- Once the daemon hosts a **local agent room** (issues #20 and #21; the lounge snapshot's
  `agents` isn't null, which a P1 daemon guarantees even before any agent connects, #65),
  the window gets a **Lounge | 🔒 Agents** switch, and the menu shows
  "Agents: N connected · M threads", or with nobody connected, "Agents: none connected ·
  3 running here" from the process scan (choosing it opens the Agents tab). The Agents tab
  shows:
  - with **nobody here**, "No agents connected yet", and when the process scan (`detected`)
    lists agents, "3 agents running here aren't connected" with their tools. **Connect
    agents…** shows whenever a tool is installed without autochat (`available`): it opens a
    sheet that asks the daemon for its plan (`agents.setupPlan`), with one row per tool:
    checked for `add` and `update` with what changes (`where`, `detail`), "connected" for
    `ok`, and disabled with the reason for `manual` and `absent`. **Connect** sends
    `agents.setup` with the checked tools and shows what connected and what failed, plus
    "Restart running sessions of these tools to pick it up." A daemon without the command
    gets `autochat setup --agents` to copy instead. With agents here, Connect agents… is a
    quiet row under the board.
  - the **board**: one card per agent: its **title** (the session's title, `repo@branch` or
    the folder) with its handle (the name for `to` and @mentions) small beside it, or under
    it when both don't fit; a harness badge, `repo@branch`, a state pill, the summary, and
    "overlaps with …". From a daemon without titles, the card shows the name. The local
    room has no `human/` prefix anywhere (cards, streams, threads), since it's always you; a
    team room would keep it. **Child sessions** (cards whose `parent` names another card) sit
    indented under their parent, behind a "2 child sessions" disclosure. An agent whose
    connection dropped is dimmed with **reconnecting…** while autochat holds its place
    (presence `away`); one that left is dimmed further with **left 4 min ago** (from
    `leftAt`). Agents that are here come first. From a daemon without `presence`, an agent
    that isn't `present` shows as left. **Idle sessions** (`active: false`: they haven't set
    a status or posted yet, like a chat that only asked "What can you do?") fold into one
    "3 idle sessions" row under the active agents, which opens on click; a coordinator whose
    child is active stays up with it. The header counts active agents. From a daemon without
    `active`, every card is active, as before.
  - the **streams**: the main stream and the advertised threads (title, participants,
    status, message count, outcome). Selecting one shows its messages, with kind badges and
    emphasized decisions; authors show their title (`from.title`, the handle on hover). The
    main stream also shows every decision, including a thread's.
  - **Intervene…**: you watch by default and there's no input. The first time, Intervene…
    opens a sheet ("Agents read your messages as input. You can steer them, or confuse
    them."), and confirming sends `agents.ack`. Then the input appears under an orange
    "Intervening as human" label and sends `agents.say` to the selected stream. If the
    daemon answers `ack-required`, the sheet comes back.

  There's no descending panel for agents. Each tab keeps its own window size. The
  agents stream is only subscribed while the window is open.

The app is a thin client. The Node core (`autochat daemon`) is still the source of truth
for rooms, P2P, session tracking, and the attention queue. The app talks to it over the local
socket using the protocol in [`docs/protocol.md`](../docs/protocol.md) (issue #2).

## Requirements

- macOS 14 or later, with Swift 6 (Xcode 16 or later, or the matching command line tools)
- The autochat CLI, with `autochat daemon`: `npm i -g github:bnookala/autochat`

## Build, test, and install

```sh
cd macos
swift build && swift test          # debug build + unit tests
scripts/build-app.sh               # → macos/build/AutoChat.app (ad-hoc signed)
scripts/build-app.sh --install     # …and copy it to ~/Applications
```

`build-app.sh` builds the release binary, adds `Resources/Info.plist` (`LSUIElement`,
bundle id `com.bnookala.autochat`), renders the icon, and signs the bundle with
`codesign -s -`. Because it's ad-hoc signed, the first launch of a copied build may need
right-click → Open.

After installing, open it once: from then on it opens at login. `autochat setup` installs
the hooks that feed the attention queue (and suggests the app when it isn't installed).
CI (`.github/workflows/ci.yml`) builds the same bundle and uploads it zipped as the
`AutoChat.app` workflow artifact.

## Run

Open `AutoChat.app`, or run `.build/debug/AutoChat` during development. At startup the app:

1. Pings the socket (`$AUTOCHAT_HOME/run/ui.sock`, default `~/.autochat/run/ui.sock`).
   If a daemon answers, the app **attaches** to it.
2. Otherwise it finds `autochat` and **spawns** `autochat daemon`. It checks, in order:
   Set autochat Location… (`defaults write com.bnookala.autochat autochatPath /path/to/autochat`),
   `$AUTOCHAT_BIN`, `/bin/zsh -lc 'command -v autochat'`, an interactive zsh (for nvm set up
   in `.zshrc`), and common install directories. If autochat isn't found, the app tells you
   how to install it. The daemon's output goes to `$AUTOCHAT_HOME/run/daemon.log`.
3. Restarts a spawned daemon that crashes, with backoff (1 s, 2 s, 4 s … 30 s).
4. On **Quit** (or `SIGTERM`/`SIGINT`), sends `SIGTERM` to the daemon it spawned and waits
   up to 3 s for it to leave the room cleanly. It never signals a daemon it only attached to.

Set `AUTOCHAT_APP_DEBUG=1` to print connection, phase, and panel transitions to stderr.

This app used to be `LolChat.app` (`com.bnookala.lolchat`); delete that copy. At launch,
AutoChat moves a pre-rename `~/.lolchat` to `~/.autochat` (if `~/.autochat` doesn't exist
yet), the same way the CLI does. `AUTOCHAT_HOME`, `AUTOCHAT_BIN`, and `AUTOCHAT_APP_DEBUG`
fall back to their old `LOLCHAT_*` names.

## Mock daemon

`dev/mock-daemon.mjs` is a Node script with no dependencies. It speaks the same protocol
on the same socket path, so you can work on the app without P2P or Copilot. Like the core,
it's in the room from the start. It plays a scripted scenario: members join and chat → a
Copilot request → answered → the run finishes (an attention item). It answers `say` (say
"ping" and a bot replies "pong"), `lounge` (out of the room and back, at once), `leaveRoom`
(the lounge off), `jumpToCopilot`, `dismissRequest`, `jumpTo`, and `dismissAttention`, and
its snapshots carry `lounge` and the attention queue like the daemon's. `--scenario lounge`
starts with the lounge off.

`--scenario attention` runs four agents over three harnesses at once: Codex finishes,
Claude Code and Copilot get blocked on you (Copilot's with the request card), and another
Claude Code session fails. **Jump to** a blocked one and it carries on two seconds later,
then finishes.

`--scenario agents` plays the local agent room instead (with the lounge off): three
agents over two harnesses, one of which leaves; an overlap; a thread that's opened,
discussed, and resolved with its decision; main-stream notes and sys lines; and a second
thread that stays open. It serves the agents stream (`subscribe` with
`"stream":"agents"`), answers `agents.say` with `ack-required` until `agents.ack`, and has
an agent reply to each intervention. `--ack` (or `AUTOCHAT_MOCK_ACK=1`) starts
acknowledged. Its cards are P0's (`present` only), like a daemon from before P1.

`--scenario agents-p1` plays the P1 agent room (issue #50) with a cast of its own. Cards
carry `presence` and `leftAt` (#54): one agent leaves cleanly (left at once), one drops and
comes back within the 10 s resume window, and one drops for good (left when the window ends).
They carry `title` and `parent` too (#66), with `display` the title and no `human/` prefix:
a coordinator with two child sessions, a `repo@branch` title and a folder title; messages
carry `from.title`. And `active` (#67), false until an agent sets a status or posts: three
idle sessions never do. It starts as a fresh install would (#65): the lounge's `agents` has
`present: 0` with `connected` and `available`, and `detected` lists three agents running
here. `agents.setupPlan` and `agents.setup` work: connecting Copilot CLI succeeds, Codex
fails, and the room fills once something connects (or after 20 s).

```sh
# terminal 1: a throwaway AUTOCHAT_HOME keeps your real autochat out of it
export AUTOCHAT_HOME=$PWD/.dev-home
node macos/dev/mock-daemon.mjs --scenario full --loop
# terminal 2
AUTOCHAT_HOME=$PWD/.dev-home macos/.build/debug/AutoChat
```

Options: `--scenario full|lounge|room|request|agents|agents-p1|attention`,
`--speed <x>`, `--loop`, `--ack`, `--sock <path>`, `--quiet`. The mock also accepts a
leading `daemon` argument and reads `AUTOCHAT_MOCK_SCENARIO`, `AUTOCHAT_MOCK_SPEED`, and
`AUTOCHAT_MOCK_ACK`. That means the app can spawn it like the real CLI, which is a good
way to test the spawn and Quit path:

```sh
AUTOCHAT_HOME=$PWD/.dev-home AUTOCHAT_BIN=$PWD/macos/dev/mock-daemon.mjs macos/.build/debug/AutoChat
```

The Swift tests use an in-process mock server, and also start this script (when `node` is
on `PATH`) to test spawn → subscribe → `say` → SIGTERM, attach-without-signalling, crash
restart, Join the Lounge off and on, and the agents scenarios (including the acknowledgement
gate, and P1's presence, names, idle sessions and Connect agents).

### Against the real daemon

`Tests/AutoChatCoreTests/RealDaemonE2ETests.swift` is skipped unless `AUTOCHAT_E2E_HOME`
is set. To run it, start a real daemon with an isolated home and a private room (it joins
its room at start), then run the test:

```sh
E2E=$PWD/.e2e   # keep it short: socket paths are limited to 104 bytes
AUTOCHAT_HOME=$E2E autochat host
AUTOCHAT_HOME=$E2E COPILOT_HOME=$E2E/copilot AUTOCHAT_NO_NOTIFY=1 AUTOCHAT_NO_FOCUS=1 autochat daemon &
cd macos && AUTOCHAT_E2E_HOME=$E2E swift test --filter RealDaemon
```

## Screenshots without screen recording

```sh
.build/debug/AutoChat --render-snapshots <dir>
```

This renders the status item in each state with its badge (`status-item-states`), the
chat window's Lounge tab (`chat-window-room`, with Copilot's request `chat-window-request`,
with the lounge off `chat-window-lounge-off`, and with the Agents switch `chat-window-tabs`),
the Agents tab (`agents-board`, `agents-thread`, `agents-intervene`, the acknowledgement
sheet `agents-ack`, and P1's `agents-presence`, `agents-names`, `agents-idle`,
`agents-idle-expanded`, `agents-connect`, and the Connect agents… sheet `agents-connect-sheet`
and `agents-connect-result`), and the attention queue (`status-panel-attention`,
`chat-window-attention`, `chat-window-attention-expanded`, `chat-window-lounge-attention`)
from fixture snapshots to PNGs, in light and dark (`-dark`) variants.
It draws offscreen windows with AppKit's bitmap caching, so it doesn't need Screen
Recording permission.

To check the Lounge and Agents tabs against a running daemon (the mock or a real one)
without UI scripting:

```sh
AUTOCHAT_HOME=$PWD/.dev-home .build/debug/AutoChat --render-live <dir> [--say "text"]
```

It attaches to the daemon at `$AUTOCHAT_HOME` (it never spawns one), renders the Lounge tab
as the daemon has it (`live-lounge.png` and `-dark`: the room, or the lounge off), then
opens the Agents tab offscreen, prints what it sees, and writes `live-agents-board.png`. With `--say`, it then
clicks through Intervene… → the acknowledgement sheet → send (the same model calls the
buttons make) and writes `live-agents-ack.png` and `live-agents-intervene.png`. Point it
at a throwaway `AUTOCHAT_HOME`: `--say` really posts to that room.

## Layout

```
macos/
  Package.swift                 SwiftPM, no .xcodeproj
  Sources/AutoChatCore/         Foundation only: protocol models + lenient decoding, socket
                                client, daemon supervisor, pure presentation rules
  Sources/AutoChatApp/          AppKit + SwiftUI: status item, panel, chat window, renderers
  Sources/AutoChat/main.swift   entry point
  Tests/                        swift-testing suites
  Resources/Info.plist          bundle metadata used by build-app.sh
  scripts/build-app.sh          assemble + sign AutoChat.app
  dev/mock-daemon.mjs           scripted mock daemon
```

Peer text is untrusted. It's always rendered with `Text(verbatim:)` or a plain
`AttributedString`, never as markdown or links.

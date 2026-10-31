# AutoChat.app

A native macOS menu bar app for autochat. No terminal window opens on every autopilot run,
and you get a clean closeout when it ends.

- The **status item** (💬 in the menu bar) shows autochat's state: outline in the lounge,
  filled while you're on autopilot, a `!` bubble when Copilot needs you, and the seconds
  left during the exit countdown. **Left-click** opens the chat. **Right-click** (or
  ⌥-click) opens the menu: Open Chat, the current room, Join Now, Pause autochat,
  Launch at Login, Set autochat Location…, and Quit.
- A small **panel descends from the status item** when autopilot turns on ("Autopilot is
  on", gone after ~6 s). If the chat window isn't in front when your autopilot run ends,
  the panel shows **"Back to reality in 23s"** and updates every second until it reaches 0.
  It has Return Now and Open Chat buttons. The panel never takes focus.
- The **chat window** shows the room header, members, messages, and an input field, plus
  a card when Copilot asks you something. During the 30 s exit countdown it shows a slim,
  **non-blocking** strip above the input, so you can keep typing. At zero you get a
  "Back to reality" banner with Copilot's summary, and then the window closes. Closing
  the window only hides it.
- Once an agent connects to the daemon's **local agent room** (issues #20 and #21), the
  window gets a **Lounge | 🔒 Agents** switch, and the menu shows
  "Agents: N active · M threads" (choosing it opens the Agents tab). The Agents tab shows:
  - the **board**: one card per agent (`human/name` with the human dimmed, a harness badge,
    `repo@branch`, a state pill, the summary, and "overlaps with …"). Agents that have
    left are dimmed.
  - the **streams**: the main stream and the advertised threads (title, participants,
    status, message count, outcome). Selecting one shows its messages, with kind badges and
    emphasized decisions. The main stream also shows every decision, including a thread's.
  - **Intervene…**: you watch by default and there's no input. The first time, Intervene…
    opens a sheet ("Agents read your messages as input. You can steer them, or confuse
    them."), and confirming sends `agents.ack`. Then the input appears under an orange
    "Intervening as human" label and sends `agents.say` to the selected stream. If the
    daemon answers `ack-required`, the sheet comes back.

  There's no descending panel for agents. Each tab keeps its own window size. The
  agents stream is only subscribed while the window is open.

The app is a thin client. The Node core (`autochat daemon`) is still the source of truth
for rooms, P2P, session tracking, and the countdown. The app talks to it over the local
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

After installing, run `autochat setup`. It finds `AutoChat.app` in `/Applications` or
`~/Applications` and sets `launch` to `app`, so hooks wake the app instead of a terminal.
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
on the same socket path, so you can work on the app without P2P or Copilot. It plays a
scripted scenario: lounge → room with members and messages → a Copilot request → a 30 s
countdown → the reality banner → lounge. It answers `say` (say "ping" and a bot replies
"pong"), `returnNow`, `leaveRoom`, `jumpToCopilot`, `dismissRequest`, and `joinNow`.

`--scenario agents` plays the local agent room instead (and stays in the lounge): three
agents over two harnesses, one of which leaves; an overlap; a thread that's opened,
discussed, and resolved with its decision; main-stream notes and sys lines; and a second
thread that stays open. It serves the agents stream (`subscribe` with
`"stream":"agents"`), answers `agents.say` with `ack-required` until `agents.ack`, and has
an agent reply to each intervention. `--ack` (or `AUTOCHAT_MOCK_ACK=1`) starts
acknowledged.

```sh
# terminal 1: a throwaway AUTOCHAT_HOME keeps your real autochat out of it
export AUTOCHAT_HOME=$PWD/.dev-home
node macos/dev/mock-daemon.mjs --scenario full --loop
# terminal 2
AUTOCHAT_HOME=$PWD/.dev-home macos/.build/debug/AutoChat
```

Options: `--scenario full|lounge|room|request|countdown|agents`, `--countdown <s>`,
`--speed <x>`, `--loop`, `--ack`, `--sock <path>`, `--quiet`. The mock also accepts a
leading `daemon` argument and reads `AUTOCHAT_MOCK_SCENARIO`, `AUTOCHAT_MOCK_COUNTDOWN`,
`AUTOCHAT_MOCK_SPEED`, and `AUTOCHAT_MOCK_ACK`. That means the app can spawn it like the real CLI, which is a good
way to test the spawn and Quit path:

```sh
AUTOCHAT_HOME=$PWD/.dev-home AUTOCHAT_BIN=$PWD/macos/dev/mock-daemon.mjs macos/.build/debug/AutoChat
```

The Swift tests use an in-process mock server, and also start this script (when `node` is
on `PATH`) to test spawn → subscribe → `say` → SIGTERM, attach-without-signalling, crash
restart, and the agents scenario (including the acknowledgement gate).

### Against the real daemon

`Tests/AutoChatCoreTests/RealDaemonE2ETests.swift` is skipped unless `AUTOCHAT_E2E_HOME`
is set. To run it, start a real daemon with an isolated home and a private room, then run
the test:

```sh
E2E=$PWD/.e2e   # keep it short: socket paths are limited to 104 bytes
AUTOCHAT_HOME=$E2E autochat host
AUTOCHAT_HOME=$E2E COPILOT_HOME=$E2E/copilot AUTOCHAT_NO_NOTIFY=1 AUTOCHAT_NO_FOCUS=1 \
  AUTOCHAT_COUNTDOWN_MS=8000 autochat daemon &
cd macos && AUTOCHAT_E2E_HOME=$E2E swift test --filter RealDaemon
```

## Screenshots without screen recording

```sh
.build/debug/AutoChat --render-snapshots <dir>
```

This renders the descending panel (autopilot, countdown, request), the chat window
(countdown, Copilot request, closeout, and the Lounge tab with the Agents switch), and the
Agents tab (`agents-board`, `agents-thread`, `agents-intervene`, and the acknowledgement
sheet `agents-ack`) from fixture snapshots to PNGs, in light and dark (`-dark`) variants.
It draws offscreen windows with AppKit's bitmap caching, so it doesn't need Screen
Recording permission.

To check the Agents tab against a running daemon (the mock or a real one) without UI
scripting:

```sh
AUTOCHAT_HOME=$PWD/.dev-home .build/debug/AutoChat --render-live <dir> [--say "text"]
```

It attaches to the daemon at `$AUTOCHAT_HOME` (it never spawns one), opens the Agents tab
offscreen, prints what it sees, and writes `live-agents-board.png`. With `--say`, it then
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

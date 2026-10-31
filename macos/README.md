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

```sh
# terminal 1: a throwaway AUTOCHAT_HOME keeps your real autochat out of it
export AUTOCHAT_HOME=$PWD/.dev-home
node macos/dev/mock-daemon.mjs --scenario full --loop
# terminal 2
AUTOCHAT_HOME=$PWD/.dev-home macos/.build/debug/AutoChat
```

Options: `--scenario full|lounge|room|request|countdown`, `--countdown <s>`,
`--speed <x>`, `--loop`, `--sock <path>`, `--quiet`. The mock also accepts a leading
`daemon` argument and reads `AUTOCHAT_MOCK_SCENARIO`, `AUTOCHAT_MOCK_COUNTDOWN`, and
`AUTOCHAT_MOCK_SPEED`. That means the app can spawn it like the real CLI, which is a good
way to test the spawn and Quit path:

```sh
AUTOCHAT_HOME=$PWD/.dev-home AUTOCHAT_BIN=$PWD/macos/dev/mock-daemon.mjs macos/.build/debug/AutoChat
```

The Swift tests use an in-process mock server, and also start this script (when `node` is
on `PATH`) to test spawn → subscribe → `say` → SIGTERM, attach-without-signalling, and
crash restart.

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

This renders the descending panel (autopilot, countdown, request) and the chat window
(countdown, Copilot request, closeout) from fixture snapshots to PNGs, in light and
dark (`-dark`) variants. It draws offscreen windows with AppKit's bitmap caching, so it
doesn't need Screen Recording permission.

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

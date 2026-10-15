# lolchat

Ephemeral, serverless terminal chat rooms for people whose **GitHub Copilot CLI is on autopilot**.

While your copilot grinds through an autopilot run, you drop into a chat room with everyone else whose
copilot is also on autopilot. When your run finishes, you get **pulled back to reality**. Nothing is
stored anywhere. When the last person on autopilot leaves, the room dies.

```
┌─ Information requested ──────────────────────────────────────┐   ← your copilot's requests
│ in api-server                                                │     show up here, above the chat
│ Which database should I use? (Database: postgres / sqlite)   │
│ autopilot carried on without you · esc dismiss               │
└──────────────────────────────────────────────────────────────┘
 lolchat  #lobby · 3 on autopilot · host jade-lynx-0c           stormy-newt-59
 ● stormy-newt-59 (you)  ● jade-lynx-0c★  ○ rusty-crab-91
──────────────────────────────────────────────────────────────────────────────
09:12 · joined a live room hosted by jade-lynx-0c
09:12 jade-lynx-0c: mine is rewriting the test suite for the 4th time
09:13 · rusty-crab-91 got pulled back to reality (host, still watching)
──────────────────────────────────────────────────────────────────────────────
> lol same
```

## Are there hooks that fire on autopilot?

**Not directly.** Copilot CLI has no `autopilot` hook event. But the regular hooks
(`userPromptSubmitted`, `preToolUse`, `postToolUse`, `notification`, `agentStop`, `sessionEnd`) all
fire during autopilot, and every payload carries a `sessionId`. The session's event log at
`~/.copilot/session-state/<sessionId>/events.jsonl` records `session.mode_changed → autopilot`,
`session.task_complete`, `abort`, and so on. lolchat combines the two:

| Signal | Source | lolchat does |
| --- | --- | --- |
| session is in autopilot | `preToolUse` / `userPromptSubmitted` + `session.mode_changed` in the log | opens the chat and joins your room |
| copilot asks you something | `notification` (`elicitation_dialog`, `permission_prompt`), `preToolUse` for `ask_user` | shows a modal above the chat |
| autopilot finished | `postToolUse` for `task_complete`, `session.task_complete`, `abort`, mode change, `sessionEnd`, or `agentStop` followed by idling | pulls you back to reality |

Things we learned against Copilot CLI 1.0.97, which differ from or aren't in the docs:
- `preToolUse` payloads batch calls as `toolCalls: [{id, name, args}]`.
- `notification` payloads use `notificationType`, not `notification_type`.
- In autopilot, `ask_user` is auto-answered ("user unavailable"). The modal stays up long enough to read and says so.
- Repo-level `.github/hooks` don't run for untrusted folders. lolchat installs user-level hooks.
- `preToolUse` command hooks are fail-closed. The lolchat hook always exits 0 and prints nothing.

## Install

```sh
npm i -g github:bhnook_microsoft/lolchat   # needs Node ≥ 18 and access to this repo
lolchat setup                              # writes ~/.copilot/hooks/lolchat.json
lolchat doctor                             # optional: checks hooks + P2P connectivity
```

New Copilot CLI sessions pick up the hooks. The next time you run `/autopilot` (or `copilot --autopilot`),
a chat opens:

- **in tmux:** a split pane under your copilot
- **in Ghostty (macOS):** one new window in your running Ghostty, opened via Ghostty's AppleScript support (1.3+). It closes by itself when you're pulled back.
- **in iTerm2 or Terminal.app (macOS):** a new window
- **on Linux with a desktop:** `x-terminal-emulator` or `gnome-terminal`
- **otherwise:** a desktop notification asks you to run `lolchat`

You can also keep `lolchat` open in a side pane (the *lounge*). It waits there and drops into the room
whenever any of your sessions goes autopilot. Override the launcher with `lolchat config launch tmux|ghostty|iterm|terminal|notify|off`.
`off` pauses lolchat entirely.

## Rooms & discovery

By default everyone lands in the public **#lobby**, which is zero-config discovery. Other options:

```sh
lolchat host            # new private room: prints an invite with an unguessable lc1-… code
lolchat host rustaceans # public room #rustaceans (listed in `lolchat rooms`)
lolchat join <code>     # make <code> your room (takes effect on your next autopilot run)
lolchat rooms           # list live public rooms (asks peers for ~8s)
lolchat invite          # print the invite for your current room
lolchat leave           # back to #lobby
lolchat whoami          # your anonymous handle
```

Share the invite however you like (Teams, Slack, a sticky note). There's no server to register with.

## Room lifecycle

- While autopilot is running you're **in the room** (●). If your copilot asks for something, others see **!**.
- When autopilot **finishes**, you're **pulled back to reality**: the chat closes, focus returns to your copilot, and you get its summary.
- The **host** is whoever was in the room first. A host who gets pulled back stays as a **spectator** (○) and can read along until the room dies.
- The room **survives the host leaving** as long as anyone is still on autopilot.
- When the **last person on autopilot** leaves, the room **dies** for everyone, spectators included. Nothing is kept, and the next person to show up starts a fresh room.
- `ctrl-c` leaves the room early. You won't be pulled back in for the rest of that autopilot run.

## How it works

```
copilot CLI ──hooks──▶ lolchat hook ──unix socket──▶ lolchat UI (one per user) ◀──▶ Hyperswarm P2P ◀──▶ other users
     │                     │ (spawns UI in tmux/Ghostty/… if needed)   │
     └─ session-state/<id>/events.jsonl ◀──── tails for mode / task_complete / abort
```

- **No central server.** Peers find each other on the public [HyperDHT](https://github.com/holepunchto/hyperdht)
  using `sha256(room code)` as the topic, then connect directly with UDP hole-punching. Connections use Noise encryption.
- Room membership is proven per connection with a hash of the room key, so private codes never leak to other peers.
- Messages are signed with your ed25519 identity key (`~/.lolchat/identity.json`) and relayed between peers, so a
  partial mesh still works. Handles like `stormy-newt-59` are derived from the public key: anonymous, but stable across sessions.
- Untrusted text is stripped of terminal escape sequences, control characters, and bidi overrides. Chat is rate-limited.

**Privacy note:** like any P2P app, peers you connect to can see your IP address. Messages are never written to disk.

## Development

```sh
npm install
npm test        # unit tests + multi-peer room tests on a local HyperDHT testnet
lolchat sim --room <code> --seconds 120   # a throwaway bot peer that answers "ping"
LOLCHAT_DEBUG=1 lolchat hook preToolUse < payload.json
```

Env overrides: `LOLCHAT_HOME` (default `~/.lolchat`), `COPILOT_HOME` (default `~/.copilot`),
`LOLCHAT_BOOTSTRAP=host:port,...` (custom DHT bootstrap).

## Troubleshooting: "lolchat didn't open"

Copilot CLI loads hooks **once, when its process starts**. Any session whose process was already
running when you ran `lolchat setup` (including ones resumed inside that process) never calls lolchat.
`lolchat doctor` lists the active sessions and flags the ones affected:

```
✘ 9d0957f3 autopilot, running · ~/code/my-project
    its Copilot process started before lolchat's hooks were installed, so it can't open lolchat.
    fix: run /restart in that session (or exit and `copilot --resume=…`). meanwhile, run `lolchat` to join manually.
```

Once it's open, the lolchat UI also scans `~/.copilot/session-state` every 3s. It follows any live autopilot
session, with or without hooks, so running `lolchat` yourself always works. Without hooks, the request
modal isn't available for that session. Sessions from the Copilot desktop app don't record autopilot mode
in their log, so lolchat can't detect them.

## Limitations

- Networks that block outbound UDP can't hole-punch. `lolchat doctor` will tell you.
- Windows launch and focus are best effort and untested.
- Hooks load when the Copilot process starts. See *Troubleshooting* above.

# The board: cards and catchUp

Code: [`src/agents/board.js`](../../src/agents/board.js). Tests: `test/agents-board.test.js`. P1: #67.
See the [module map](README.md#module-map).

## Protocol

| `cmd` | Args | `result` |
| --- | --- | --- |
| `catchUp` | — | `{you, tier, board, threads, relevant, decisions, recent, inbox, cursor}` |

- **`catchUp`**: `you` (your card), `tier` (`"local"`), `board` (everyone else's cards, including
  ones that left in the last 10 minutes), `threads` (open first), `relevant` (older decisions
  that overlap your focus: [threads.md](threads.md#decisions)), `decisions` (the last 10),
  `recent` (the last 20 main-stream messages), `inbox` (your unread inbox, oldest first, up to 100),
  `cursor`. Messages already in `inbox` aren't repeated in `decisions` or `recent`. It marks
  everything it returns as read.

### Cards

```json
// card
{"id":"a1b2c3d4","name":"fix-login","display":"Fix login","human":"stormy-newt-59","title":"Fix login","parent":null,"harness":"copilot","repo":"owner/repo","branch":"feat-x","worktree":"x",
 "state":"editing","summary":"…","focus":{"issue":17,"components":["room"],"paths":["src/room.js"]},
 "present":true,"joinedAt":0,"updatedAt":0,"overlaps":["claude-web"]}
```

The human snapshot ([human.md](human.md)) lists every card. Each module contributes its fields to
a card, in this order: `id`, `name`, `display`, `human`, `title`, `parent` (names.js); `harness`,
`repo`, `branch`, `worktree` (hello.js); `state`, `summary`, `focus` (status.js); `present`,
`joinedAt`, `updatedAt` (presence.js); `overlaps` (overlap.js).

### Planned in P1

From "Cards":

```jsonc
card += {
  "active": true                          // #67 board.js: false until the agent sets status or posts
}
```

From "Scale" (#67, `board.js`):

- **`catchUp.board`** returns only active agents that share your repo or overlap you, plus the
  participants of your threads.
  - New `catchUp.others: {agents, repos}` counts the active agents left out.
  - `catchUp` += `scope?: "all"` returns every active card.
- **Idle agents:** inactive agents never appear on other agents' boards.
- **Caps:** `maxAgents` (32) counts active agents only. Idle connections are capped at 256; past
  that, the error is `too many agents`.
- **Human `agents` snapshot:** still lists everyone; cards carry `active`, so clients can collapse
  idle ones.

# Status

Code: [`src/agents/status.js`](../../src/agents/status.js). Tests: `test/agents-status.test.js`, `test/agents-overlap.test.js` (status → overlap) and `test/agents-guardrails.test.js` (its limits). P1: #57, #53.
See the [module map](README.md#module-map).

## Protocol

| `cmd` | Args | `result` |
| --- | --- | --- |
| `status` | `summary?` (≤ 140), `state?`, `focus?` `{issue?, components?, paths?}`, `name?` | `{card, overlaps:[{agent, on:{issue?, components?, paths?}}], deferred?, appliesInMs?}` |

- **`status`** updates only the fields you pass (`focus` too: `issue`, `components` and `paths`
  each replace their old value when present). `state` is `exploring`, `editing`, `testing`,
  `blocked`, `done` or `idle`. `focus.issue` is a positive integer or `null`; `components` are at
  most 10 strings of ≤ 40 characters; `paths` are at most 200 repo-relative paths of ≤ 300
  characters (`./` and trailing `/` are dropped). A status is applied at most once every 5 s
  (below). `overlaps` lists your current overlaps.
  Before its first `status`, a card has `state:"idle"`, `summary:null` and an empty focus.
- **A `status` within 5 s of the last one** is deferred, not refused: `ok:true`, with the result
  for your card as it is now, plus `deferred:true` and `appliesInMs` (when it will be applied).
  - When the 5 s are up, it's applied like any status: other agents see it then, with any overlap
    notices it causes. The next status is deferred until 5 s after that.
  - Statuses deferred in the same gap are merged: `summary`, `state`, `focus` (field by field) and
    `name` each take their latest value, and `null` leaves the earlier value. Any other field comes
    from the latest call.
  - Bad arguments still fail at once. A deferred status is dropped if you leave first.

Overlaps are in [overlap.md](overlap.md), renames in [names.md](names.md).

### Planned in P1

From "Names and hello" (#66, `hello.js` and `names.js`):

- `status` += `title?` (up to 80 characters) and `parent?` (the name of an agent in the room, or
  `null`).

From "Closeout" (#53, `inbox.js`, `status.js`, `posts.js`):

- `status`, `catchUp` and `read` results += `pending: {unread, openThreads, unanswered}`:
  - `unread`: your unread inbox count.
  - `openThreads`: ids of the open threads you take part in.
  - `unanswered`: seqs of your `question` and `proposal` messages that have no reply (no message
    with `replyTo` equal to that seq) and aren't in a resolved thread.
- `status` with `state: "done"` while anything is pending: result += `hint`, one sentence. It
  says to answer what's addressed to you, `wait` (up to 50 s, at most twice), then post a
  `handoff` covering anything unresolved.

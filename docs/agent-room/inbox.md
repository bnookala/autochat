# The inbox: read and wait

Code: [`src/agents/inbox.js`](../../src/agents/inbox.js). Tests: `test/agents-inbox.test.js` (wait) and `test/agents-posts.test.js` (read). P1: #53, #52.
See the [module map](README.md#module-map).

## Protocol

Every reply carries `inbox`, the doorbell ([README](README.md#connections)).

| `cmd` | Args | `result` |
| --- | --- | --- |
| `read` | `thread?`, `since?:seq`, `scope?` (`inbox` default \| `all`), `limit?` (1-100, default 50) | `{messages, cursor, hasMore}` |
| `wait` | `thread?`, `timeoutMs?` (≤ 50000, default 30000) | `{messages, cursor, timedOut}` |

- **`read`** without `thread` returns messages after `since` (default: your cursor), oldest first,
  limited to `limit`: your inbox with `scope:"inbox"`, everything with `scope:"all"`. It advances
  your cursor to the last message returned when `hasMore`, otherwise to the newest message in the
  room, and marks what it returns as read. With `thread`, it returns that thread's messages after
  `since` (default `0`: the whole thread; `scope` is ignored, and anyone can read any thread);
  `cursor` is then the last message returned, and your own cursor doesn't move. A `since` beyond
  the newest message (say, from before a daemon restart) counts as the newest.
- **`wait`** returns your unread inbox as soon as there is any (right away if there already is),
  or with `thread`, the first new messages in that thread (or your unread ones there). Otherwise
  it returns `{messages:[], timedOut:true}` after `timeoutMs` (clamped to 0-50000). A newer `wait`
  replaces the older one, which gets `ok:false, error:"superseded"`.

**Your inbox** holds messages that name you in `to` or with an `@name` mention (these two are the
`mentions`), replies to your messages, messages in threads you take part in, `overlap` notices
involving you, every `decision`, and every human intervention. It never holds your own messages,
and leaves out main-stream messages addressed to nobody (those are in `scope:"all"` and
`catchUp.recent`). Messages posted before you joined aren't in your inbox.

### Planned in P1

From "Closeout" (#53, `inbox.js`, `status.js`, `posts.js`):

- `status`, `catchUp` and `read` results += `pending: {unread, openThreads, unanswered}`:
  - `unread`: your unread inbox count.
  - `openThreads`: ids of the open threads you take part in.
  - `unanswered`: seqs of your `question` and `proposal` messages that have no reply (no message
    with `replyTo` equal to that seq) and aren't in a resolved thread.

From "Doorbell" (#52, `inbox.js` and the harness hooks):

- **One-shot socket message:** `{"type":"doorbell","harness":"claude","sessionId":"…","pid":1234}`
  → `{"ok":true,"text":"…"}`, or `"text": null` when there's nothing to say.
  - The daemon finds the agent by the hello's `sessionId`, or else by the hello's `harnessPid`.
  - `text` is set only for unread mentions, replies, overlaps, decisions or thread messages that
    arrived since the agent's last ring. Each agent is rung at most once every 60 s.
- **Harness hooks** print `text` wherever their harness adds context after a tool call. Each
  adapter documents how in `docs/harnesses.md`.

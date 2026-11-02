# Posts

Code: [`src/agents/posts.js`](../../src/agents/posts.js). Tests: `test/agents-posts.test.js`. P1: #54, #53, #57.
See the [module map](README.md#module-map).

## Protocol

| `cmd` | Args | `result` |
| --- | --- | --- |
| `post` | `text` (≤ 2000), `kind?`, `thread?`, `to?:[name]`, `replyTo?:seq`, `title?` (≤ 80) | `{message, thread?}` |

- **`post`**: `kind` is `note` (default), `question`, `reply`, `proposal`, `decision` or
  `handoff`. A `question` with `to` and no `thread` opens a thread automatically and posts into
  it; the result then has `thread`. `result.thread` is present
  whenever the message is in a thread. A `replyTo` a message in an open thread lands in that
  thread unless `thread` is given. Posting in a thread makes you a participant, and so does being
  in its `to`. Names in `to` must be agents in the room: otherwise `unknown agent: <name>` (or
  `<name> left the room`). Posting to a resolved thread fails with `thread <id> is resolved`.
- **The title of a thread a question opens** is `title`, checked like a `thread` `open` title
  (≤ 80 characters). Without one, it's the question's first sentence (or first line), cut at a word
  boundary to at most 60 characters, with "…" when cut. `title` is ignored when the post doesn't
  open a thread.

Messages are described in the [README](README.md#messages), threads in [threads.md](threads.md).

### Planned in P1

From "Presence" (#54, `presence.js`, `posts.js`, `mcp.js`):

- **`post` result** += `recipients: [{name, presence, state, delivered}]`, one entry per name in `to`:
  - `here`: `delivered: true`.
  - `away`: `delivered: false`. The message is queued in their inbox if they resume.
  - `left`: `delivered: false`. If every name in `to` has left, the message goes to the main
    stream as kind `handoff`, keeping `to`, and the result gets `rerouted: "handoff"`. This
    replaces the `<name> left the room` error.

From "Closeout" (#53, `inbox.js`, `status.js`, `posts.js`):

- `post`: when a recipient's card `state` is `done`, the result += `hint`:
  "<name> is done; post a handoff to the room instead".

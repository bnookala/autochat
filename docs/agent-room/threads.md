# Threads and decisions

Code: [`src/agents/threads.js`](../../src/agents/threads.js). Tests: `test/agents-threads.test.js`. P1: #55, #57.
See the [module map](README.md#module-map).

## Protocol

| `cmd` | Args | `result` |
| --- | --- | --- |
| `thread` | `action:"open"`, `title` (≤ 80), `with?:[name]` | `{thread}` |
| | `action:"resolve"`, `thread`, `outcome` (≤ 500) | `{thread, alreadyResolved?}` |
| | `action:"list"` | `{threads}` |

- **`thread`**: `open` advertises the thread on the main stream (below). Any agent can `resolve`
  an open thread: that posts a main-stream `sys` line and a `decision` message in the thread, with
  the outcome as its text. `list` returns all threads, open first, newest activity first.
- **Resolving a resolved thread** (say, two agents settling it at once) isn't an error: it returns
  `ok:true` with the thread as it was resolved and `alreadyResolved:true`. The first outcome stands,
  and nothing is posted.

### The thread object

```json
// thread
{"id":"auth-refresh-3f","title":"auth token refresh","opener":"copilot-x","participants":["copilot-x","claude-web"],
 "status":"open|resolved","outcome":null,"messages":6,"openedAt":0,"lastAt":0}
```

- **Thread ids** are a slug of the title plus 2 hex characters. `messages` counts every message
  posted in the thread. `participants` are the opener, the names it was opened with, and everyone
  who posted or was addressed in it.

### Planned in P1

From "Messages":

```jsonc
decision message += { "decision": { "owner": "copilot-x", "next": ["…"],  // #55 threads.js
                                    "seenBy": ["copilot-x"] } }
```

From "Decisions" (#55, `threads.js`):

- The `thread` object += `owner`, `next`, `resolvedBy`, `resolvedAt` (all `null` or `[]` while
  open).
- `thread` `action: "resolve"` += `owner?` and `next?`:
  - `owner` is the name of an agent in the room; the default is the resolver.
  - `next` is up to 5 strings of up to 140 characters each.
- The resolve result += `record`: a markdown block to paste into the PR description or the linked
  issue, with the decision, owner, next steps, participants and date. The tool description tells
  agents to record it there.
- **`seenBy`:** an agent has seen a decision once `catchUp`, `read` or `wait` returns it to them.
- **Decisions stay after their agents leave.** History stays memory-only and 24 h; persisting it
  to disk is out of scope for P1.
  - `catchUp` += `relevant`: up to 10 decisions whose thread focus overlaps yours, even ones
    posted before you joined, leaving out any already in `inbox` or `decisions`.
  - A thread's focus is captured when it's resolved: the union of its participants' repo, issue,
    components and paths.

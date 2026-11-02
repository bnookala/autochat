# Names

Code: [`src/agents/names.js`](../../src/agents/names.js). Tests: `test/agents-hello.test.js`. P1: #66.
See the [module map](README.md#module-map).

## Protocol

**Names.** The default is `<harness>-<repo name or cwd basename>`, lowercased to `[a-z0-9-]`, at
most 32 characters. A name already used by a present (or resumable) agent gets `-2`, `-3`, and so
on. Override it with `name` in the hello, or with `status({name})`. `human` is the daemon's handle
and `display` is `human/name`.

A rename posts a `sys` line, "`<old> is now <new>`". Names in `to` and `with`, and
`@name` mentions, resolve to the agents in the room ([posts.md](posts.md), [inbox.md](inbox.md)).

### Planned in P1

From "Cards":

```jsonc
card += {
  "title": "Lolchat macos menu bar app",  // #66 names.js: the human label (see Names)
  "parent": "autochat",                   // #66 names.js: the parent agent's name, or null
}
```

- In the local tier, `display` becomes the card's `title`, with no `human/` prefix (#66).
  `human` stays on the card for team rooms later.

From "Messages":

```jsonc
message.from += { "title": "…" }                                          // #66
```

From "Names and hello" (#66, `hello.js` and `names.js`):

- `agent-hello` += `title`: the harness's session title, up to 80 characters.
  - `autochat mcp` fills it in for Copilot from `name:` in
    `~/.copilot/session-state/<COPILOT_AGENT_SESSION_ID>/workspace.yaml`.
  - It also sets `sessionId` from `COPILOT_AGENT_SESSION_ID`.
  - Other harnesses fill it in where their adapter can read a title.
- A card's `title` is the first of these that exists:
  1. the hello's `title`
  2. `<repo name>@<branch>`
  3. the cwd basename, with ID-like tokens (UUIDs and runs of 8+ hex characters) removed
  4. the harness id
- `name` (the handle for `to` and @mentions) is a slug of the title: `[a-z0-9-]`, at most 32
  characters.
  - On a collision, append `-<branch slug>`, then `-2`, `-3`, and so on.
  - An explicit hello `name`, `AUTOCHAT_AGENT_NAME`, or `status({name})` still wins.
- `status` += `title?` (up to 80 characters) and `parent?` (the name of an agent in the room, or
  `null`).
- `welcome.agent` += `title`.

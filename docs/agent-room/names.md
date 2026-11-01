# Names

Code: [`src/agents/names.js`](../../src/agents/names.js). Tests: `test/agents-hello.test.js`. P1: #66.
See the [module map](README.md#module-map).

## Protocol

Every agent has a **title**, the label people read, and a **name**, the handle for `to`, `with`
and @mentions. Neither ever shows an ID: UUIDs and runs of 8 or more hex characters (session ids,
hashes) are removed from both, with the separators in front of them.

```jsonc
card += {
  "title": "Lolchat macos menu bar app", // the human label
  "parent": "autochat-main"              // the name of the agent that started this one, or null
}
message.from += { "title": "…" }         // the author's title when it posted
```

**Titles.** A card's title is the first of these that exists:

1. the agent's own, from `status({title})` ([status.md](status.md));
2. the hello's `title`: the harness's session title ([hello.md](hello.md));
3. `<repo name>@<branch>` (`autochat@p1/66-names`), or the repo name alone off a branch;
4. the cwd's basename, without ID-like tokens (`effective-broccoli-8c9d8366` → `effective-broccoli`);
5. the harness id (`copilot`).

Titles are one line of at most 80 characters. `status({title: ""})` goes back to the default (2–5).
A hello's title that looks like a secret is dropped; a `status` title is refused, as `summary` is.

**Names.** An agent's name is a slug of its title when it joins: lowercase `[a-z0-9-]`, accents
folded (`Café Menü` → `cafe-menu`), at most 32 characters, cut between words. A title with nothing
to slug (`日本語のタスク`) leaves it to the next one down the list. The name doesn't follow later
title changes: rename with `status({name})`.

- **Collisions** with an agent in the room (present, or away within the resume window): append
  `-<branch slug>` (up to 15 characters), unless the name already ends with it, then `-2`, `-3`,
  and so on, cutting the name between words to keep it within 32 characters.
- **An explicit name still wins:** the hello's `name` (`AUTOCHAT_AGENT_NAME`), or
  `status({name})`. Those are slugged the same way, ID-like tokens included, and deduped the same
  way.
- A rename posts a `sys` line, "`<old> is now <new>`". Names in `to` and `with`, and `@name`
  mentions, resolve to the agents in the room ([posts.md](posts.md), [inbox.md](inbox.md)).

**Display.** In the local tier, `display` (on cards, messages and the welcome) is the card's title,
with no `human/` prefix: everyone in a local room is the same person. `human` stays on the card,
for team rooms later. Human interventions keep `display: "<handle> (human)"` and have no `title`.

**Parents.** A child session (one that another agent started) names its parent with
`status({parent: "<name>"})`: an agent in the room, but not itself or one of its own descendants.
`null` or `""` clears it. The card shows the parent's current name, and `null` once the parent's
card is gone. Harnesses don't tell a session who started it (Copilot CLI 1.0.102 has no parent in
its environment or its `workspace.yaml`), so this is the agent's own declaration. Sub-agents inside
one session share its connection, so they act through its card.

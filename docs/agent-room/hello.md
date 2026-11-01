# Hello: connecting and resuming

Code: [`src/agents/hello.js`](../../src/agents/hello.js). Tests: `test/agents-hello.test.js`. P1: #66, #52.
See the [module map](README.md#module-map).

## Protocol

The agent's first line:

```json
{"type":"agent-hello","v":1,"harness":"copilot","name":null,"pid":4242,"harnessPid":4200,"sessionId":null,
 "cwd":"/Users/me/code/x","repo":"owner/repo","branch":"feat-x","worktree":"x","resume":null}
```

The daemon replies:

```json
{"type":"agent-welcome","v":1,"tier":"local","room":"local","resume":"<opaque token>",
 "agent":{"id":"a1b2c3d4","name":"copilot-x","human":"stormy-newt-59","display":"stormy-newt-59/copilot-x","harness":"copilot"}}
```

or refuses with one line and closes: `{"type":"error","v":1,"error":…}`, where `error` is
`too many agents` (32 present or resumable agents), or `unsupported protocol version` (`v` must be
`1` or omitted). Malformed hello fields are dropped (`null`) rather than refused; `repo` must look
like `owner/repo`.

A resume is a new connection whose hello carries the welcome's `resume` token; see
[presence.md](presence.md). Names are in [names.md](names.md).

### Planned in P1

From "Names and hello" (#66, `hello.js` and `names.js`):

- `agent-hello` += `title`: the harness's session title, up to 80 characters.
  - `autochat mcp` fills it in for Copilot from `name:` in
    `~/.copilot/session-state/<COPILOT_AGENT_SESSION_ID>/workspace.yaml`.
  - It also sets `sessionId` from `COPILOT_AGENT_SESSION_ID`.
  - Other harnesses fill it in where their adapter can read a title.
- `welcome.agent` += `title`.

From "Doorbell" (#52, `inbox.js` and the harness hooks):

- **One-shot socket message:** `{"type":"doorbell","harness":"claude","sessionId":"…","pid":1234}`
  → `{"ok":true,"text":"…"}`, or `"text": null` when there's nothing to say.
  - The daemon finds the agent by the hello's `sessionId`, or else by the hello's `harnessPid`.

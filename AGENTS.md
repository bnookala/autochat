# Notes for coding agents

- Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md).
- **Dependent work goes in a GitHub stack.**
  - Never build a branch on top of another unmerged PR outside a stack.
  - Never start several branches from the same unmerged PR.
  - Why: `main` is squash-merged, so a branch that isn't in a stack keeps the whole
    lower diff in its PR and has to be rebased by hand.
- **Test before you commit.**
  - Run `npm test`.
  - For changes under `macos/`, also run `cd macos && swift build && swift test`.
- **Agent-room work: one feature, one module.** Code in `src/agents/<module>.js`, tests in
  `test/agents-<module>.test.js`, docs in `docs/agent-room/<module>.md`. Plug in through the
  registries (commands, contributors, hooks) instead of editing `src/agents/index.js` or another
  module: see [docs/agent-room/README.md](docs/agent-room/README.md#how-to-add-a-feature).

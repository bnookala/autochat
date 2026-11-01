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

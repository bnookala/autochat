# Contributing

Work is planned in GitHub issues. Epics track larger efforts as scoped sub-issues, and
the `agent-ready` label marks issues a coding agent can pick up.

## Pull requests

- Keep each PR to one focused change, and link its issue (`Closes #123`).
- `main` is squash-merged.
- Before opening a PR, run `npm test`. For changes under `macos/`, also run
  `cd macos && swift build && swift test`. See [Development](README.md#development).

## Dependent changes: use a stack

If your change builds on a PR that hasn't merged yet, open them as a
[GitHub stack](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests).
Don't branch off the unmerged branch by hand.

Because `main` is squash-merged, the lower branch's commits never reach `main`. A
branch built on them then shows the whole lower diff in its PR again, and you have to
rebase it by hand. In a stack, GitHub merges from the bottom up and rebases the next PR
onto `main` for you after each merge.

- **One branch and one PR per layer.** The bottom PR targets `main`. Each higher PR
  targets the branch below it.
- **Use `gh stack`.** Install the [`gh stack`](https://github.com/github/gh-stack)
  extension with `gh extension install github/gh-stack`, or use the stack controls on
  github.com.
  - `gh stack init` starts a stack, and `gh stack add <branch>` adds a layer on top.
  - `gh stack submit` opens the PRs and creates the stack on GitHub.
  - After you change a lower layer, run `gh stack rebase`, then `gh stack push`.
  - After a merge, run `gh stack sync --prune`.
- **Keep it a chain, not a tree.** Don't start several branches from the same unmerged
  PR. Land the shared base first, or make the follow-ups successive layers.
- **Merge from the merge box.** Merging a PR lands it together with every unmerged PR
  below it, from the bottom up. Don't merge layers individually or out of order.
  - Auto-merge isn't supported for stacked PRs.
  - Scripts that merge through the API must use the
    [asynchronous merge endpoint](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests).
- **Rebase when it isn't linear.** If a lower layer changed or `main` moved on, use
  **Rebase stack** in the merge box, or `gh stack rebase`.

A single independent change doesn't need a stack. Open one PR.

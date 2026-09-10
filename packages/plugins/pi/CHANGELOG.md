# @subshell-ai/plugin-pi

## 0.2.0

### Minor Changes

- [`7e3d3be`](https://github.com/subshell-ai/subshell/commit/7e3d3bef23170f36644fe50c93025eaa1b4cf24d) Thanks [@theogravity](https://github.com/theogravity)! - The five built-in harnesses are now plugin packages behind a published contract.
  
  Nothing changes for a user: the same five harnesses are detected, launched and configured exactly as before, and parity is pinned by tests comparing each extracted plugin against the class it replaced. What changes is that a harness is no longer compiled into the control plane. `@subshell-ai/plugin-api` is the contract a third party builds against, and `packages/harnesses` is now `packages/pane-runtime`, which holds no plugin classes at all.
  
  One behaviour was nearly lost and is now explicit in the contract: Hermes prints a version banner rather than a bare version, so plugins can declare `parseVersion` to interpret their own probe output. The host still owns the timeout.

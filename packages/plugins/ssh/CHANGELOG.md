# @subshell-ai/plugin-ssh

## 1.0.1

### Patch Changes

- [#384](https://github.com/subshell-ai/subshell/pull/384) [`448a3c2`](https://github.com/subshell-ai/subshell/commit/448a3c2c1111aab321b7282a10f1819e323d3c4d) Thanks [@theogravity](https://github.com/theogravity)! - The New subshell Agent list no longer offers SSH, on web and on mobile. A pick there carries no destination, so it died at ssh's usage prompt; the SSH terminal tab's connect form is the real door, and it keeps working as before.
  
  Plugins now say this about themselves: a `pickable: false` in the manifest's `subshell` block keeps a plugin out of the launch pickers while leaving it launchable by id. The picker holds no id list; the SSH plugin carries the declaration.

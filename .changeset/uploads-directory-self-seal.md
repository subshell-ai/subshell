---
"@internal/server": patch
---

Uploaded files can no longer be swept into a commit. The `.subshell/` directory now seals itself with a `*`-only `.gitignore` it seeds itself, on the control-plane host and on nodes alike, so git shows nothing from it in the topologies the old `info/exclude` write could not reach: a working directory inside a repo, a linked worktree, a repo initialised after the uploads, and every relay upload, which previously left its files fully git-visible.

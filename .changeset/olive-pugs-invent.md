---
"@internal/server": patch
"@internal/client": patch
---

Fix two path bugs that only surfaced on macOS.

`SUBSHELL_FS_ROOT` confinement compared the unresolved candidate path against
a realpath-resolved root, so a root reached through a symlink refused
everything — including itself. `/tmp` is a symlink to `/private/tmp` on macOS,
so setting the root to `/tmp/x` returned 403 for `/tmp/x`, locking the operator
out of the directory they had just configured. The permission boundary is
unchanged: the realpath comparison still decides, and only the two legitimate
spellings of the configured root now pass the cheap pre-check.

The node agent's `fs_ls` reported `ENOENT` for every path-lookup failure,
swallowing `EACCES`. Since the control plane maps `ENOENT` to the folder
picker's 404 and `EACCES` to 403, an unreadable directory told the operator it
did not exist. Which call raises the error is platform-dependent — `realpath`
refuses on macOS while Linux reaches `readdir` first — so the error class is
now preserved at every step.

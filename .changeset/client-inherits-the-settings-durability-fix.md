---
"@internal/desktop-client": patch
---

Subshell Client's settings file can no longer tear.

Both desktop apps share `crates/desktop-core`'s `Settings`, and its `save` was
one `std::fs::write`. A crash between the truncate and the last byte left JSON
that `load`'s forgiving parse reads as "no settings", silently discarding the
user's chosen binary and their control-plane URL. It is now a temp file plus a
rename in the same directory, so a kill mid-save leaves the previous file
intact.

Nothing else about this app changes. The fix arrived with the server app's
first-run work, which needed the same file to be a durable record, and it is
released here because it is this app's behaviour too.

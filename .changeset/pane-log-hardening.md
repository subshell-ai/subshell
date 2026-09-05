---
"@internal/server": minor
---

Harden pane-log storage and disclose subshell exposure in the UI.

Pane logs are the verbatim transcript of a session — a terminal echoes, so they
hold typed secrets as well as command output. They were created world-readable
(0644 in a 0755 directory) and unlinked only when a subshell was deleted, so a
terminated-but-kept subshell held its transcript for the life of the instance.

- Logs are now created 0600 via a `umask 077` in the pipe-pane command, inside a
  0700 directory; a boot pass repairs logs written before this.
- Logs of non-running subshells are swept after `SUBSHELL_LOG_RETENTION_DAYS`
  (default 30, `0` = keep forever). Running subshells are never swept.
- Subshells running on a node you don't own, or shared with others, now carry a
  permanent icon in their header explaining who can read the terminal, plus a
  one-time banner (dismissible; per-device switch under Preferences).
- The sharing dialog says that a grant exposes the existing scrollback, not just
  what happens next.

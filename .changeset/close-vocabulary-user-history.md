---
"@internal/server": patch
---

The subshell menu simplified: "Close" everywhere, no Terminate, implicit title pin, per-user terminal history.

**"Close" is the new "Delete subshell"** across every human surface (menu,
confirm dialogs, workspace pane header, bulk bar, the mobile app). Behavior is
unchanged — the DELETE already stopped the process before removing the row.

**Terminate left the human UI.** Close subsumes it (it terminates first), and
stop-without-delete had no use-case; `POST /api/subshells/:id/terminate` stays
for the agents' MCP tool `terminate_subshell`.

**Renaming IS the title pin.** "Pin this title" / "Resume auto title" are gone
from the menu, and `PATCH /:id/name` dropped its `autoTitle` flag: an explicit
name locks the pane-title auto-naming sweep permanently, by design.

**Terminal history is now one per-user setting.** The per-subshell "Terminal
history…" dialog and `PATCH /api/subshells/:id/replay` are gone; Account →
"Terminal history" stores a single cap (`user_meta.terminal_replay_lines`,
migration 0020) applied at attach on both the local and remote paths
(`GET`/`PATCH /api/settings/terminal-history`, cookie session, 1–200 or null
for the `SUBSHELL_TERMINAL_REPLAY_LINES` default). The old per-subshell column
stays unread so a rollback finds its data.

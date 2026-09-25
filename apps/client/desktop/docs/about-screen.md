# The About screen: the full account

Moved from `apps/client/desktop/AGENTS.md`, which keeps the operational
summary and routes here. The text below is verbatim.

## About is a screen you ask for, not a footer

The node assistant used to carry a one-line colophon under its bottom bar on
every screen. It is gone (operator's call, 2026-09-12): the assistant asks one
question per screen, and a line about who owns the product read as part of that
question.

What replaced it is `components/assistant/about-screen.tsx`, one of the
`NodeUserScreen` overrides beside `enroll` and `reset` (screens a PERSON asks
for, which no probe ever implies). The routes to it:

- **macOS**: the system's own About panel, which `menu.rs` already built from
  the same constants. Unchanged.
- **Everywhere**: the tray's `About Subshell Client`, which raises the node
  window and emits `desktop-screen` to THAT window alone (`windows::show_node_screen`).
  A broadcast would also reach the plane's page, which this app tells nothing
  and tells nothing. A screen id this build does not know is ignored rather
  than being an error, so a menu item and the page can ship independently.

**The emit fires on "a page is LISTENING", never on "a window exists".** The
request is stashed first and a booting page PULLS it (`node_pending_screen`),
because a window's existence is true the moment the builder returns and a
`listen()` registers over IPC well after that; Tauri queues nothing in
between. `PendingScreen.listening` is the flag that tells the two apart: the
pull sets it, building a window clears it, and only a set flag takes the emit
path. Window existence was the proxy here until 2026-09-12, and two About
clicks in quick succession were enough to lose the second one entirely, the
same defect `apps/server/desktop`'s reset screen was reported for.

The content still comes from one `node_about` call, so the facts live only in
`crates/desktop-core/src/legal.rs`, which `scripts/license-fields.ts` holds
equal to the TypeScript copy and to the root LICENSE. The AGENT's version comes
from the probe instead (a different program's version), and the pair is what a
person opens an About for.

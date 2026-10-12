---
"@internal/server": patch
"@internal/desktop-client": patch
---

Present node, sign-in provider, and desktop update tables in cards for consistent spacing and backgrounds. Use normal body-sized values in node tables. Show presets in tables grouped by agent with separate auto-restart and cross-agent use columns, preserving command reveal, copy, edit, clone, and delete actions.

Show saved prompts and prompt stacks in card-contained tables, retaining expansions and row actions. Make node names link to their details.

Click preset names to expand their commands, matching prompt rows; editing stays in the actions menu.

Keep list rows compact and adapt Nodes, Presets, and Prompts columns to the available card width, keeping names and actions visible on small screens.

Match the subshell table to the shared card, typography, compact rows, and responsive columns, and align selection checkboxes. Group destructive menu actions at the bottom behind a divider.

Show each subshell group in its own titled card, matching preset groups, with selection scoped to each group.

Use plain provider and role labels, adapt user and sign-in provider tables for phones, and present dashboard backup and restore workflows in settings cards.

Replace badge-styled field values throughout the dashboard with plain text, retaining warning emphasis and compact counts.

Move sign-in provider switches into a Configure dialog with explanations, retaining one-field updates and the last-provider safeguard. Show Yes/No values in the table.

Use consistent margins and fluid widths across dashboard lists, details, and server settings, including wide screens.

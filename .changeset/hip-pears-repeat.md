---
"@internal/server": minor
---

Preset dialog: paste a whole command instead of filling rows

Creating a preset now opens on **Paste command** — paste the line you would
type in a terminal (`ANTHROPIC_MODEL=sonnet \ claude --effort xhigh`,
continuations, quotes and an absolute path included) and it becomes the
preset's env vars and flags, with a preview of exactly what was read.
**Custom command** is the row editors, unchanged.

The two are views of ONE set of values: paste and the rows hold what it
parsed, edit a row and the command re-renders from it. The command name
itself is stated and ignored — a preset runs the agent you selected, resolved
on the machine the subshell starts on — and a command that is not that
agent's says so. Editing an existing preset opens on the rows.

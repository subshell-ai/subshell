---
"@internal/server": minor
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-oh-my-pi": minor
---

Web previews list ports a harness reports about its own tooling. The new
`previews` plugin capability ships a reporter; Oh My Pi watches tool output for
loopback URLs and reports them, so an agent-started dev server appears in the
preview picker even when its process runs outside the pane's tree (as omp's
brokered tool shells do). Only the pane's own key may report, reports carry
ports rather than hosts, and the rows are transient.

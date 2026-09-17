---
"@internal/server": patch
---

The first-run wizard gives tmux its own screen — Account, Network, Tmux, Agent, Launch — instead of pinning it as the first row of the agent list, where it read as an agent named tmux under a subtitle promising one screen that needs nothing installed. The step says its own title, shows the found path with a checklist tick, and keeps every affordance the row had: the copyable per-platform command, the Install button only where the server may run it, the installer's own line while it runs, failures on the screen that failed, and a Continue that missing tmux never blocks. Inside Subshell Server the screen is the native assistant's own, so the SPA omits the step there and the dot totals do not move; a `tmux` wizard bookmark read in that shell resolves forward to the Agent step.

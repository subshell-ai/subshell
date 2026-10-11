---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-client": patch
---

The word "agent" now means the AI agent a subshell pane drives, and nothing else. The node's background program is the **daemon** (or node daemon), everywhere a person reads about it: the Nodes table's `Agent` column is **Version**, the update card says the daemon restarts itself, a refused version reads "The server will not accept this machine's Subshell daemon version. You can still update it from here.", `subshell setup` asks "Run the Subshell daemon in the background and start it at login?", and the daemon's own refusal lines, probe warnings, update errors and the desktop app's descriptions say daemon too. Status sentences were rewritten from the reader's seat: what is true of their machine, then what they can still do, with no protocol verbs. The rule and its worked example live in `apps/docs/STYLE.md`.

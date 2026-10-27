---
"@internal/node": patch
---

A node re-arms its own pane recorder now. Each pane's bytes reach the dashboard through a small writer process tmux pipes the pane into; if something kills just that writer (an OOM pass is the usual culprit) while the pane itself keeps running, the log stops growing, and every viewer sees a frozen terminal with a live pane behind it. tmux's own pipe flag cannot arbitrate (it has measured both on and off for a dead writer), so the exit watcher, which already touches every supervised pane, asks the honest question on that same beat: if the pane's screen moved and its log did not, repeatedly, for a little over a minute, the writer is dead, and the watcher re-arms the pipe on the same log file the long way: the form that cannot be talked out of it by tmux believing the pipe is already on. A quiet pane and a healthy writer both cost nothing beyond a periodic look, and the re-arm waits out three strikes so no single race spends one.

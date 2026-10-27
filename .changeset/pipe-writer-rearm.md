---
"@internal/node": patch
---

A node re-arms its own pane recorder now. Each pane's bytes reach the dashboard through a small writer process tmux pipes the pane into; if something kills just that writer (an OOM pass is the usual culprit) while the pane itself keeps running, tmux still reports the pipe as on, the log stops growing, and every viewer sees a frozen terminal with a live pane behind it. The exit watcher already touches every supervised pane, so it now asks the honest question on that same beat: if the pane's screen moved and its log did not, repeatedly, for a couple of minutes, the writer is dead, and the watcher re-arms the pipe on the same log file. A quiet pane and a healthy writer both cost nothing beyond a periodic look, and the re-arm waits out three strikes so no single race spends one.

---
"@internal/node": patch
"@internal/desktop-client": patch
---

The node's own log file is `logs/daemon.log` where it was `logs/agent.log`, the name matching the word. Nothing migrates the file: every reader (the plane's log view, the machine's loopback dashboard, `subshell status`, reset, the desktop app) falls back to the old name until the daemon has written the new one, so an upgraded node shows its history from the first poll rather than after its first line.

---
"@internal/server": patch
---

A pane terminal could freeze while the pane itself kept running: when the node's byte stream to the browser died, every device watching that subshell kept seeing the same stale screen, typing echoed nothing, and the state lasted until the server restarted. The dashboard builds one output pump per subshell and hands it to every later viewer, and a pump that went silent (a refused tail start, a relay that stopped delivering) never said so. Now it does: the server logs the failure, drops that pane's viewers with the retry close, and the re-attach that follows builds a fresh pump at the current end of the log. A shared pump also gets a watchdog: if the pane's log grows while the stream has delivered nothing for 25 seconds, the pump is declared dead the same way, and a genuinely quiet pane is left alone because the verdict compares the log's size against what the pump actually delivered.

The workspace header's actions menu now offers the **Diagnostics** toggle for the focused pane, the same per-device HUD the subshell page has had since Wave C. It floats over the dock terminal the header stands above and reports the socket state, reconnects, viewers, input echo timings, and when the last pane byte arrived, which is what you want on screen while a terminal is misbehaving.

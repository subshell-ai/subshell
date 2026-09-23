---
"@internal/server": patch
---

Terminal typing over slow links is no longer serialized at one burst per round trip: the input queue flushes coalesced keystrokes on a 30 ms window and pipelines up to 8 unacked frames. Measured on a WAN node (83 ms RTT, ~350 ms acks), twelve keystrokes typed 30 ms apart went from 687 ms to fully pipelined delivery; LAN behavior is unchanged. The pane diagnostics HUD shows Echo p50, Echo max and Oldest on their own rows with Viewers above Output, and the API-key reveal dialog wraps the key instead of overflowing.

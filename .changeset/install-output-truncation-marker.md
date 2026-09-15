---
"@internal/server": patch
---

An agent install whose output overflows says so again.

Installer output is capped at 64 KiB, and a longer run is meant to end in
`[truncated]` so the setup screen tells you the log is not the whole story.
The counter deciding that only advanced while it was still under the cap, so
it could report "we filled up" but never "there was more" — and since a pipe
hands over power-of-two sized reads against a power-of-two cap, landing
exactly ON the limit is the common case, not the rare one. A chatty installer
therefore dropped everything past 64 KiB in silence, which reads as an
installer that stopped talking rather than a log that was cut.

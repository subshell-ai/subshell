---
"@internal/server": patch
---

Fixed the node installer's `curl ... | bash` one-liner stalling silently at a real terminal: it no longer moves the script's own standard input onto the terminal, which used to strand the still-unread tail in the pipe and end the run with the binary installed but the node never enrolled. A re-run after a failed install also no longer re-fetches the roughly 100 MB binary when the already-installed one matches the server's announced checksum; it says so and goes straight to enrollment. Any problem with that probe falls through to the normal download path.

---
"@internal/server": patch
---

Terminal input now queues and retries on reconnect: keystrokes are acknowledged, retried if the connection drops, and large pastes are chunked so no frame exceeds what a node accepts. The node also stops queueing your typing behind its other work, so keys land while captures and probes run.

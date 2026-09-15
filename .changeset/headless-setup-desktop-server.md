---
"@internal/desktop-server": patch
---

The first-run assistant passes `--no-service` to `subshell-server init`, which
now offers to install the service itself. The app keeps installing it with its
own autostart choice, so nothing about the assistant changes; without the flag
it would ask a question the assistant had already answered.

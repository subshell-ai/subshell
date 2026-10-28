---
"@internal/server": patch
"@internal/desktop-server": patch
"@internal/docs": patch
---

Revoke cached terminal access when subshell shares change, including connections still attaching and queued input retries. Recipients reconnect through the current access checks; the owner's terminal stays connected. Document the cutoff and the limits for commands already dispatched.

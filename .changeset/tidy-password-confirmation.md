---
"@internal/server": patch
---

Mask passwords during admin resets and require matching confirmation before submitting. Clear both fields on cancellation and after a successful reset without displaying the password, and keep submission disabled when the empty form is reopened.

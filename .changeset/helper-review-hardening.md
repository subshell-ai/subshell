---
"@internal/desktop-client": patch
"@internal/desktop-server": patch
"@internal/server": patch
---

Verify the installed display helper before opening it even when an update is blocked by another running helper. Preserve executable permissions when staging the helper, harden its bundled page's HTML escaping and native message boundary, and keep its state and menu updates consistent.

Recover terminal grid changes that happen during the reconnect cooldown.

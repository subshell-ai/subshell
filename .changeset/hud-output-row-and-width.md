---
"@internal/server": patch
---

The pane diagnostics HUD's Output row was lying on attached agent panes: it read the row's `lastOutputAt`, which travels only with live-feed broadcasts (domain events), so it could say "3m ago" while echo landed with every keystroke. It now leads with when the last pane byte arrived on THIS socket — `live`, then a real age — falling back to the server's stamp only with no socket, and reading `waiting…` when the socket is up but silent. The plate is also a fixed width with steady digits, so rows appearing and value strings changing length no longer resize and jitter it under the reader's eye.

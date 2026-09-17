---
"@internal/desktop-server": patch
---

The Set Up screen now names the address the dashboard will run at — a "Dashboard URL" row above the supervision question, showing the chosen base URL when one exists and the CLI's own `http://localhost:<port>` derivation otherwise. It is live: typing a new port under "Customize port and addresses…" moves the row with every keystroke, without the re-render that would take the cursor out of the field. This is the deleted plan rows' address half returned by request (operator's call): the install row stays gone, and what came back is not a promise of what setup will do but the address the reader dials afterwards.

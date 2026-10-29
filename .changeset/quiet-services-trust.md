---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
"@internal/website": patch
---

Add an explicit per-service option to ignore HTTPS certificate validation for trusted services with self-signed or mismatched certificates. Keep validation enabled by default and show when a saved service opts out. Web previews no longer show unrelated virtual-display warnings.

Keep the preview icon neutral until discovery finds a live item the viewer can select.

Configure discovered apps in a second step, optionally save them by name, and edit custom services with the same options. Add an explicit browser-only sandbox opt-out with a gold explanation of the account access it grants.

Refresh the documentation and website alongside the app release.

Add explicit Ctrl+Home and Ctrl+End mobile controls for conversation jumps in Codex, alongside ordinary Home and End.

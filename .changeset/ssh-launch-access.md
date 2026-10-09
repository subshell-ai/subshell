---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Use existing machine launch access for SSH connections and key relays, with explicit per-connection key selection. Remove separate SSH grants and approval requests, retain destination trust, and close relays when machine launch access is revoked. Expose server-derived SSH readiness and configuration capabilities to clients. Requires node protocol 19 and Subshell node 1.5.0 or later.

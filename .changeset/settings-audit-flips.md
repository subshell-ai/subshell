---
"@internal/server": patch
---

PATCH /api/settings now audits every real `allow_registrations` flip (actor + from/to) — the toggle that opened sign-up on a live instance left no trace during the 2026-09-03 deploy-bot incident. The terminal dead-panel's Close button (frontend) is now owner-only, matching the actions menu.

---
"@internal/server": patch
---

Take the fixes for advisories published 2026-10-23: undici 7.30.1 on the
server's Expo push path (EventSource memory DoS, and a subresource-integrity
bypass via non-lowercase algorithm tokens). The same date's fast-uri,
undici@8, and happy-dom hits are dev-time only (commit tooling, the e2e
container client, and the test DOM), so they are fixed too but ship nothing:
fast-uri 3.1.9 and undici 8.12.3 come in as root overrides, and the test
harness moves to @happy-dom/global-registrator 21.0.4, whose transition
support makes two popup unmounts land a tick later in tests, now awaited.

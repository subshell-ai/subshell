---
"@internal/desktop-server": patch
---

Re-cut bundles the 0.14.0 server binary, so Subshell Server desktop users get
this release's dashboard work — the sidebar grouped by machine, the row
tooltips, and the header's status dot. The app itself is unchanged; what moved
is the server it ships, which is the only server these installs ever get
(spec 2026-09-18: the app ships the server it installs).

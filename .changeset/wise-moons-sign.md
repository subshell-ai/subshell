---
"@internal/server": patch
"@internal/client": patch
---

macOS release binaries are now Developer-ID signed and Apple-notarized by CI,
so a browser-downloaded `subshell-server-darwin-*` / `subshell-darwin-*`
passes Gatekeeper with the ordinary one-time "downloaded from the internet"
confirmation instead of the "is damaged and can't be opened" refusal.

---
"@internal/desktop-server": minor
---

Renamed from `@internal/desktop` now that there are two desktop apps — this one
wraps the server, and the new `@internal/desktop-client` wraps a node agent.

**Releases now carry the tag prefix `desktop-server-v`** instead of `desktop-v`.
Existing `desktop-v*` releases are unchanged.

Nothing user-facing about the app itself changes: the bundle identifier,
product name, artifact names and the settings file are all deliberately
untouched, so an installed copy upgrades in place and keeps its settings. The
Rust it shares with the new app moved to `crates/desktop-core`, and one settings
key was renamed with a back-compatible alias.

---
"@internal/server": patch
---

A hung directory read can no longer wedge the server: the file picker's
walks run off the event loop on a shared ten-second budget, and a read
that fails to answer comes back as a bounded "this directory could not
be read" panel with Go up one level and Start over instead of a frozen
tab. An unreadable directory says so and keeps the favorites and recents
you can still reach, and every listing is sorted alphabetically
(natural numeric order) wherever it is served from.
@internal/desktop-server rides the bump automatically: it bundles this
server binary, and that is how the fix reaches a desktop-hosted
instance.

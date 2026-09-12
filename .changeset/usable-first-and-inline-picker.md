---
"@internal/server": patch
---

The profile dialog's Harness picker lists what is installed first, matching the launch pickers — on a fresh machine the one selectable row used to sit under four "(not installed)" ones. The ordering rule is now one shared, tested function rather than a copy per picker. The directory picker's panel also flows inline instead of floating: inside a dialog it is a child of a scroll container, which clipped it, so browsing for a working directory showed a panel cut off at the dialog's edge.

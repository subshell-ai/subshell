---
"@internal/desktop-server": patch
---

The permissions screen stops lying about Photos on a Mac that was never asked. macOS can answer `restricted` (a profile, Screen Time, or a machine with no Photos library yet): the row now says "Blocked" with no button, because System Settings holds no row to toggle, instead of "Not allowed" with a door to an empty pane. Also: the permissions rows' right-hand layout is restored. The comment above `.permission-side` in the stylesheet was unclosed since the screen's first commit, so every build until now shipped without the rule that stacks the state word above the button, and the words sat against the button edge. The darwin release smoke now asserts the four usage descriptions reached the bundle's Info.plist.

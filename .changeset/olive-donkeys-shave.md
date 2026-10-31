---
"@internal/server": patch
---

Fixed returning to a workspace landing you on the last tab instead of the one you were reading. A second device's stale layout save can no longer drop a tab from the arrangement, and a tab the dock has to re-append no longer steals your focus.

Dragging a subshell from the sidebar onto a workspace now works on the iPad with a Magic Keyboard. iPadOS Safari starts no HTML5 drag from a trackpad, so rows gained a pointer-event transport that arms the same drop zones and files the same pane; desktop drag-and-drop is untouched.

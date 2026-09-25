---
"@internal/server": patch
---

Fix the desktop subshell page treating a mouse text-selection drag as a swipe: highlighting across the terminal could jump to a neighbouring subshell on mouse-up. The prev/next swipe recognizer now accepts only touch pointers (its `pointer: { touch: true }` config silently bound mouse events on browsers without touch support).

---
"@internal/server": minor
---

The sidebar now appears from 683px of viewport width instead of 1024px, so a window that is too narrow to tile a workspace still keeps its navigation. The two were one number, which meant a window had to be wide enough for a split workspace before it was allowed to show where you are. Below 683px the hamburger drawer takes over as before — that is where a 240px rail starts costing more than a third of the window.

Phones and tablets are unchanged: a touch-primary device keeps the drawer until 1024px either way, since a rail beside a phone-width page leaves a strip of content and a finger wants the drawer regardless.

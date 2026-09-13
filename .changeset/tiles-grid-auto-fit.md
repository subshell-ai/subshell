---
"@internal/server": patch
---

Subshell tiles are now one fixed size rather than stretching to divide the row. Widening the window used to shrink a card — crossing into a second column split the row under the single card that was there, so a bigger window gave you a smaller tile. Only the number of tiles per row changes with the window now; each one stays the same size wherever you see it.

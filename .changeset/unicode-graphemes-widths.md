---
"@internal/server": patch
---

Terminals measure text by grapheme cluster now, via the unicode addon VS Code donated upstream. A ZWJ family emoji is one cell and CJK and modern emoji keep their real widths, so wide output stays column-aligned instead of drifting. Tap-to-open in copy mode reads the buffer's own cell widths instead of a private table, so it stays correct for whatever the terminal laid out.

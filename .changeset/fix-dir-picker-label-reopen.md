---
"@internal/server": patch
---

Clicking a field's "Working directory" label now closes an open folder picker instead of bouncing it back open. One label click was two events: the click outside the panel closed it, and the browser then forwarded the label's activation click to the input, which reopened it.

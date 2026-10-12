---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Explain why disabled buttons are unavailable on hover, keyboard focus, or touch. Highlight owner-only restrictions and service prerequisites in gold, and use form validation messages to explain missing input.

Show status as soon as server and node updates start, and fetch node progress while the update request is pending. Keep progress gold until completion is confirmed, and hide the previous attempt's result when a new update starts.

Avoid mounting tooltips for controls without an explanation, preserve focus when an explanation clears, and show the specific maintenance restriction in the mobile node picker.

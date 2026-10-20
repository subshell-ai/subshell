---
"@internal/server": patch
---

Stop showing a terminated subshell's reported-child branch marker in the sidebar and on its detail page. A stopped pane's cached agent snapshot could outlive the pane itself (the shared poll stops once nothing watches it), so the branch mark and the child rows sat on screen indefinitely; the surfaces now render nothing while the parent isn't running.

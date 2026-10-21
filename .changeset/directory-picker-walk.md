---
"@internal/server": patch
---

The folder picker now pages through huge listings instead of stopping at the first thousand entries. It walks the server's cursor as you scroll, virtualizes the rows so a 30,000-folder directory stays smooth, says so when a browse hit the server's cap, and stops re-replaying a walk every time the picker reopens. Starring a folder updates the cached listing in place instead of refetching every page.

---
"@internal/server": patch
---

Dialogs and drawers scroll again on the iPhone. A tap-selected option can leave iOS focus on the page body, and the terminal's scroll pin read that as an idle page and snapped an open dialog's own scroller back to the top the moment a form grew past its height cap. A scroller inside an open modal is now exempt from the pin, by surface rather than by focus.

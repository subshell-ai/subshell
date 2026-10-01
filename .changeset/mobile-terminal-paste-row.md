---
"@internal/server": patch
---

Put mobile terminal controls on one horizontally scrollable row with a native scrollbar. Add direct clipboard paste and a copy/input mode toggle, with confirmation when switching from the bar or action menu.

Allow the bar to scroll while the terminal is focused on iOS. Place Esc, arrows, Enter, newline, image upload, and scroll controls before the remaining controls.

Move confirmation toasts to the top of the screen and match their surface, typography, and status icons to the app theme.

Preserve the button bar's layout and scroll position in text copying mode, disabling input controls rather than hiding them.

Show a pressed highlight on terminal controls while held and briefly after a tap.

Add a refresh button to redraw the current terminal screen without restarting the session.

Add an Inject prompt button that opens the existing prompt picker and confirmation flow.

Group Page Up and Page Down with the top/bottom history controls, separated from the other buttons by dividers.

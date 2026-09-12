---
"@internal/server": patch
---

Starting a subshell and creating a profile are dialogs now, not pages. `/new` used to render a second copy of the launch form as a full-page card — same title, same fields, same buttons as the dialog the rail already owned — and the Profiles page pushed its list down to make room for a create card. Both raise a dialog over the page they belong to. `/new` still works as a deep link; it opens the dialog and hands the page under it to the subshells list.

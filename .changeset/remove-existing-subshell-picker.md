---
"@internal/server": patch
"@internal/docs": patch
---

The Add a subshell dialog now only launches a new subshell. Existing subshells join a workspace by selecting them in the sidebar or dragging them in, so the picker and its search box are gone. New workspace asks for a name up front, follows the server's 120-character rule, and creates the workspace empty.

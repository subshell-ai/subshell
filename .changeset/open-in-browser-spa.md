---
"@internal/server": minor
---

"Open in browser" in the dashboard, from two places: a row at the bottom of the
sidebar that opens whatever route you are on, and an item in a subshell's
actions menu (the ⋯ menu and the sidebar's right-click menu) that opens that
subshell. Both appear only inside a desktop app — a browser tab already is the
browser — and both hand the page to your default browser, with your profile,
your password manager and your extensions. You will be asked to sign in there,
because a browser carries no session from the app's window.

Under it, the SPA learned that there are two desktop apps rather than one.
Chrome that belongs to Subshell Server — the overlay title bar, the server
pill, native notifications, and the update, reset and supervision cards — is
now gated on being inside THAT app specifically, so none of it appears in
Subshell Client's window, where the commands behind it do not exist.

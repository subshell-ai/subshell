---
"@internal/desktop-server": minor
"@internal/server": patch
---

The first run on a Mac now says what macOS will ask and why — Notifications,
Files and Folders, Photos, and the Background Items banner — requests the one
the app owns, and never blocks on the answer. A permission that is missing is
named at the moment it bites: a banner when a "waiting for you" notification
could not post, a notice when the image picker opens with Photos blocked, and
"Blocked by macOS" in the directory picker when the server cannot list a
folder. Each carries a **Fix…** that opens the assistant, where a declined
permission offers **Open System Settings**. Preferences → Notifications shows
the live macOS state.

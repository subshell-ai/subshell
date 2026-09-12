---
"@internal/server": minor
"@internal/desktop-server": minor
---

A sidebar item can be a group now — a label with a chevron that opens to pages — and both navigations use one.

In the web UI the admin pages are one **Server Settings** group: General, Users, API keys, Plugins, Status, Audit log. The old Instance page was a scroll of unrelated cards, so it split: system API keys and the audit trail are pages of their own, the local-launch switch moved to the control-plane host's own node page beside its allowed directories, and Plugins is in the rail instead of behind a header button. Users joined the group, and a member's rail no longer lists it — the roster stays readable by URL and in the sharing picker. No route moved.

In Subshell Server's console, Addresses is a setting, so it sits under a **Settings** group with the tray and reset section, which is now called **Application**. Overview, Logs and About are unchanged.

A group follows where you are: it opens when you are on one of its pages and shuts when you leave, and the chevron overrides that until you navigate again.

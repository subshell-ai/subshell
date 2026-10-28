---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Fix web previews losing asset bytes during large responses and HTTP reader handoffs, and keep Next.js runtime chunk loading working through rewritten URLs. Refresh replaced Turbopack stylesheets in Chromium previews so CSS edits take effect without reloading the page. Only offer discovered ports that serve websites, even when the pane's process tree holds dozens of idle sockets, show available page titles in the picker and tabs, and keep unexpected downloads inside an error page that still remembers the cookies they carried so the app stays signed in. A server answering `application/xhtml+xml` counts as a website, so those pages preview again, and a response that names no type at all is painted rather than refused. Discovery now travels on node protocol 26, so update each node alongside the server.

Route alternate-screen history buttons to the running program. Use matching device and preview count badges, move ownership notices beside the action menu, and make their explanations available by tapping.

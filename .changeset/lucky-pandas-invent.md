---
"@internal/desktop-server": minor
---

The Subshell Server console is four sections behind a sidebar, not one scroll of cards.

Everything used to be on screen at once: a small status chip over a nine-row
fact list, the action card, the tray checkbox, a log pane and a danger-zone
disclosure. The window now opens on **Overview**, where a status hero says
whether the server is running, which version it is and where to reach it, with
its actions directly underneath and the diagnostic facts below them.
**Addresses**, **Logs** and **Settings** are their own sections in a sidebar.

- Editing addresses is a place you can go from anywhere rather than a button
  that replaced the page's one card, and it explains itself when a machine has
  nothing to configure yet.
- The log pane fills its section instead of being capped, and a command's
  output no longer competes with the buttons: each press reports its outcome on
  one line, with a link to the full output.
- The reset confirmation covers the whole window, so nothing can be navigated
  out from under it.
- The window opens at 900x640 rather than 720x620.

**About** is a new section: the Subshell wordmark, the app and server versions,
links to the website, the licence and the company, and the copyright. Its links
open in your own browser rather than inside the app.

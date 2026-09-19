---
"@internal/desktop-server": minor
"@internal/desktop-client": minor
"@internal/server": minor
---

Updating, and getting back in when an address change locks you out.

**The update screen is a table you choose from.** It used to push both halves
of an update whenever either was behind, which was wrong on a machine whose
`subshell-server` had been updated by hand: the screen offered to install an
older one. Now each component is a row — what it runs, what it would become,
and a checkbox where there is something to do or a short reason where there is
not — with one Force box below for the restart that would take live panes with
it. It can never install an older server over a newer one.

**A sign-in the server accepted no longer fails silently.** Setting an https
address for the instance makes its session cookies Secure, which a plain-http
page cannot keep — so the sign-in worked and the browser dropped it, and the
form simply came back. The page now says what happened and how to get in.

**The desktop app can reach a server behind a login proxy.** Its window
follows the sign-in to the identity provider and back; what the page is allowed
to ask of the app is recomputed for every page it lands on.

**And the app can edit its own addresses.** An https address signs the app's
own window out for good, and that value could only be changed from the page
that now needs the session it just lost. The assistant gets a Server Addresses
screen, reachable from the tray with the server down, stopped, or refusing
every sign-in.

Also: a pane whose title carries terminal escape sequences is named properly
instead of showing the raw sequence, and inside Subshell Server the Updates
page shows the app and the server it ships as one row with one button.

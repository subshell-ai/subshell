---
"@internal/desktop-client": minor
---

**Subshell Client is now a client.** It opens the control plane's own UI in a
native window — point it at a server's address and that is what you get — and
registering this machine as a node moved into a second window, reached from the
tray ("This machine…") and shown on a fresh install before an address is
settled.

That second window existing is the whole "node functionality" toggle: a client
you only watch subshells from never opens it, and there is no mode flag for the
two halves to disagree about. The address is remembered, and is picked up
automatically from an existing enrolment.

The window showing the plane's page is granted **no Tauri commands at all**. A
control plane can live on any host, so its origin cannot be pinned in a
capability file the way `apps/server/desktop` pins its own loopback server —
so rather than widen anything, that window gets nothing, carries no
desktop-shell user-agent marker, and is still pinned by `on_navigation` to the
origin it opened with. Enrolment, agent installation and service control stay
on the bundled page, which the plane cannot reach.

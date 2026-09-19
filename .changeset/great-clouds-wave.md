---
"@internal/server": minor
---

A version line in the sidebar, with a dot when an update is waiting

The browser rail now carries **Subshell Server &lt;version&gt;** in its footer.
It had none — the existing line reports the desktop app's own bundle version
over IPC, and a browser is inside no app, so there was nothing for it to say.
The server's version is a different fact and is not privileged: every
signed-in user can read it. Admins additionally get an amber dot when a newer
server is published, and the row opens the Updates page; a member gets the
line alone, since only an admin can act on it.

Inside Subshell Server the update row is now one line in both states: the
version, with the same amber dot when a newer build exists. It was a plain
line when nothing was known and a two-line block with an Update button and a
dismiss × when something was — two shapes for one fact, and the quiet one led
nowhere. Pressing the row does what the button did, so with nothing loud left
there is nothing to dismiss.

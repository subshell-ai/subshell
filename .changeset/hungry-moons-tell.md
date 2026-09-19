---
"@internal/server": minor
---

The sidebar's version line opens the update screen

Inside Subshell Server, **Subshell Server app 0.10.1** in the sidebar footer is
now a button: admins land on the Updates page, everyone else on the update
assistant. It said the version and led nowhere, which was the last place in the
app where knowing it did you no good — "no update known" is not "up to date",
since the daily check may not have run today, and what it opens finds out.

It says "app" because that is the application's own version. The server it
manages versions separately, and a browser's sidebar now names that one
instead.

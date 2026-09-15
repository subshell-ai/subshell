---
"@internal/server": minor
---

The user roster is a dedicated admin page at `/settings/users`, and adding a user is a dialog opened from its header. The dialog asks with the same form the first-run setup uses (name, email, password, confirmation, the password rule stated up front) plus a role. `POST /api/users` now takes a `name`, and the roster returns one. The old `/users` page is gone.

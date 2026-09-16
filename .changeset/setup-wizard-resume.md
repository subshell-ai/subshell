---
"@internal/server": patch
---

Reopening the app resumes the first-run wizard where it left off

Closing Subshell Server mid-wizard and reopening it landed on the dashboard.
The wizard's step lived only in React state, and the one persisted fact —
"does an account exist" — flips the moment the FIRST screen creates the
account, so every later step had no record anywhere and the wizard bounced a
returning visitor to `/`.

A signed-in user now carries a per-user bookmark (`user_meta.setup_step`:
`network`, `agent` or `launch`, NULL for nobody-but-the-first-admin and for
anyone who finished). `promoteFirstUserAtomically` writes it in the same
statement that decides who is admin, so closing the app the instant the
account exists still resumes on the Network step, and the wizard advances and
clears it through `GET`/`PATCH /api/setup/progress` — cookie-only, the
caller's own row. The root shell holds first paint until a signed-in user's
bookmark reads and keeps them on `/setup` when it names a step; a signed-in
visitor with no bookmark is still bounced to the dashboard.

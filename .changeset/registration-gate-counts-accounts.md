---
"@internal/server": patch
---

The registration gate counts ACCOUNTS, not `user_meta` rows

"Has anybody registered yet" decides three things: whether an absent
`allow_registrations` row means open, whether `GET /api/setup/status` still
reports `needsSetup`, and whether the first-run `/api/setup/*` window is
public. All three counted `user_meta`, which is a ROLE side-table written by a
separate better-auth `after` hook, rather than the accounts themselves.

Nothing was reopened by this in practice, and the fix is worth describing
precisely rather than alarmingly. The two tables do diverge on every instance
— `ensureSystemUser` INSERTs straight into `user` and mints no meta row — but
that divergence is in the safe direction, so a healthy instance's gate behaved
correctly. What the old counter could not survive was a REAL account whose meta
row was missing: it would have read as an empty instance, reopening
registration and re-publishing the public setup window with no settings row and
no audit event to show for it. A latent hole, closed before anything grew into
it.

One counter now answers the question — `UsersRepository.countRealAccounts()`,
over `user`, excluding the service account, which can never sign in — and the
registration gate, the setup probe, the boot handoff line and
`subshell-server status` all read it. `UserMetaRepository.countUsers()` is
gone; a second "how many users" counter is exactly the drift this closes.

`subshell-server status` also stops calling a readable database unreadable: it
reads better-auth's `user` table now, which is created one line later at boot
than the app tables, so a boot that died between the two is reported as an
instance with no admin account rather than as disk corruption.

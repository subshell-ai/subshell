---
"@internal/server": patch
---

The registration gate counts ACCOUNTS, not `user_meta` rows

"Has anybody registered yet" decides three things: whether an absent
`allow_registrations` row means open, whether `GET /api/setup/status` still
reports `needsSetup`, and whether the first-run `/api/setup/*` window is
public. All three were counting `user_meta`, which is a ROLE side-table
written by a separate better-auth `after` hook — not the accounts themselves.

The two already diverge on any instance that has ever minted a system API key:
`ensureSystemUser` INSERTs straight into `user` and creates no meta row. A
`user` row whose meta row was missing for any other reason therefore read as an
empty instance, silently reopening registration and re-publishing the setup
window on a server that has real accounts.

One counter now answers it — `UsersRepository.countRealAccounts()`, over
`user`, excluding the service account, which can never sign in — and the
registration gate, the setup probe, the boot handoff line and
`subshell-server status` all read it. `UserMetaRepository.countUsers()` is
gone; a second "how many users" counter is exactly the drift this closes.

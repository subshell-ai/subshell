---
"@internal/server": minor
---

`subshell-server update` and `subshell-server backup`, and the transaction that makes an update reversible

Until now there was no update path at all for a headless install: nothing ever
told an operator that a newer server existed, and nothing had ever copied the
database before running a migration over it. This is the foundation of the one
described in `docs/superpowers/specs/2026-09-15-updates-design.md` — the server's
own half; the dashboard, the node half and the desktop apps build on it.

**`subshell-server update`** installs a newer server over this one. It replaces
the binary the SERVICE DEFINITION names — never a path by convention, because
writing `~/.local/bin/subshell-server` on a host whose unit points elsewhere is
an update that reports success and changes nothing. Ten steps and nine of them
refusals: a checkout (update it with git), an unwritable directory, an empty
release source, a downgrade without `--force`, a transaction already open, a
downloaded binary that will not say what it is, and a restart that would close
every live subshell. `--check --to <version> --from <file> --force --yes --json
--no-restart --rollback`.

**The new binary finishes or reverts the transaction.** An updater process
cannot see the future boot, but the booting binary can see the past update — so
the backup, the `.previous` binary and a marker are written by whoever swaps,
and consumed by whoever boots. Migrations pass and the server listens: audited
(`server.update`, actor null), `.previous` and the marker deleted. Migrations
fail: the database is restored from the backup, the previous binary is renamed
back, the failure is recorded, and the process exits so the service manager
brings the old version up on the old database. That last part is not belt and
braces — Kysely refuses a database carrying migration names it does not know,
so an old binary cannot boot on a new database at all.

**`subshell-server backup`** takes a snapshot on demand: `VACUUM INTO` a single
file with no `-wal`/`-shm` beside it, 0600 in a 0700 `<dataDir>/backups/`,
newest `SUBSHELL_DB_BACKUPS_KEEP` kept (default 5, `0` = keep forever). Every
update takes one first.

**`status --json` gains `paths.binary`, `paths.backups`, `binary` and
`backups`** — which file an update would replace and how that was decided, and
what there is to roll back to. Nothing in TypeScript knew the first of those
before; only the desktop app's Rust read a service definition.

**`SUBSHELL_NODE_RELEASE_URL` is now `SUBSHELL_RELEASE_URL`,** with no alias:
the same release list answers for the server's own update, so the name stopped
being the node agent's. Empty still means air-gapped and still disables every
network fetch. Every app release now also publishes a `release-manifest.json`,
and the node release a plane offers is the newest one whose manifest says it
speaks this server's protocol — not merely the newest above the agent floor,
which could install an agent the plane cannot talk to.

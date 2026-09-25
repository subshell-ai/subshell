# Updating the server: the four modules, the measurements, and the boot-completed transaction. Moved verbatim from AGENTS.md ("Standalone binary & CLI" > "Updating the server"); AGENTS.md keeps the summary and routes here.

### Updating the server (spec 2026-09-15 §4)

**The new binary finishes or reverts the transaction.** An updater process
cannot see the future boot; the booting binary can see the past update. So
whoever swaps writes a marker, and whoever boots consumes it, which is what
makes the CLI path, the dashboard path (phase B) and the desktop path one
implementation rather than three that agree.

The four modules, and the one fact each exists for:

- **`services/releases.ts`** (was `node-release.ts`): one read of the release
  list, indexed by component, 15 min TTL. `resolveReleases()`,
  `refreshReleases()`, `compatibleNodeRelease()`, `fetchArtifact`/`fetchDigest`
  (unchanged `.fetched.json` semantics) and `downloadVerified()`, the
  hash-as-you-go download the server's own update shares with the node fetch.
- **`services/db-backup.ts`**: `VACUUM INTO` on a fresh READ-ONLY
  `bun:sqlite` connection, which yields a consistent single-file snapshot of a
  LIVE WAL database with no `-wal`/`-shm` beside it (MEASURED, §12.1, bun
  1.4.2 / SQLite 3.51.0). SQLite creates it with the umask, so the `chmod
  0600` after the vacuum is what makes the mode true. `<dataDir>/backups/`,
  0700, `SUBSHELL_DB_BACKUPS_KEEP` (default 5, `0` = keep forever, the
  `SUBSHELL_LOG_RETENTION_DAYS` spelling). It LOGS NOTHING: `backup --json`'s
  contract is one JSON line on stdout and LogLayer's console transport writes
  there too, so a log line here broke every parser (measured in `test:cli`).
- **`services/installed-binary.ts`**: which file on this host IS the
  installed server. The two readers from `apps/server/desktop`'s
  `server_bin.rs` ported to TypeScript: the systemd `ExecStart=` unquoting
  (the inverse of `service.ts`'s `systemdQuote`, last-wins) and the launchd
  `ProgramArguments` read through `plutil`, both plist locations, with the XML
  regex only as the no-plutil fallback. **A dev-form install records TWO
  tokens** (`[interpreter, script]`) and is reported as `source`; a reader
  that kept only the first would hand the updater a copy of `bun`. Then
  app-supervised (`process.execPath`, claim verified against the real parent),
  then a hand-run installed binary, then `unknown` with a reason. Exposed as
  `status --json`'s `paths.binary` and `binary`.
- **`services/update-transaction.ts`**: `<dataDir>/update/pending.json`
  (0600, written temp+rename immediately before the swap) and `failed.json`.
  `beginUpdate` refuses a second open transaction; the boot hook in `index.ts`
  reads the marker BEFORE the migrations, reverts on a migration failure
  (restore the backup, rename `.previous` back, write `failed.json`, exit 1 so
  the manager respawns the old version), completes AFTER `startServer`
  (audit `server.update` with actor null, delete `.previous` and the marker),
  and records a failure when the marker names a version this process is not.
  The swap's front half, `keepPreviousBinary`, hardlinks the RUNNING binary and
  where links are refused copies ATOMICALLY (temp + fsync + one rename; a
  truncated `.previous` can never exist as a rollback target), and BOTH paths
  that rename it back onto the live path PROBE it first (`<previous> version`,
  exit 0): `update --rollback` refuses outright when the copy cannot run, and
  the boot-time `revertUpdate` records `failed.json` and leaves the
  refused-to-migrate new binary in place rather than burying an unbootable copy
  at the unit's ExecStart path, where the manager could not exec it and the
  boot-revert logic (which lives in whatever boots) could not say so
  (round-3 review, finding 2; mirrored by the node's `update.ts`).

Three measurements the design rests on, each pinned or recorded where the code
that depends on it lives:

1. **`VACUUM INTO` from a second connection on a live WAL database** →
   `integrity_check: ok`, no sidecars, rows written after the vacuum absent.
   So the `BEGIN IMMEDIATE` + checkpoint + copy fallback is not implemented.
2. **`rename(2)` over a running compiled binary on macOS** leaves the running
   process alive and running to completion (unlike overwriting the bytes in
   place, which `crates/desktop-core`'s sidecar module documents as a
   SIGKILL). That is why both halves of the swap are renames, in one directory.
3. **Kysely refuses a database carrying migration names it does not know**:
   `migrateToLatest()` answers `corrupted migrations: previously executed
   migration … is missing` rather than ignoring the row (kysely 0.29.5).
   Pinned by `services/__tests__/update-transaction.test.ts`. It is WHY a
   revert restores the backup and not just the binary: an old binary cannot
   boot on a newer database at all.

`test:cli`'s `server-update.sh` is the only thing that proves the swap and the
boot-time completion with real binaries: it installs this build, compiles a
`99.0.0` one from the same source with a patched `package.json` (restored from
a trap), runs `update --from … --no-restart`, boots the new binary and asserts
the marker cleared, `.previous` gone and the `server.update` audit row written
with actor null. The migration-failure REVERT is deliberately NOT compiled
there (making a binary fail a migration on demand would mean a test seam
inside `db/migrate.ts`, production code that exists only to break), so that
half is a unit test on `revertUpdate`. What IS compiled is the other half of
the same hook: a marker whose binary never booted, recorded and cleared.

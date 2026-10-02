# Instance backups and offline restore

User procedure: [Backups and restoration](../../../docs/content/docs/administration/backups.mdx).

## Boundaries

`services/backups/` owns the streamed archive, encryption, validation, and offline
replacement. It takes explicit host paths and imports no auth/server state.
`journal.ts` must remain import-inert and reachable before constants/config/auth:
`loadConfigEnv` recovers interrupted replacement before applying the file layer.
Read-only status/help/version/license, service status, and restore inspection/list commands skip recovery so their promise of no destination
mutation stays true. A reused PID never decides exclusion; SQLite supplies the
OS-backed mutex. Recovery corrects matching inherited systemd EnvironmentFile
values after rollback while retaining differing explicit environment overrides.

Manual and pre-upgrade backups use the same full instance archive format.
Updates retain a private database checkpoint from the archive’s snapshot for
synchronous crash rollback; it is not listed as a user backup. Only the allowlisted server-owned components enter an archive. The
manifest describes SQLite snapshot/log interval consistency and exclusions.
Destination paths always come from the caller. Optional manifest `sourcePaths`
records original locations for restore form suggestions; it never selects an
engine destination automatically. Inspection reads address defaults from the
validated configuration payload and exposes only public form fields. Older
archives may omit source locations, with local fallback only for missing values.
Legacy `.db` is explicitly database-only and refuses all journal sidecars.

Config application preserves a hard link to the original, flushes it, and
atomically overwrites the target. Config rollback atomically overwrites too;
config.env must remain present because systemd reads it before starting the
server. Originals remain until successful serving boot. Finalizing cleanup is
recoverable and cannot roll back after originals have started to be removed.
`restore-result.json` records transaction ID and completed/rolled-back outcome.
Boot validates the actual database destination, and full restores also validate
data and config paths, against the journal before migrations or listening.
Completion follows all awaited boot initialization; failed boot stops the
listener before closing handles and rolling back.
Callers must match that ID; an absent journal alone cannot distinguish success
from rollback followed by a supervisor restarting the original instance.

Revoked session tokens also lose access through better-auth's cached cookie:
the fetch wrapper strips session_data only when its DB-backed session is
invalid, retaining unrelated OAuth and challenge cookies.

## Capture and runtime exclusion

The server holds `instance-state.lock` for its lifetime; offline application must
hold the same mutex after the server has stopped. Online capture takes the
separate `backup-capture.lock`, excluding cooperating config/plugin/key writers.
State-writer nesting shares one process-held mutex, allowing a network operation
to retain exclusion across await boundaries. Backup callers release capture in
finally. Restarters release both locks before asking supervision to boot.

The engine does not stop/start services, kill panes, install definitions, or
change autostart. Those acts belong to CLI/native supervision with explicit
replacement and pane-interruption consent. No API route applies a restore.

Native app-child restoration first uses `restore --prepare --json --no-start`:
archive, paths, addresses and optional admin credential are validated and kept
in a protected one-hour stage before the app stops its child. Prepared CLI
stages persist destination paths; apply refuses conflicting overrides.
`--discard-staged` removes only an OS-user-owned protected stage. Installed
service control remains in the CLI, whose manager identity proof precedes stop.

## Resource and confidentiality checks

Payloads stream through tar-stream3.2.1, gzip, hashes, and optional AES-256-GCM.
Decrypt/authenticate to private disk before parsing entries. Default ceilings:
16GiB stored/expanded, 8GiB individual file, 50,000 regular files; tighter
metadata bounds apply. The parser caps extended headers at4MiB. Do not replace
this with Bun.Archive.write(Bun.file): measured Bun1.4.2 emitted empty payloads.

SQLite inspection validates ordinary schema before materializing bounded rows
and scalars. Generated/virtual metadata, triggers, expression indexes, and
unvetted partial indexes are refused. The shipped workspace draft index has an
exact verified exception. Structural quick_check skips executable CHECK/index
recomputation; it does not claim full semantic validation of every uniqueness
or CHECK constraint. Offline admin recovery validates schema again before writes.
Plugin network/package JSON has a separate1MiB cap. Tests pin supported migration
level to the real boot provider.

Unencrypted archives include secrets. Outputs/files are0600 and owned staging
directories0700. Encryption passwords are not persisted in metadata. Settings
uses cookie-admin create jobs with single-use expiring downloads, not a backup
library; boot sweeps interrupted output. Multipart upload stays within the
existing128MiB request envelope; larger files use offline tools. Restore stages
expire after1hour and crash-incomplete stages age out. Temp login passwords are
hashed into staged SQLite only. Human sessions are revoked in prepared target
SQLite; pane bearer keys remain part of the restored identity.

## Recovery access

`backup_recovery` flags a selected existing human admin. Recovery optionally
enables email sign-in and a temporary credential, with no new admin creation.
Guarded APIs and terminal/live WebSocket admission deny ordinary human access
while flagged. Scoped pane credentials retain their existing permissions and
bindings. Better-auth passthrough allows only session read/sign-out while
flagged. The verified dedicated password
change endpoint removes the flag and sessions. The SPA holds its shell until the
recovery status answers, then shows the password-change form outside chrome.

## Verification

Engine tests cover archive roundtrips, unsafe input/resource boundaries,
committed WAL capture, required identities, migration publication disabling,
legacy behavior, interrupted subprocess replacement, atomic config continuity,
failed-boot WAL rollback, outcomes, and cleanup. Integration tests cover cookie
admin/ownership/expiry, recovery restrictions, forms and browser handoff. Never
exercise restore on the live instance; use isolated config/data/DB/TMUX roots.


Native integration uses two internal staged-restore flags: read-only
`--native-preflight` proves the installed service can boot the prepared exact
config/database/data destination before native supervision stops; `--native`
repeats this check during application, including with `--no-start`. This does
not change ordinary CLI offline alternate-destination restoration. Both paths
reuse `installedRestoreServicePaths`, including supported configuration override
refusals. Prepared public summaries expose `transactionId` (the owned stage UUID)
and `journalPath` before application. Staged application reserves that UUID in
the engine; direct archive application still generates an ID. A reserved ID
matching an existing receipt is refused before replacement so a consumed stage
cannot make a stale receipt confirm a new application. Native selection metadata
can therefore be written durably before the applying CLI process starts.

# Updates — design (2026-09-15)

How a person moves a Subshell installation from one version to the next: the
control plane (`subshell-server`), a node agent (`subshell`), and the two
desktop apps that wrap them. Today there is no update path at all except one:
Subshell Server installs the server binary it bundles over the one in
`~/.local/bin`. A headless install is never told a newer server exists, a node
is never told anything but "die" (`NODE_CLOSE_UPDATE_REQUIRED`), and nothing
ever backs up the database before a migration runs over it.

**Written to be implemented by someone who has not read the conversation that
produced it.** Every decision carries its reason; every route, verb, file,
flag and refusal is named. Where a fact could only be established by running
something, §12 names the measurement and what to do with either answer.

The operator's requirements, stated 2026-09-15 and not up for re-deciding:

1. Replacing an app with a newer copy must upgrade it.
2. Each CLI has an `update` verb that updates itself.
3. The web interface can upgrade the server and the nodes, and point at the
   desktop apps' updates.
4. Migrations run as part of an upgrade — and an upgrade whose migrations fail
   must not leave a broken instance.
5. The database is backed up before every upgrade, whenever there is one.
6. Updates come from the project's GitHub Releases.
7. `downloads.subshell.sh` may exist later; the design must not need it now
   and must not have to change when it does.

## 0. The shape in one paragraph

**Every component reads the same release list, and every install of a
binary is a transaction the new binary completes at boot.** One pure module
picks the newest release of a component by semver from the repository's tag
list (`server-v*`, `node-v*`, `desktop-server-v*`, `desktop-client-v*`), and
one server-side service fetches that list with a TTL. The server's `update`
downloads its own artifact beside the installed binary, verifies the
published digest, **backs up the database**, writes a marker, swaps the
binary with `rename(2)` keeping the old one as `.previous`, and exits for its
service manager to respawn it. The **new binary, at boot, either finishes the
transaction** (migrations succeed → audit, delete `.previous` and the marker)
**or reverts it** (migrations fail → restore the backup, swap `.previous`
back, record the failure, exit so the manager respawns the old version). The
same verb, driven by the dashboard, does the same thing in-process. A node
does the same without the database half, driven by its own CLI or by a
signed `update` command from the plane, and a node the plane refuses for its
version is **held** rather than dropped so the plane can still send it that
one command. The desktop apps update themselves with Tauri's updater plugin,
signed with a key the apps pin, and hand their bundled CLI to the CLI's own
`update --from` so the transaction and the backup are the same code on every
path.

## 1. What exists today (measured, with file references)

- **Release resolution, node only.** `packages/subshell-protocol/src/node-release.ts`
  is pure: `parseNodeReleaseTag`, `newestNodeRelease` (semver, never date —
  a re-cut of an old version publishes later than a newer one),
  `nodeReleaseAssetNames`, `parseSidecarDigest`. It reads the LIST endpoint,
  never `/releases/latest`, because four components share one repository and
  "latest" is whichever was cut last (measured today: `server-v0.6.0`, by
  seconds). `apps/server/api/src/services/node-release.ts` is the I/O half:
  `resolveRelease()` (15 min TTL, drafts skipped, refuses a release below
  `MIN_AGENT_VERSION`), `fetchArtifact(target)` (sidecar first, then the
  binary streamed THROUGH a hashing `ReadableStream` into
  `<path>.fetch-<pid>`, mismatch errors the response mid-flight),
  `.fetched.json` as the ownership record. `SUBSHELL_NODE_RELEASE_URL`
  (`constants.ts:185`), empty = air-gapped.
- **Restart, audited and refusing.** `POST /api/admin/server/restart`
  (`api/admin-server/restart.route.ts`): 409 `RESTART_UNAVAILABLE` unless
  `service.supervised` (manager's pid is ours, or a verified
  `SUBSHELL_SUPERVISOR*` parent — `services/server-deployment.ts:152,264`),
  409 `RESTART_KILLS_PANES` unless `paneSafety === "keeps"` or `force`.
  `performRestart()` (`services/server-restart.ts:43`) closes sockets with
  1012 and exits 0 after 250 ms; `Restart=always` / `KeepAlive=true` respawn.
- **Migrations at boot.** `index.ts:119` `await runMigrations()` (static
  provider map, `db/migrate.ts`) before `startServer()`. Kysely's migrator
  refuses a database carrying migration names it does not know, so an OLD
  binary cannot boot on a NEWER database — which is exactly why a rollback
  needs the backup, not just the old binary.
- **No backup primitive anywhere.** `grep -rn "VACUUM|backup"` finds two
  comments. `open-database.ts:31` sets `journal_mode = WAL`.
- **Nothing in TypeScript knows the installed binary's path.** `status
  --json`'s `paths` block (`commands/status.ts:112`) has no binary; only
  Rust reads `ExecStart` / `ProgramArguments`
  (`apps/server/desktop/src-tauri/src/server_bin.rs:76-160`). The trap that
  code names: a dev-form install records `[interpreter, script]`, so a reader
  must carry both tokens. `service install` bakes
  `deps.servicePath ?? process.execPath`.
- **The node already reports what an update must replace.**
  `ready.runtime.binaryPath` is `selfInvokePrefix().command`
  (`apps/node/agent/src/runtime.ts:87`, `self-invoke.ts:82`). The agent's
  `service` executor (`commands/service.ts:42-120`) has the restart contract
  every plane-driven verb reuses: answer `result` first, then
  `requestRestart()` exits 0 after 250 ms for the manager; refused
  `"not supervised"` when unsupervised and `"kills panes"` when
  `paneSafety !== "keeps"` without `force`, both failing closed.
- **A refused node is dropped.** `node-ws-handler.ts:297-313` persists
  `agent_version` BEFORE the gates, then closes 4406 when the version is
  below `MIN_AGENT_VERSION` or the protocol differs. The 2026-09-12 spec
  (§6.6) deferred plane-driven node updates for one reason: a node key can do
  nothing on REST (security §5.5), so the node has no credential for
  `GET /api/downloads/node/*` (`downloads.route.ts:51`, cookie or setup key).
- **The desktop apps replace their CLI from a bundled sidecar and nothing
  else.** `crates/desktop-core/src/sidecar.rs:135 install_bundled` (temp in
  the same directory, 0755, quarantine stripped, fsync, `rename`);
  `desktop_install_server` stops the service only when it points at the
  managed copy (`control.rs:835-868`) and the UI restarts afterwards
  (`ui/src/wizard.ts:893-899`); `node_install_agent` refuses a downgrade and
  deliberately does not restart. `decide_server` never downgrades because
  the migrator is forward-only. No `tauri-plugin-updater`, no HTTP client in
  Rust, no `latest.json`, no signing key. Both apps read their version from
  `package.json` via `tauri.conf.json`, and the SPA already parses the app
  version out of the UA marker (`lib/desktop.ts:84`) but uses only the `b=`
  bundled-server group (`components/service/update-card.tsx`).
- **Releases exist now** — `server-v0.6.0`, `node-v0.8.0`,
  `desktop-server-v0.6.0`, `desktop-client-v0.4.0`, all cut 2026-09-15, each
  with `<artifact>` + `<artifact>.sha256` + legal files. The repository is
  public; the release API answers anonymously.

## 2. Principles

- **One release source, one picker.** Every component resolves against the
  same list with the same pure code. The URL is the only seam: when
  `downloads.subshell.sh` exists it can serve a static mirror of the release
  API's JSON shape at that URL, and nothing here changes.
- **The new binary finishes or reverts the transaction.** An updater process
  cannot see the future boot; the booting binary can see the past update. So
  the marker, the backup and `.previous` are written by whoever swaps, and
  consumed by whoever boots. This is what makes the CLI path, the dashboard
  path and the desktop path one implementation.
- **Never write to a path the service does not run.** The installed binary
  is the one the service definition names, else the one this process IS, or
  nothing. Writing `~/.local/bin/subshell-server` by convention would be a
  file nobody executes and an update that reports success and changes
  nothing (the desktop app learned this: `Probe::decide` compares against the
  MANAGED copy only).
- **A stale node stays reachable for exactly one thing.** Held, not dropped,
  and only `update` may be sent to it. Everything else about it stays
  offline: `isNodeOffline` is untouched.
- **The two refusals travel with every restart.** Not supervised, and kills
  panes without `force`. An update is a restart with a file swap in front of
  it; it inherits both.
- **Verify before the first `chmod`.** As `install.sh` and
  `install-server.sh` already do. The digest comes from the same release as
  the bytes; what that proves is stated in §11, not implied.

## 3. Shared: releases and manifests

### 3.1 `packages/subshell-protocol/src/releases.ts` (replaces `node-release.ts`)

Pure, on the Metro-safe barrel. Generalize by component:

```ts
export type ReleaseComponent = "server" | "node" | "desktop-server" | "desktop-client";
export const RELEASE_COMPONENTS: readonly ReleaseComponent[] = [...];
export const RELEASE_TAG_PREFIX: Record<ReleaseComponent, string> = { server: "server-v", node: "node-v", ... };
export function parseReleaseTag(component, tag): string | null;   // strict X.Y.Z, prerelease refused (as today)
export function newestRelease(component, tags): ReleaseCandidate | null;  // semver, never date
export function releaseAssetNames(component: "server" | "node", target): { binary; sidecar };
export function parseSidecarDigest(text): string | null;          // unchanged
export const DEFAULT_RELEASE_API = `https://api.github.com/repos/${SUBSHELL_REPO_SLUG}/releases?per_page=100`;
export const RELEASE_MANIFEST_NAME = "release-manifest.json";
export interface ReleaseManifest { component; version; nodeProtocol: number; minAgentVersion: string; commit: string }
export function parseReleaseManifest(text): ReleaseManifest | null;
export function hostReleaseTarget(platform, arch): ServerTarget | null; // darwin+arm64 → darwin-arm64, linux+x64 → linux-x64, linux+arm64 → linux-arm64, else null
```

`per_page=100`: the default page is 30, and one version-PR merge can
publish four app releases plus seven npm releases, so 30 can miss a
component entirely. Keep the existing tests (`node-release.test.ts`) and add
the other three prefixes; `newestRelease` must ignore a tag of another
component that would parse as a newer version.

### 3.2 `release-manifest.json` — a fifth asset on every app release

Written by each of the four release scripts beside the artifacts and
published by the existing `files: dist/<app>-*/*` glob. Contents: the
component id, the version, `NODE_PROTOCOL_VERSION`, `MIN_AGENT_VERSION` and
the commit sha (`GITHUB_SHA` or `git rev-parse HEAD`). It exists so the plane
can answer **"is this node release compatible with me"** without downloading
a binary: the node release the plane offers is the newest one whose
`nodeProtocol` equals its own. A release without the manifest (the four cut
today) is treated as unknown and is **not offered** to nodes; the Updates
page says why. The published-name test in `desktop-paths.test.ts` ("every
name carries `cli` or `Desktop`") gains an explicit allowlist for
`release-manifest.json` and `latest.json` (§8); nothing else is exempt.

### 3.3 `apps/server/api/src/services/releases.ts` (replaces `node-release.ts`)

- `SUBSHELL_RELEASE_URL` replaces `SUBSHELL_NODE_RELEASE_URL` everywhere
  (constants, `settings.route.ts`'s `nodeArtifactsAutoFetch`, docs, the
  desktop app's env passthrough if any). No alias: there are no users to
  keep compatible (operator's standing ruling). Empty still means
  air-gapped and disables every network fetch in this spec.
- `resolveReleases(): Promise<ReleaseIndex>` — one fetch, one TTL (15 min),
  the whole list parsed into `{ byComponent: Record<ReleaseComponent, ResolvedRelease | null>, checkedAt }`,
  where `ResolvedRelease = { tag, version, assets: Map<name, url>, manifest: ReleaseManifest | null }`
  (the manifest asset is fetched and parsed on first use, memoized with the
  index). Drafts skipped as today. `refreshReleases()` busts the cache (the
  Re-check button; also the CLI's `--check`).
- `compatibleNodeRelease(): { release, reason }` — newest `node` release
  whose manifest's `nodeProtocol === NODE_PROTOCOL_VERSION` and version ≥
  `MIN_AGENT_VERSION`; `reason` names why none qualifies ("newest node
  release 0.9.0 speaks protocol 10; this server speaks 9 — update the server
  first" / "carries no release manifest").
- `fetchArtifact(target)` and `fetchDigest(target)` keep their behaviour and
  their `.fetched.json` manifest, now taking the release from
  `compatibleNodeRelease()` rather than "newest ≥ floor" — an enrolling node
  gets the version this plane can talk to, closing an existing hazard.
- `downloadVerified({ url, expectedDigest, destDir, destName })` — the
  streaming-hash download factored out so the server's own update (§4) and
  the node fetch share it. Writes `<destDir>/<destName>.download-<pid>`,
  hashes as it goes, refuses over `MAX_ARTIFACT_BYTES`, deletes on mismatch,
  returns the temp path on match. Never chmods.

## 4. Server: backup, transaction, `update`

### 4.1 `services/db-backup.ts`

```ts
backupDatabase({ reason: "update" | "manual", version = SERVER_VERSION }): Promise<{ path: string; bytes: number } | null>
```

`VACUUM INTO '<path>'` on a fresh read connection (`bun:sqlite`), which
yields a consistent single-file snapshot of a live WAL database with no
`-wal`/`-shm` sidecars — the shape `status.ts:234`'s comment already assumes
a restored backup has. Returns `null` when the database file does not exist
yet (a fresh install has nothing to back up; the caller says so rather than
failing). Path: `<SUBSHELL_SERVER_DATA_DIR>/backups/subshell-v<version>-<YYYYMMDD-HHmmss>.db`,
directory 0700, file 0600 (`chmod` after the vacuum; SQLite creates it with
the umask). Retention: after a successful backup, delete the oldest beyond
`SUBSHELL_DB_BACKUPS_KEEP` (default **5**, `0` = keep forever — the same
spelling as `SUBSHELL_LOG_RETENTION_DAYS`). `listBackups()` for the status
surfaces. `restoreDatabase(backupPath)`: delete `db`, `db-wal`, `db-shm`,
copy the backup into place, 0600 — used only by the rollback paths, only
while no connection is open (boot before `runMigrations()`, or the CLI).

CLI verb `subshell-server backup [--json]` prints the path and size; exits 1
with the reason when there is no database. `status --json` gains
`paths.backups` and `backups: { count, latest: { path, bytes, at } | null }`.

### 4.2 `services/installed-binary.ts`

```ts
resolveInstalledBinary(deps): { kind: "compiled"; path: string } | { kind: "source"; argv: string[] } | { kind: "unknown"; reason: string }
```

Order, each with the reason it is there:

1. **The service definition**, when one is installed: last `ExecStart=` of
   the systemd unit (unpicking `systemdQuote`), or `ProgramArguments` of
   whichever plist exists (both locations, `plutil -extract … json`, the XML
   regex only as the no-plutil fallback — the same two readers
   `server_bin.rs` has, ported). Two tokens → `source` ("this server runs
   from a checkout; update it with git"). One token → `compiled`.
2. **App-supervised** (`appSupervised()` true): `process.execPath` — the app
   launched this very file from its ladder.
3. **This process**, when `basename(process.execPath)` starts with
   `subshell-server` and it is not under `$bunfs`: a hand-run installed
   binary.
4. Otherwise `unknown` with a reason ("no service definition names a binary
   and this process is not an installed one").

The `compiled` path must be a regular file in a directory this user can
write, or `update` refuses with the path in the message. Exposed as
`paths.binary` (string | null) and `binary: { kind, reason? }` in
`status --json`, and as `update.binary` in `GET /api/admin/server`.

### 4.3 `services/update-transaction.ts` — the marker and the boot hook

Marker directory `<dataDir>/update/`, 0700.

`pending.json` `{ from, to, binary, previousBinary, backup: string | null, startedAt, origin: "cli" | "api" | "desktop", forced }`
— written by whoever swaps, temp+rename, immediately before the `rename` of
the binary. `failed.json` `{ ...pending, error, failedAt }` — written by
whoever reverts. `completed.json` is NOT a thing; success is audited and the
marker deleted.

`beginUpdate(input)`: refuses if `pending.json` exists ("an update is already
in progress; `subshell-server update --rollback` if it is stuck"); writes it.

Boot (`index.ts`, around `runMigrations()`):

```ts
const pending = readPending();
if (pending && pending.to !== SERVER_VERSION) {
  // The binary that was meant to boot did not; someone (the CLI, a hand) put an older one back.
  recordFailure(pending, `expected ${pending.to} to boot, ${SERVER_VERSION} did`); // moves pending → failed
}
try {
  await runMigrations(); await runAuthMigrations();
} catch (error) {
  if (pending && pending.to === SERVER_VERSION) { await revertUpdate(pending, error); process.exit(1); }
  throw error;
}
// after listen:
if (pending && pending.to === SERVER_VERSION) await completeUpdate(pending);
```

`revertUpdate`: `restoreDatabase(pending.backup)` when there is one (when
`null`, there was no database — nothing to restore, and the migration
failure is on an empty file; still revert the binary); `rename(previousBinary → binary)`
(only if `previousBinary` exists — if not, log that the operator must
reinstall); write `failed.json`; log at error with the migration error
flattened to a string. Exit 1: the manager respawns the previous binary on
the restored database. `completeUpdate`: `audit("server.update", { from, to, origin, forced, backup })`
with actor null (the booting process has no session; the START of an
API-driven update is separately audited with the admin as actor, §4.5),
`rm(previousBinary)`, `rm(pending.json)`, log one info line. `failed.json`
stays until the next `beginUpdate`, which moves it to `failed.previous.json`
(one level of history, no more).

### 4.4 `subshell-server update`

```
subshell-server update [--check] [--to <version>] [--from <file>] [--force] [--yes] [--json] [--no-restart]
subshell-server update --rollback [--yes] [--json]
```

Async, like `init` and `configure` (it prompts and it downloads); it is the
third named exception to the sync-exit house style and `AGENTS.md` says so.

1. **Where is the installed binary** (§4.2). `source` or `unknown` → exit 1
   with the reason. Not writable → exit 1.
2. **What to install.** `--from <file>`: the file must exist, be executable
   or made so on the temp copy, and answer `<file> version` with
   `subshell-server X.Y.Z` (the byte-identical machine contract) — that is
   its version, and there is no digest to check (a local file the operator
   or the desktop app chose). Otherwise the release source: refuse when
   `SUBSHELL_RELEASE_URL` is empty ("this host does not fetch releases; use
   `--from`"); `--to X.Y.Z` names a published release, else the newest
   `server` release. `hostReleaseTarget()` picks the asset; `null` (Intel
   Mac, anything else) refuses by name, as `install-server.sh` does.
3. **Compare.** Equal → "already at X.Y.Z", exit 0. Older than installed →
   refuse unless `--force`, and with `--force` warn that the database may
   not open under an older server (Kysely refuses unknown migrations) and
   that the backup is what makes it recoverable. `--check` stops here and
   prints `{ installed, latest, updateAvailable }`.
4. **Confirm** (unless `--yes`): from → to, the binary path, whether a
   service will be restarted, and the pane-safety sentence when
   `paneSafety !== "keeps"` (that restart needs `--force`, exactly as
   `service restart` does today).
5. **Download** to `<binaryDir>/<basename>.download-<pid>` via
   `downloadVerified` (release path) or copy (`--from`), then
   `chmod 0755`, then run `<temp> version` and require it to equal the
   version we think we are installing — a binary that cannot say what it is
   does not get installed.
6. **Back up** (§4.1). `null` → say "no database yet; nothing to back up".
7. **Transaction**: `beginUpdate`, `rename(binary → binary.previous)`,
   `rename(temp → binary)`. On any failure between the two renames, put
   `.previous` back and delete the marker.
8. **Restart**, unless `--no-restart`: service installed and running →
   `controlService("restart", { force })` with its existing refusal;
   app-supervised → "Subshell Server is running this server; restart it from
   the app" (exit 0, the swap is done); not running → "start it with
   `subshell-server service start`" (exit 0).
9. **Wait** (only when we restarted): up to 60 s for `pending.json` to
   disappear (success — print the new version) or `failed.json` to appear
   (print its error and that the previous version was restored). Neither
   → the binary never booted: perform the rollback ourselves (step 10) and
   exit 1 saying so.
10. `--rollback`: needs `<binary>.previous`; reads `pending.json` or
    `failed.json` for the backup path; confirms; stops the service if
    running; `restoreDatabase(backup)` when named; swaps `.previous` back;
    clears `pending.json`; restarts when it was running.

`--no-restart` is for the desktop apps (§7): they own the restart step
because in the app-supervised posture only the app can do it.

### 4.5 Routes (`apps/server/api/src/api/admin-server/`, cookie-admin, bearer refused)

- `GET /api/admin/server/update` →
  `{ source: { url, enabled }, current, latest: { version, tag, publishedAt } | null, updateAvailable, canApply: { ok, reasons: string[] }, binary: { kind, path?, reason? }, job: UpdateJob | null, lastFailure: FailedMarker | null, backups: { count, latest } }`.
  `canApply.reasons` is the union of every 409 below evaluated now, so the
  page can render a disabled button that says why. Reads the release index
  (TTL); never forces a network read.
- `POST /api/admin/server/update/check` → refreshes the index, returns the
  same view. Audited? No — a read.
- `POST /api/admin/server/update` body `{ version?: string, force?: boolean }` →
  202 `{ started: true, from, to }` and a job runs in-process. Refusals, in
  order, all 409: `UPDATE_SOURCE_DISABLED`, `RESTART_UNAVAILABLE` (not
  supervised — the same reason the restart route gives, because the swap
  without a restart would leave a running old process and a new file, and
  the marker would then blame the next boot), `UPDATE_BINARY_UNKNOWN`
  (`source`/`unknown`/unwritable, with the reason), `UPDATE_IN_PROGRESS`
  (`pending.json` or a running job), `UPDATE_NOT_AVAILABLE` (no newer
  release and no `version`), `UPDATE_DOWNGRADE` (`version` older than
  current — the API has no `--force` for this; the CLI does),
  `RESTART_KILLS_PANES` (unless `force`). Audit `server.update`
  `{ from, to, forced, origin: "api" }` with the admin as actor BEFORE the
  job starts; the boot-time completion audits again with actor null.
- The job (`services/server-update.ts`, module-level singleton): phases
  `downloading { received, total } → verifying → backing-up → swapping → restarting`,
  or `failed { error }`. Same steps 5–7 as the CLI, then `performRestart()`.
  A failure before the swap leaves nothing behind but the temp file, which
  it deletes; the job stays `failed` until the next start. The SPA polls
  `GET …/update` at 1 s while a job runs, then waits for the restart with
  the existing `use-server-restart` waiter and, on return, reads
  `lastFailure` to say whether the boot completed or reverted.

`GET /api/admin/status` keeps `versions.server`; it does NOT grow an update
field — the Updates page has its own read, and the status page is a
snapshot of what IS.

### 4.6 Fleet view in the same read: `GET /api/admin/updates`

One admin read for the page (§6): `{ server: <the §4.5 view>, nodes: { release: { version, tag } | null, reason: string | null, rows: NodeUpdateRow[] }, desktop: { server: { latest } | null, client: { latest } | null } }`
where `NodeUpdateRow = { id, name, agentVersion, target, online, held: { reason } | null, updateAvailable: boolean, canUpdate: { ok, reason? } }`.
`target` is derived from the node's reported `os`/`arch` with
`hostReleaseTarget`; `null` means "no artifact for this platform" and
`canUpdate` says so. `local` is excluded from `rows` — its update is the
server's.

## 5. Node: `update` from the CLI and from the plane

### 5.1 Protocol (`packages/subshell-protocol/src/node-frames.ts`, protocol 9 → 10)

Command `{ type: "update"; version: string; url: string; sha256: string; force?: boolean }`.
Result `{ ok: true }` then the restart, or `{ ok: false, error }` with the
existing constants (`NODE_RESULT_NOT_SUPERVISED`, `NODE_RESULT_KILLS_PANES`)
plus new `NODE_RESULT_NOT_COMPILED = "not a compiled agent"`,
`NODE_RESULT_DOWNLOAD_FAILED = "download failed"`,
`NODE_RESULT_DIGEST_MISMATCH = "digest mismatch"`,
`NODE_RESULT_VERSION_MISMATCH = "installed binary reports a different version"`.

**The `update` command's shape is frozen across future protocol bumps.** It
is the one command the plane sends to an agent whose protocol it does NOT
share (§5.3), so its parser on the agent side and its encoder on the plane
side must never change field names or meaning. A comment on the type says
so, and a test pins the wire shape as a literal.

Bump `NODE_PROTOCOL_VERSION` to 10 and raise `MIN_AGENT_VERSION` and
`apps/node/agent/package.json` to `0.9.0` in the same commit — the rule in
`versions.ts`. An agent below 0.9.0 answers `unsupported` to `update`
through the default branch, which the route maps to `NODE_AGENT_TOO_OLD`
("update this node by hand: `subshell update`").

`ready.runtime` gains nothing. The agent treats its update as **accepted**
when, after sending `ready`, it receives any frame from the plane or the
socket stays open for 30 s without a close — either means the gates passed
(a refusal is immediate). At that point it deletes `<binary>.previous` and
its `update-pending.json` marker (§5.2).

### 5.2 The agent (`apps/node/agent/src/update.ts`, `commands/update.ts`, `cli.ts`)

Shared `applyUpdate({ source, version, force, restart, origin })`:

1. Binary: `selfInvokePrefix()`; `args.length > 0` (bun + entry) →
   `NOT_COMPILED`. Directory not writable → error naming it.
2. Download to `<dir>/<basename>.download-<pid>` with streamed sha256
   against the expected digest (release sidecar or the signed frame); or
   copy from `--from`. `chmod 0755`. Run `<temp> version`; the first token
   after `subshell ` must equal `version` (`VERSION_MISMATCH`). macOS: no
   quarantine handling — `fetch` and `copyFile` set no xattr; the desktop
   sidecar is stripped by the app before it is offered (`sidecar.rs:194`),
   and the CLI copies from a path the operator names.
3. Marker `<dataDir>/update-pending.json` `{ from, to, binary, previousBinary, startedAt, origin }`.
   `rename(binary → binary.previous)`, `rename(temp → binary)`; on failure
   between, put `.previous` back.
4. Restart: plane-driven → the executor answered `{ ok: true }` already and
   calls `ctx.requestRestart()`; CLI → `controlService("restart", { force })`
   with its refusal, or "restart it where you started it" when not
   supervised. `--no-restart` skips it.
5. **Revert on refusal**: in the daemon's close handler, a close with code
   4406 while `update-pending.json` exists and `.previous` exists → swap
   `.previous` back, write `update-failed.json { ...pending, reason }`, log,
   `stop(1)` so the manager respawns the previous agent. Without a marker,
   4406 behaves as today. This is the node's whole rollback: it has no
   database.

`commands/update.ts` `execUpdate`: the two refusals first (unsupervised;
`paneSafety !== "keeps"` without `force`, failing closed on no report — copy
`commands/service.ts:51-86`), then `applyUpdate` with `restart: false`,
then return `{ ok: true }` and `ctx.requestRestart()`. The plane's
`DEFAULT_COMMAND_TIMEOUT_MS` is 10 s and a download is longer: `update`
uses a 5-minute timeout in `sendCommand` (a per-command override, the first;
add the parameter rather than raising the default).

CLI `subshell update [--check] [--to] [--from] [--force] [--yes] [--json] [--no-restart]` and
`subshell update --rollback`: source is the release API
(`SUBSHELL_RELEASE_URL`, default `DEFAULT_RELEASE_API`, empty → "use
`--from`"), newest `node` release, `hostReleaseTarget()`. The CLI cannot ask
its plane which version is compatible (no REST credential), so it prints:
"Your control plane's Settings → Updates shows the version it can talk to;
`--to` picks one." `status --json` gains `paths.binary` and
`update: { pending, lastFailure }`.

### 5.3 The plane: held nodes, the token, the route

**Held connections** (`services/nodes/node-registry.ts`): a second map,
`held: Map<nodeId, { ws, reason: "below-floor" | "protocol-mismatch", agentVersion, protocolVersion, os, arch, since }>`,
NOT `live`. `node-ws-handler.ts:297-313`: on either refusal, instead of
closing, `holdConnection(...)`, send nothing, and ignore every frame from it
except `result`. `isNodeOffline` and `listOnline` are untouched — a held
node is offline for every purpose but one. Newest-wins applies: a second
socket for the same node supersedes the held one (4409). A held socket that
goes 10 minutes without an `update` being sent is closed 4406 with the
message it gets today, and the agent's backoff loop reconnects and is held
again — so the plane never accumulates sockets it will not use, and the
agent's "update required" log line keeps appearing where an operator at the
machine would look. `getHeld(nodeId)` for the view and the route.

**The download token** (`services/nodes/update-tokens.ts`): in-memory
`Map<sha256(token), { nodeId, target, expiresAt, used }>`, token
`nut_<32 url-safe chars>`, TTL 10 minutes, single use, minted per `update`
command. `authorizeDownload` (`downloads.route.ts:51`) gains a third branch:
`?update_token=` valid, unused, unexpired and for THIS target → consume and
allow. A restart of the server forgets outstanding tokens; the agent's
download then 401s and it answers `DOWNLOAD_FAILED`, which the route
reports. The token is not a node key and confers exactly one download of
one file; security §5.5 stays true as written.

**`POST /api/nodes/:id/update`** body `{ force?: boolean }` — cookie only;
`local` → 400 ("the control-plane host updates with the server"); gate
`nodeCanConfigure` (owner or `edit`, the same as `service restart`, because
that is what it is); refused when the node is neither live nor held (409
`NODE_OFFLINE`); `compatibleNodeRelease()` null → 409
`NODE_UPDATE_UNAVAILABLE` with the reason; target `null` → the same code,
"no artifact for <os>/<arch>". Ensures the artifact is on disk or fetchable
(air-gapped with nothing published → 409 with the install-by-hand hint).
Mints a token; `url = <APP_BASE_URL>/api/downloads/node/<target>?update_token=<tok>`
— the same base the enroll script bakes, so the loopback trap applies and
the response body carries `url`'s host for the page to warn on; `sha256`
from `fetchDigest(target)`. `sendCommand(id, { type: "update", ... }, { timeoutMs: 300_000 })`,
routing to the held socket when there is no live one. Refusal mapping as
`service-node.route.ts:76-110` plus the four new results → 409 codes
`NODE_NOT_SUPERVISED`, `NODE_RESTART_KILLS_PANES`, `NODE_UPDATE_FAILED` (with
`detail`). Audit `node.update` `{ from, to, forced }`. 202 `{ ok: true, from, to }`;
the SPA waits with `use-node-restart-wait` (a held node has no `runtime`
to compare — for those the waiter watches `held` flip to null and `online`
to true).

The node view (`api/nodes/node-view.ts`) gains `held: { reason, agentVersion } | null`
(manage-gated like `runtime`? No — every viewer who can see the row can see
"this node needs an update"; it is the same disclosure as `agentVersion`,
which is already there).

## 6. SPA: the Updates page

New route `/settings/updates` (`routes/settings_.updates.tsx`), admin-gated
like `/settings/service`, in the settings navigation beside Service.
`hooks/use-updates.ts` reads `GET /api/admin/updates` (TTL-backed; a
Re-check button posts `…/server/update/check`). Cards, in order, each a
component under `components/updates/`:

- **Server** — running X, latest Y (or "up to date", or "cannot check:
  <reason>"), the binary path, the backup that would be taken (dir + count
  kept), and **Update to Y**. Disabled with `canApply.reasons` rendered as
  `detail` lines. The confirm dialog carries the pane-safety sentence and the
  forced path when `paneSafety !== "keeps"` (reuse `restart-dialog.tsx`'s
  shape). While a job runs: the phase and a progress line from the job.
  After: the restart waiter, then "Updated to Y" or the `lastFailure` error
  with "the previous version was restored".
- **Nodes** — the compatible node release (or the reason there is none),
  then one row per agent node: name, version, target, state (online / held
  "needs update: <reason>" / offline), **Update** per row (disabled with
  `canUpdate.reason`), and **Update all** for every row whose `canUpdate.ok`
  (sequential POSTs; a failure stops the sequence and names the node).
- **Desktop apps** — Subshell Server X → Y and Subshell Client X → Y from the
  release index. Inside the Subshell Server app (`isServerDesktop()`), the
  row shows the app's own version (from the UA marker, which the SPA already
  parses) and **Open the update assistant** →
  `desktop_open_assistant({ screen: "app-update" })` — a screen name, zero
  new grants on `main`. Inside Subshell Client, the row says "Subshell Client
  Y is available. Open the tray menu → This Machine… → Update." — the client
  window is granted one command and this design does not widen it. In a
  browser, the rows link to the release pages.

The existing `UpdateCard` (bundled-server offer) moves onto this page as a
line inside the Server card: "Subshell Server includes server Z" with its
existing button. `/settings/service` loses it. The setup checklist gets no
update item (it is about first run).

## 7. Desktop apps

### 7.1 The bundled CLI goes through `update --from`

`install_server_now` (`apps/server/desktop/src-tauri/src/control.rs:835`)
and `node_install_agent` (`apps/client/desktop/src-tauri/src/control.rs:699`):
when the outcome would be a REPLACE of a managed install (not a first
install), run `<installed> update --from <sidecar> --yes --no-restart --json`
instead of `sidecar::install_bundled`, and surface its JSON (`from`, `to`,
`backup`) in the screen's result. The first install (`no-server` /
`no-agent`) keeps `install_bundled`: there is no installed CLI to run yet.
The UI's second step (server: `ipc.service("restart", force)`; client: "start
it from here") is unchanged — that is what `--no-restart` is for. What this
buys: the desktop replace now takes a backup and writes the marker, so a
bundled server whose migrations fail reverts at boot exactly like every
other path. `stop_first` is no longer needed on this path (the swap is a
`rename`, the running process keeps its inode), but the CLI's own pane
refusal on the later restart still applies.

Requirement 1 ("replace the app with a newer one") is satisfied by what
exists plus this: a newer app bundles a newer CLI, `Probe::decide` offers
it, and the offer now runs the transaction.

### 7.2 The apps update themselves — `tauri-plugin-updater`

- **Signing.** Operator, once: `bunx tauri signer generate -w ~/.tauri/subshell-desktop.key`
  — ONE keypair for both apps (they are one publisher; the pubkey is
  identity of the publisher, not the app). Repo secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
  `plugins.updater.pubkey` committed in both `tauri.conf.json`. The `.key`
  in the password manager is the backup, as with the `.p12`. **Losing the
  key means every installed app can never auto-update again** — say so in
  the AGENTS.md.
- **Artifacts.** `bundle.createUpdaterArtifacts: true` in both configs.
  macOS: the bundler emits `<Product>.app.tar.gz` + `.sig`; the release
  script renames them `Subshell-Server-Desktop-<version>-darwin-arm64.app.tar.gz`
  (+ `.sig`), after notarization (the tarball must contain the
  notarized `.app`, so it is re-created from the stapled bundle — §12
  measures whether the bundler's tarball predates stapling). Linux: the
  `.deb` itself is the update package; the bundler is expected to emit
  `<pkg>.deb.sig` when the updater is configured — if it does not (§12),
  the script signs it with `tauri signer sign`. Every new name carries
  `Desktop`; `assertBundleSet` tolerates the extra files.
- **`latest.json`** — a sixth asset on each desktop release, written by the
  release script in the plugin's static shape:
  `{ version, pub_date, notes: "<release page url>", platforms: { "darwin-aarch64": { url, signature }, "linux-x86_64": { url, signature } } }`
  with `url = https://github.com/subshell-ai/subshell/releases/download/<tag>/<asset>`
  (knowable before publish: tag and names are chosen by the repo). Each
  shard builds one platform, so each writes `latest.<triple>.json` and the
  publish job merges them into `latest.json` (a small `bun` step in
  `release.yml`, tested in isolation). `signature` is the `.sig` file's
  content inline.
- **Rust** (`app_update.rs` in each app, the HTTP client the tree did not
  have — `reqwest` arrives with the plugin, so it is not a new dependency):
  `check_app_update()` GETs `DEFAULT_RELEASE_API` (the constant mirrored in
  Rust as `RELEASE_API`, with `SUBSHELL_RELEASE_URL` in the app's
  environment overriding it — the same seam), picks the newest
  `desktop-server-v*` / `desktop-client-v*` with `version_lt`, sets
  `updater().endpoints([<that release>/latest.json])` and calls `check()`.
  Returns `{ current, latest: Option<String>, notes }`. `install_app_update()`
  runs `download_and_install` with progress events to the page, then
  `app.restart()`. On Linux the plugin installs the `.deb` behind a polkit
  prompt; the screen says so before the press. Both commands are granted to
  the BUNDLED window only (`wizard.json` / `node.json`), named
  `desktop_check_app_update` / `desktop_install_app_update` and
  `node_check_app_update` / `node_install_app_update`; `main`'s six-command
  and one-command pins are unchanged, and `ipc-acl.test.ts` in each app
  grows the four names on the bundled side.
- **Screens.** Server assistant: `Screen::AppUpdate` (`reset.rs:49`,
  `as_str` `"app-update"`, `screenForRequest` / `REQUESTED_SCREENS` in
  `wizard-state.ts`) — *Update Subshell Server*: "This Mac runs Subshell
  Server 0.6.0; 0.7.0 is available." **Download and install** → progress →
  "Restarting…". Reached from the SPA (§6) and from a new tray/menu item
  **Check for Updates…**. Client assistant: an `"app-update"` screen in
  `node-assistant-state.ts`, reached from the Connected screen's disclosure
  and the tray. **On launch, each app checks once** if the last check in
  `settings.json` (`lastUpdateCheckAt`) is older than 24 h, and, when an
  update exists, suffixes the tray item "Check for Updates… (0.7.0
  available)" — no window opens on its own.

## 8. Release pipeline changes (`.github/workflows/release.yml`, four `release.ts`)

- Every `release.ts` writes `release-manifest.json` (§3.2) into its publish
  dir. The publish glob already ships it.
- Desktop shards: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` exported to the
  bundle step; updater artifacts collected, renamed and digested like the
  bundle; `latest.<triple>.json` emitted; the publish job merges into
  `latest.json` before the draft upload.
- `scripts/smoke-desktop-bundle.sh` asserts the `.sig` exists and
  `latest.<triple>.json` names the assets that exist.
- `desktop-paths.test.ts` name-token allowlist: `release-manifest.json`,
  `latest.json`, `latest.<triple>.json`, and `*.sig` / `*.app.tar.gz` carry
  `Desktop` already.
- Missing signing secrets **fail the desktop shard loudly**, like the
  notary secrets: an unsigned updater artifact is one no installed app will
  accept, so publishing it is publishing a lie.

## 9. Everything that changes, by file (complete)

**`packages/subshell-protocol`**: `src/releases.ts` (from `node-release.ts`)
+ tests; `node-frames.ts` (`update` command, results, protocol 10);
`versions.ts` (`MIN_AGENT_VERSION` 0.9.0); `index.ts` exports;
`paths.ts` unchanged; `__tests__/desktop-paths.test.ts` allowlist.
**`packages/backend-errors`**: `UPDATE_SOURCE_DISABLED`, `UPDATE_BINARY_UNKNOWN`,
`UPDATE_IN_PROGRESS`, `UPDATE_NOT_AVAILABLE`, `UPDATE_DOWNGRADE`,
`NODE_UPDATE_UNAVAILABLE`, `NODE_UPDATE_FAILED`.
**`apps/server/api`**: `constants.ts` (`SUBSHELL_RELEASE_URL`,
`SUBSHELL_DB_BACKUPS_KEEP`); `services/releases.ts` (from `node-release.ts`),
`services/db-backup.ts`, `services/installed-binary.ts`,
`services/update-transaction.ts`, `services/server-update.ts`,
`services/nodes/update-tokens.ts`, `services/nodes/node-registry.ts` (held),
`services/nodes/node-ws-handler.ts`, `services/nodes/node-rpc.ts`
(per-command timeout, held routing); `commands/update.ts`,
`commands/backup.ts`, `commands/status.ts`, `cli.ts` (verbs, usage, flags);
`index.ts` (boot hook); `api/admin-server/update.route.ts`,
`update-check.route.ts`, `get-update.route.ts`, `api/admin-updates.route.ts`,
`api/nodes/update-node.route.ts`, `api/nodes/node-view.ts`,
`api/downloads.route.ts`, `api/settings.route.ts`; `scripts/release.ts`
(manifest); `AGENTS.md`; tests beside each.
**`apps/node/agent`**: `src/update.ts`, `src/commands/update.ts`,
`src/commands/index.ts`, `src/cli.ts`, `src/daemon.ts` (4406 revert,
`.previous` cleanup), `src/scripts/release.ts` (manifest), `package.json`
0.9.0, `AGENTS.md`, tests.
**`apps/server/web`**: `routes/settings_.updates.tsx`, `hooks/use-updates.ts`,
`hooks/use-node-update.ts`, `components/updates/*`, settings navigation,
`components/service/update-card.tsx` (moved), `types/node.ts` (`held`),
`components/nodes/node-service-card.tsx` (an Update row or a link to the
page — link; one place to update from), tests, e2e assertion that the page
renders.
**`apps/server/desktop`, `apps/client/desktop`**: `Cargo.toml`
(`tauri-plugin-updater`), `tauri.conf.json` (pubkey, `createUpdaterArtifacts`),
`src-tauri/src/app_update.rs`, `control.rs` (`--from` delegation, two
commands), `reset.rs` / `windows.rs` (screen, tray item),
`permissions/desktop.toml`, `capabilities/wizard.json` / `node.json`,
`ui/src/…` (screen, ipc wrappers), `src/scripts/release.ts` (updater
artifacts, `latest.<triple>.json`, manifest), `ipc-acl.test.ts`, `AGENTS.md`.
**`crates/desktop-core`**: nothing new is required; `sidecar.rs` keeps
`install_bundled` for first installs.
**Root**: `.github/workflows/release.yml` (secrets, merge step),
`scripts/smoke-desktop-bundle.sh`, `docs/security.md` (§11.12),
`.claude/rules/security-context.md`, `AGENTS.md` (release table: six assets
per desktop release, five per CLI release; `SUBSHELL_RELEASE_URL`),
`install-server.sh` (unchanged behaviour; mention `update` in its final
lines), changesets for all four apps.

## 10. Copy, exact

- Server card, up to date: *Running 0.6.0 — the newest release.*
- Server card, available: *0.7.0 is available. Running 0.6.0.* Button
  **Update to 0.7.0**. Detail: *The database is backed up to
  `<dir>` first (5 kept). The server restarts; open subshells keep
  running.* — or the pane sentence from the restart dialog.
- Server card, cannot: *Updates are unavailable: <reason>.* Reasons:
  *this server is not running under a service manager*; *this server runs
  from a checkout*; *no release source is configured (SUBSHELL_RELEASE_URL
  is empty)*; *the installed binary could not be found*.
- Job phases: *Downloading 0.7.0 (42 of 81 MB)…*, *Verifying…*, *Backing up
  the database…*, *Installing…*, *Restarting…*.
- After: *Updated to 0.7.0.* / *The update to 0.7.0 failed and 0.6.0 was
  restored: <error>.*
- Nodes: *Nodes can be updated to 0.9.0.* / *No node release can be offered:
  <reason>.* Row states: *online*, *needs update — below this server's
  minimum (0.7.0)*, *needs update — speaks protocol 9, this server speaks
  10*, *offline*. Button **Update**; **Update all (3)**.
- Desktop: *Subshell Server 0.7.0 is available; this app is 0.6.0.* **Open
  the update assistant** / *Subshell Client 0.5.0 is available. Open the
  tray menu → This Machine… → Update.*
- CLI: `subshell-server update` prints one line per step and ends
  `Updated to 0.7.0.` or `Update failed; 0.6.0 was restored: <error>`.

## 11. Security accounting (→ `docs/security.md` §11.12)

- **The plane downloads and executes code from the release source.** The
  digest verified is the one the SAME source publishes beside the binary,
  so integrity proves "these are the bytes GitHub served", not authorship;
  authenticity rests on the release source's TLS and the repository's
  access controls — exactly the trust `install-server.sh` and the node
  enroll one-liner already place. A compromised release source (or a
  redirected `SUBSHELL_RELEASE_URL`) is code execution on every plane and,
  through them, every node that accepts an update. Empty disables all of
  it. The desktop apps are STRONGER here: the updater verifies a minisign
  signature against a public key compiled into the app, so a malicious
  release host cannot hand them a binary of its own — only withhold updates.
- **An admin can now install code on the control-plane host from a
  browser**, where before they could only restart it. Cookie-admin only,
  audited at start (actor) and at completion (boot). The same accounting as
  §11.10/§11.10b (agent CLI and tmux installs) applies, with a narrower
  argv: the URL comes from the release index, never from the request body,
  and `version` selects among published tags only.
- **An `edit` grantee can now replace a node's binary**, as they can already
  restart it and run arbitrary commands there through launches. The URL and
  digest are inside the signed command; the token is single-use, ten
  minutes, bound to one node and one target, held in memory, and grants one
  download of one public file. "A node key can do nothing on REST" remains
  true.
- **Held sockets are a resource.** A held node is offline for every purpose
  but `update`; frames from it are dropped; it is closed after ten minutes
  unused. Newest-wins still applies.
- **The backup is the whole database** — credential hashes, API-key hashes,
  audit rows, channel ciphertext. 0600 in a 0700 directory under the data
  dir, so the reset's five paths cover it and the disk posture is unchanged.
  Five kept by default; an operator who wants fewer bytes on disk sets
  `SUBSHELL_DB_BACKUPS_KEEP`.
- **Rollback restores a database from before the update** — anything
  written between the backup and the failed boot (nothing: the backup is
  taken with the old server still serving, and the swap follows within
  seconds; but a slow download is BEFORE the backup, by design) is lost.
- **Deep link surface unchanged.** `app-update` is one more screen name on
  the existing closed enum; `main` gains no command in either app.

## 12. Measurements the implementer must make

1. **`VACUUM INTO` on a live WAL database from a second `bun:sqlite`
   connection** produces a file that opens cleanly with `integrity_check`
   ok and no sidecars. Expected yes (SQLite ≥ 3.27). If not, fall back to
   the `backup` API is unavailable in bun:sqlite — then `BEGIN IMMEDIATE`
   + `wal_checkpoint(TRUNCATE)` + `copyFile` and say so in the module.
2. **`rename(2)` over a running binary on macOS** keeps the old process
   alive (the sidecar module says overwriting IN PLACE SIGKILLs; rename does
   not). Confirm with the installed server running.
3. **Kysely on a database with unknown migration names** throws at
   `migrateToLatest()` rather than ignoring them — this is what the rollback
   depends on. Pin with a test.
4. **The updater plugin's Linux artifacts**: does `createUpdaterArtifacts`
   emit a `.sig` for the `.deb`, and does `download_and_install` accept a
   `.deb` URL? If the bundler emits only `AppImage.tar.gz`, sign the `.deb`
   with `tauri signer sign` and confirm the plugin installs it (its
   changelog says Deb/Rpm are supported).
5. **macOS updater tarball vs. notarization order**: whether the bundler's
   `.app.tar.gz` is created before `notarizeAndStapleDmg` staples the `.app`.
   If so, re-tar the stapled `.app` and sign THAT tarball.
6. **A held socket's agent keeps sending frames** (inventory, maintenance)
   — confirm dropping them costs nothing and the agent does not treat
   silence as failure within ten minutes (its ping/pong, if any).

## 13. Testing

- `releases.test.ts`: four prefixes, cross-component tags ignored, drafts
  skipped, manifest parse, `hostReleaseTarget` table.
- `db-backup.test.ts`: backup of a temp DB, sidecar-free, 0600/0700,
  retention prune, `null` on no database, restore replaces db/-wal/-shm.
- `installed-binary.test.ts`: systemd one-token, systemd two-token
  (`source`), launchd both locations, app-supervised, hand-run, unknown.
- `update-transaction.test.ts`: begin refuses when pending; revert restores
  and writes failed; complete audits and cleans; `to !== SERVER_VERSION`
  records failure.
- `cli.test.ts`: `update --check`, `--from` version probe refusal, downgrade
  refusal, `--rollback` without `.previous`, usage lists the verbs.
- Route tests: every 409 in §4.5 and §5.3; bearer refused; audit rows;
  `GET /api/admin/updates` shape; downloads route accepts a token once.
- Registry: held map semantics, `isNodeOffline` true for held, supersede.
- Agent: `applyUpdate` with a fake release server (temp dir, digest
  mismatch leaves the binary), executor refusals, 4406 revert path.
- SPA: Updates page renders each card state; job phases; node rows.
- Desktop: `ipc-acl.test.ts` pins; `latest.json` merge step; smoke asserts
  `.sig`.
- `test:cli` (compiled): `subshell-server update --from <other build>` end
  to end on a temp instance — the only test that proves the swap and the
  boot-time completion with a real binary.

## 14. Non-goals

- A background update check with a sidebar badge. The page checks when
  opened; the desktop apps check once a day on launch. A server-side daily
  poll is a follow-up decision, not an omission.
- Automatic updates of anything. Every update is a press or a verb.
- Updating a node that is powered off, or one that never reconnects.
- Delta updates, channels (beta/stable), or pinning a fleet to a version.
- Migrating the two existing release cuts to carry manifests. The next cut
  does.

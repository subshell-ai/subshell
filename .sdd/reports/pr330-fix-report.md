# PR #330 fix wave - report

Status: DONE_WITH_CONCERNS (all 16 findings fixed and green; three design
decisions surfaced below for coordinator confirmation)

Branch: `worktree-agent-a9e0bf8bd9ceca0d4` (from `feat/ssh-support` tip `dfad7fbf`)
HEAD at report writing (last fix commit): `aff243b4`; this report's own
commit is the final branch tip.

## Per-finding status

### CRITICAL 1 - real-OpenSSH `-G` defaults refused - FIXED (d8f4c454)
`ssh-resolve.ts` now accepts the measured default spellings: tunnel
`no`/`false`, permitremoteopen `none`/`any`; a leading `~/` in
identity/certificate/known-hosts values expands against `deps.homeDir`
(`expandTilde`, exported from `ssh-discover.ts`); `none` filtering kept.
`CLEAN_G` extended to realistic OpenSSH 10.x output (tunnel/permitremoteopen/
permitlocalcommand lines, tilde-form identityfiles). Two REAL-host pins
added (`HAVE_SSH` + loud `console.warn` + `it.skipIf`): a plain `ssh -G`
resolve answers accepted with every identity under `<home>/.ssh/`, and a
`PermitRemoteOpen host:1080` + `LocalCommand` config answers `blocked`
naming both.
BONUS bug found by the real-`-G` pin (not in the brief): the conflict
detector added `HostName` and `port` to ONE set, so any block setting both
was falsely refused `config_ambiguous`. Fixed to two sets; shim regression
test added ("HostName + Port together is not ambiguous").

### CRITICAL 2 - parked pane no longer lets a connection delete - FIXED (0d4a5d2c)
Per ruling: migration 0048 and the FK untouched. `hasActiveWork`'s pane arm
dropped the `alive` condition: `ssh_panes JOIN subshells WHERE
connectionId = ? AND subshells.status = 'running'`. Tests
(`ssh-policy.test.ts`): parked managed pane (running/alive:0) -> delete
refuses `active_work` and the marker survives; terminated pane -> delete
succeeds; the parked pane's own restart surface still allows (the fix is
the delete gate, not the pane).

### IMPORTANT 1 - bearer restart fenced to the granted revision - FIXED (1717c40e)
`gatePaneSurface` bearer arm: `surface === "restart" &&
grant.connectionRevision !== conn.revision` -> `revision_mismatch`. Cookie
owner unaffected; stale-revision STREAMS still pass (documented: streams
read the pane's own life; restart is a fresh dispatch). Tests: equal-revision
bearer restart allowed; edit-then-bearer-restart refused; cookie edit-then-
restart allowed; stale bearer log still allowed.

### IMPORTANT 2 - origin check on the ssh-control write - FIXED (5cea0fbf)
`ssh-pane-ops.route.ts` POST now calls `assertCookieWriteOrigin(actor,
request)` after the perm gate, like every `/api/ssh` write. Test
(`ssh-pane-gates.test.ts`): raw Request with `Origin:
http://evil.example.com` -> 403, `controlGeneration` stays 1, no node
command typed; good origin -> 200, generation 2.

### IMPORTANT 3 - in-process local node SSH - FIXED (c5555d47)
No contract blocker; no protocol change, no wire shape invented. New
`services/ssh/ssh-local.ts` (362 lines) implements the exact verb set the
agent handlers wrap, calling the same `@internal/pane-runtime` modules:
discover/resolve/test (own fixed probe config, O_EXCL under
`<dataDir>/ssh/probes`, finally-unlink)/run start/status/read/cancel (via
`getSshRunSupervisor` on `SUBSHELL_SERVER_DATA_DIR`)/terminal launch (real
tmux through `getDefaultLocalLauncher`, `pipe-pane` capture, rendered 0600
config)/input-control (same frozen `transitionControl`). The dispatch seam
(`ssh-node-client.ts call()`) routes `nodeId === LOCAL_NODE_ID` in-process
before any socket check; local is always "live" - eligibility skips the
`getLive` test for kind `local`. `ssh-node.ts` gate serves what local can
serve now; stale comment replaced. `ssh-pane-hooks.ts` local arm types via
the local launcher with the generation fence held. `workingDir` local arm:
`process.env.HOME || homedir()`.
Tests (`ssh-local.test.ts`, 364 lines): hermetic resolve round-trip through
a `SUBSHELL_SSH_PATH` shim + fixture HOME (absolute identity paths),
discover, bad-alias data-level refusal, bad-id refusal; REAL loopback-sshd
+ REAL tmux (loud-skip when the daemon cannot come up): terminal open ->
pane live, input-control generation 5 echoes, lowered replay generation 3
refused as `SshNodeRefusal`, close -> pane gone, state file written.

### IMPORTANT 4 - uploads to managed panes refused server-side - FIXED (231d034e)
`uploads.route.ts` reads the `ssh_panes` marker before any write and
answers 400 `UPLOAD_SSH_UNSUPPORTED` (new named code in
`@internal/backend-errors`, message "file uploads are disabled on managed
SSH terminals until remote file operations exist"). This is the single
entry point every upload door shares. Test: managed pane refused; after
deleting the marker the identical upload succeeds (ordinary-pane behavior
byte-identical).

### IMPORTANT 5 - dead duplicate takeover act deleted - FIXED (384eb4d4)
`sshControlTransition` removed (it moved the plane row first and never
closed viewer streams; grep-verified tests-only). Its test replaced with
`expect(scripted.cmdsOf("ssh_input_control").length).toBe(0)` plus the
setControl/gate assertions. Both doc references now point at
`pane-ssh-gate.ts::transitionPaneControl`.

### IMPORTANT 6 - resolved exec rows age out - FIXED (1b57c69e)
`sweepExpiredSshRuns` also deletes `ssh_terminal_execs` rows with
`state != 'outstanding'` under `COALESCE(resolved_at, created_at)` older
than the same 7-day window (window shared with runs, `COALESCE` covers
pre-stamp rows). Outstanding rows are never candidates (the late-marker
wait is what they exist for). Test: old resolved row swept, outstanding
row survives.

### Minors (all fixed)
- M1 (d8f4c454): keyword `localecalcommand` -> `localcommand` (measured:
  real `-G` echoes `localcommand`); test fixture fixed too.
- M2 (29c4fb77): `refuseAfterUnknown` comment now states the shipped M5
  ruling: human-class is COOKIE AND SYSTEM KEY; the only actor that waits
  is the bearer subshell key.
- M3 (aff243b4): `sweepSshProbes` in pane-runtime (the sweep `ssh-test`'s
  comment promised): `<dataDir>/ssh/probes/<uuid>.config` past the frozen
  window, mtime age, symlink leaf refused, never throws. Wired into the
  agent's hourly sweep (job 3b). Also added the server half (I3-disk):
  `sweepLocalSshFiles` runs reconcile + completed-run + probe +
  terminal-state sweeps against `SUBSHELL_SERVER_DATA_DIR` from the
  existing boot+hourly DB pass (terminal-state gated on the running-and-
  alive row read, fail closed). Tests: old uuid deleted / fresh kept /
  foreign name ignored; symlink never chased; absent dir not an error.
- M4 (29c4fb77): chose the KEEP option - `readTerminalLog`/`controlStateFor`
  carry the "FROZEN-CONTRACT impl pinned by ssh-terminal-log.test.ts, not a
  live caller - do not delete" note. No silent second implementation.
- M5 (29c4fb77): `lstatSafe(dir)` hoisted in `ssh-run-store.ts`.
- M6 (d8f4c454): IdentityAgent comment now describes the real behavior
  (any non-`none` spelling means the account's agent == `SSH_AUTH_SOCK`).
- M7 (29c4fb77): dead `atRoot ? [] : next` branch in `ssh-discover.ts`
  simplified to `return next`.
- M8 (29c4fb77): `stale_command` definition carries the RESERVED note
  (emitted nowhere; the staleness defense is JWS expiry; stays for the
  protocol freeze).

## Commits (git show --stat)

```
=== aff243b4 fix(ssh): sweep stranded probe configs; bound the built-in node's file subtree (M3, I3-disk) ===
 apps/node/agent/src/commands/ssh-sweep.ts          |  7 +++
 apps/server/api/src/services/ssh/ssh-retention.ts  | 62 ++++++++++++++++++++++
 packages/pane-runtime/src/index.ts                 |  1 +
 .../src/ssh/__tests__/ssh-run-store.test.ts        | 50 ++++++++++++++++-
 packages/pane-runtime/src/ssh/ssh-retention.ts     | 40 ++++++++++++++
 5 files changed, 159 insertions(+), 1 deletion(-)

=== 29c4fb77 fix(ssh): the no-risk review minors (M2, M4, M5, M7, M8) ===
 .../api/src/services/terminal-exec-records.ts      | 13 +++++++++----
 packages/pane-runtime/src/ssh/ssh-discover.ts      |  7 ++++---
 packages/pane-runtime/src/ssh/ssh-run-store.ts     |  7 ++++++-
 packages/pane-runtime/src/ssh/ssh-terminal-log.ts  | 22 +++++++++++++++++++++-
 packages/subshell-protocol/src/ssh-errors.ts       | 12 +++++++++++-
 5 files changed, 51 insertions(+), 10 deletions(-)

=== c5555d47 feat(ssh): run the ssh_* verbs in-process on the built-in local node (I3) ===
 .../src/services/ssh/__tests__/ssh-local.test.ts   | 364 +++++++++++++++++++++
 apps/server/api/src/services/ssh/ssh-local.ts      | 362 ++++++++++++++++++++
 .../server/api/src/services/ssh/ssh-node-client.ts |  28 +-
 apps/server/api/src/services/ssh/ssh-node.ts       |  42 ++-
 apps/server/api/src/services/ssh/ssh-pane-hooks.ts |  34 +-
 .../api/src/services/ssh/ssh-terminals.service.ts  |  11 +-
 6 files changed, 821 insertions(+), 20 deletions(-)

=== 1b57c69e fix(ssh): resolved terminal-exec rows now age out (I6) ===
 .../services/ssh/__tests__/ssh-retention.test.ts   | 67 ++++++++++++++++++++++
 apps/server/api/src/services/ssh/ssh-retention.ts  | 64 +++++++++++++++++----
 2 files changed, 121 insertions(+), 10 deletions(-)

=== 384eb4d4 fix(ssh): delete the dead second takeover act (I5) ===
 .../src/api/ssh/__tests__/ssh-runs-route.test.ts   | 14 +++--
 apps/server/api/src/api/ssh/index.ts               |  5 +-
 apps/server/api/src/services/ssh/ssh-pane-hooks.ts | 19 ++++---
 .../api/src/services/ssh/ssh-terminals.service.ts  | 66 ++++------------------
 4 files changed, 33 insertions(+), 71 deletions(-)

=== 231d034e fix(ssh): refuse uploads to managed SSH panes at the server (I4) ===
 .../api/src/api/__tests__/uploads-route.test.ts    | 69 ++++++++++++++++++++++
 apps/server/api/src/api/uploads.route.ts           | 19 ++++++
 packages/backend-errors/src/error-codes.ts         |  6 ++
 3 files changed, 94 insertions(+)

=== 5cea0fbf fix(ssh): explicit origin check on the ssh-control takeover write (I2) ===
 .../api/subshells/__tests__/ssh-pane-gates.test.ts | 33 ++++++++++++++++++++++
 .../api/src/api/subshells/ssh-pane-ops.route.ts    | 15 ++++++----
 2 files changed, 43 insertions(+), 5 deletions(-)

=== 1717c40e fix(ssh): bearer restart requires the grant to pin the current revision (I1) ===
 .../src/services/ssh/__tests__/ssh-policy.test.ts  | 64 ++++++++++++++++++++++
 .../server/api/src/services/ssh/ssh-policy-impl.ts | 25 ++++++++-
 2 files changed, 86 insertions(+), 3 deletions(-)

=== 0d4a5d2c fix(ssh): any running managed pane blocks connection deletion (C2) ===
 .../src/services/ssh/__tests__/ssh-policy.test.ts  | 79 ++++++++++++++++++++++
 .../api/src/services/ssh/ssh-runs.repository.ts    | 13 +++-
 2 files changed, 90 insertions(+), 2 deletions(-)

=== d8f4c454 fix(ssh): accept real OpenSSH -G default spellings and tilde identity refs (C1) ===
 .../src/ssh/__tests__/ssh-resolve.test.ts          | 229 +++++++++++++++++++--
 packages/pane-runtime/src/ssh/ssh-discover.ts      |   4 +-
 packages/pane-runtime/src/ssh/ssh-resolve.ts       |  60 ++++--
 3 files changed, 256 insertions(+), 37 deletions(-)
```

## Full-suite lines (verbatim)

Commands: `env -u SHELLOPTS -u BASHOPTS bun test <path>` (serial, repo root).

packages/pane-runtime/src:
```
 527 pass
 0 fail
 1341 expect() calls
Ran 527 tests across 40 files. [20.66s]
```

apps/node/agent/src:
```
 932 pass
 0 fail
 4149 expect() calls
Ran 932 tests across 55 files. [13.84s]
```

apps/server/api/src (FULL):
```
 4083 pass
 3 fail
 14468 expect() calls
Ran 4086 tests across 317 files. [223.74s]
```

The 3 failures, verbatim:
```
(fail) cross-subshell e2e (two subshell mcp processes) > (unnamed) [0.33ms]
(fail) local attach cleanup — the ws.data wiring (pre-existing leak) > honours `&hidden=1` from the connect URL, without waiting for a frame [410.34ms]
(fail) double cleanup parity — the local path absorbs it identically (T11 parity carry, local half) > two cleanupSubshellWs calls on a local attach: no throw, and the stream stays dead [1.70ms]
```
All three are inside the brief's known-env families ("cross-subshell + 2
patch-config + 2 parallel-only attach-grid"; the two patch-config tests
passed this run). None of the owning files is in my diff (git diff
--name-only dfad7fbf..HEAD touches no `ws/` file). Order-dependence proof:
`remote-attach-ws.integration.test.ts` runs 3 pass / 0 fail standalone;
`local-attach-cleanup` + `local-attach-grid` pass standalone; combined
batches fail them - the same cross-file pollution class I proved
pre-existing for `ssh-pane-gates` earlier via `git stash` + rerun on the
clean base.

Other boundary checks: `bunx turbo build` 34/34 tasks; verify-types (the 4
filtered packages) 20/20; `bun run lint:check` clean (27/27);
`bun run lint:prose` -> "prose-dashes: clean".

## Concerns (for coordinator confirmation)

1. I3 gate design: the `local` arm of `sshNodeGate` refuses non-admin
   COOKIES (`caller.actor === "cookie" && !caller.isAdmin -> not_found`)
   and lets bearer actors through. Rationale (in the code comment): a
   bearer reaching this gate has already passed `gateGrantedUse` (its
   grant), and bearers always carry `isAdmin: false`, so gating on the
   flag alone would make grants dead for local connections. If the intent
   was "local SSH connections are admin-only even for grantees", flip the
   arm - one line.
2. Retention knob asymmetry (documented in both sweep docs): the FILE
   sweeps anchor on the frozen `SSH_COMPLETED_RUN_RETENTION_MS`; the env
   `SSH_RUN_RETENTION_DAYS` moves only the DB rows. Chosen to keep the
   protocol-frozen window honest; an operator might expect one knob.
3. Extra fix riding C1: the HostName/Port conflict-detector bug (false
   `config_ambiguous`). It was not in the brief; without it every alias
   with both HostName and Port is refused, so the C1 acceptance tests
   could not be honest without it.
4. M4 took the brief's keep-option (frozen-contract marker) rather than
   deleting `readTerminalLog`/`controlStateFor`.
5. `ssh-resolve.test.ts` is 426 lines (guideline ~400): one concern
   (resolve grammar), fixture-heavy; splitting was left for a dedicated
   pass rather than done here.

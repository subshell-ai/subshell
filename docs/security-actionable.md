# Security actionable items: 2026-09-23 documentation sweep

**STATUS: Rounds 1–3 CLOSED. Round 3 (14 items from four adversarial sweeps:
credentials/WS, injection/labels, races/TOCTOU, updates/deps) was implemented
2026-09-24; the sweeps found NO bypass of any guard, and Round 3's items were
the REAL bugs at the edges they conceded, defense-in-depth, and dependency
hygiene.** Open now: only the two trigger-held items (R5/R6) and the
"deferred by decision" lists, which are open BY CHOICE. Rounds 1–2 records are
condensed at the bottom.

Ground rules unchanged: the trusted-network posture (§0, §12) is settled;
"environment wins", fail-closed shapes, and "ids never secret-values in audit
metadata" are the patterns to preserve. After code: `bun run verify-types &&
bun run lint:check && bun run test`; SPA touches `lint:design`; `packages/`
touches also `bunx turbo build`.

## Resolved: Round 3, 2026-09-24 (adversarial sweeps)

### C1. ✅ Manual rename bypasses the pane-title sanitizer (M · S) **[REAL]**
Subshell create/rename and workspace names run `.trim()` + a 120-length schema
check ONLY (`api/subshells/update-subshell-name.route.ts:38`,
`create-subshell.route.ts:15`, `workspaces/create-workspace.route.ts:9`) while
the AUTO path (harness OSC) passes `normalizePaneTitle`
(`subshell-manager.service.ts:1884-1902`, Kitty-query-laundering-hardened).
Raw ESC/CR in a name reaches the operator's JOURNAL verbatim
(`subshell-manager.service.ts:756` interpolates `${parked.name}` into
`logger.info` on the pinned-stdout transport; `ESC[2K`+CR blanks the line in
`journalctl`) and other users' screens (React-escaped, so display-safe; the
journal is the injection sink). A harness can rename ITSELF with control bytes,
defeating the sanitizer's own threat model. Fix: route ALL three paths through
`normalizeLabel`; refuse empty. Tests per route.

### C2. ✅ `normalizeLabel` hardening: NFC, format chars, surrogates (L · S)
Survivors verified by probe: bidi overrides U+202B/202D/202E
("Server‪ppa" renders "Serverapp", a node-name spoof), ZWJ/ZWSP/VS16,
U+E0041 tag chars (fully invisible; labels reach SIBLING AGENTS verbatim via
`list_subshells` → invisible prompt-injection anchors), unpaired surrogates;
no NFC (NFD/NFC "café" mint two visually identical rows). Fix: prepend
`normalize("NFC")`, drop category `Cf` + unpaired surrogates; all three
bindings inherit.

### C3. ✅ Attach journal interpolates User-Agent unclamped (L · S) **[REAL]**
`ws/attach-resolve.ts:148`: `ua="${ua.slice(0,90)}"`; a quoted-closure + ANSI
attach line lets ANY authenticated caller (including a pane's own bearer)
forge/clobber the `ws attach` journal lines the AGENTS doc leans on. The
sibling `build=` field already has the right clamp (`attach-params.ts:147`,
`[A-Za-z0-9_.-]`). Fix: same clamp (or `normalizeLabel`) on `ua`.

### C4. ✅ Server update route: check→await→set, not CAS (M · S) **[REAL]**
`api/admin-server/update.route.ts:130` checks pending/running, then AWAITs
release + audit before `start()` sets the job; two concurrent POSTs both pass,
share one `${name}.download-${pid}` tmp (`services/releases.ts:799`), and the
loser's cleanup unlinks the winner's bytes mid-flight (update aborts, UI
flaps; wrong-binary impossible, marker bookkeeping survives). Desktop has
exactly this CAS (`ActionGuard::try_new`). Fix: synchronous claim (re-check +
set immediately before `start`, or claim at handler top before the first await).

### C5. ✅ Update swap has a no-binary window; use link + single rename (L · S-M)
All three swappers rename-aside THEN rename-in (`server-update.ts:265→273`,
`commands/update.ts:358→366`, node `update.ts:603`); a kill/power-loss in the
inter-statement gap leaves NOTHING at ExecStart and the boot-revert (which
lives in the absent binary) can never run; manual `<bin>.previous update
--rollback` on a headless node. Fix: create `.previous` via `linkSync` of the
old binary first, then ONE `rename(tmp, binary)` (safe over a running image;
already assumed at `update-transaction.ts:26-30`). Crash leaves the old binary
bootable and `recordFailure` converges.

### C6. ✅ Retention sweeps: re-probe liveness immediately before unlink (L · S)
Both sweeps snapshot liveness BEFORE the stat/unlink loop (server
`pane-log-hygiene.ts:125-129`; node `pane-log-retention.ts:237-256`; 1-day
default makes it likelier than the server's 30). Interleaving: restart reuses
the same log path append-only with OLD mtime → swept between census and unlink
→ live pane writes an unlinked inode, replay broken until relaunch. Fresh ids
are age-gated; only restart-reuse bites. Fix: per-file liveness re-probe
directly before `unlink`, both files.

### C7. ✅ config.env read-merge-write lost update (L · S-M)
`configure.ts:394 applyConfig` merges against a stale read; dashboard PATCH +
CLI (or two admins) → later rename silently reverts earlier keys while BOTH
audits claim success. Write itself is atomic (tmp+rename 0600). Fix: re-read +
re-merge foreign keys immediately before the rename (last-writer-per-KEY, not
per-file), or flock the config dir.

### C8. ✅ `restoreDatabase` deletes WAL/SHM before the rename (L · S)
`db-backup.ts:289-290` unlinks sidecars, then renames staged→main; crash
between = surviving DB missing its uncheckpointed tail with a then-successful
boot continuing silently (also leaks `<db>.restore-<pid>`). Fix: rename the
main file FIRST, sidecars after, or TRUNCATE-checkpoint before unlinking.

### C9. ✅ WS cookie-fallback: add the `accountDisabled` check (L · S)
`ws/attach-resolve.ts:85-91` trusts `resolveCookieSession` without the
disabled check REST's guard applies (`auth-guard.ts:168-173`). Unreachable
today for THREE independent reasons (disable revokes sessions transactionally;
Elysia doesn't populate the raw request cookie in production; cookieCache
can't spoof it: `session-cookie.ts:51-65` forwards token only), but it is the
ONE principal-resolution path missing the rule. One-line defense-in-depth.

### C10. ✅ CI has no dependency-vulnerability gate (M · S-M)
No `bun audit`/osv-scanner anywhere in `.github/workflows/`; `dependabot.yml`
deliberately skips JS. 26 advisories unwatched TODAY (see C11 for triage:
1 runtime-adjacent, rest dev-tree). Fix: job in `lint.yml` with a committed
ignore file for the dev-only/track set so it passes day one, failing only on
NEW advisories. Rejected alternative (standing): an NPM_TOKEN'd private
registry is not related; keep the OIDC stance.

### C11. ✅ Dead dependencies + audit-fix bumps (L · S)
`ajv@8.20.0` (declared in `packages/subshell-protocol/package.json`, ZERO
imports repo-wide, and pulls `fast-uri`, 7 high host-confusion advisories, into
the dev tree) and `better-auth-ui@3.2.27` (declared in `apps/server/api`,
zero imports, and pulls `@instantdb/react → uuid`). DELETE both, re-run
`bun audit`. Then `bun audit fix`-safe bumps: brace-expansion, browserslist,
glob, js-yaml, minimatch, picomatch, baseline-browser-mapping, babel.
Track-only (crosses majors, upstream pins): `decode-uri-component`
(**mobile runtime** via expo-router → query-string; track upstream, don't
force), `image-size` (metro pins 1.x). Neither reaches a signed desktop/CLI
artifact.

### C12. ✅ Lazy-fetch origin pin, or one §11.12 sentence (L · S)
`releases.ts:662` fetches `browser_download_url` verbatim; a configured
mirror can point the plane's egress at link-local internals (SSRF-probe
class); digest + size cap bound everything else, and Bun fetch can't read
`file:`. Fix: assert `new URL(u).origin` ∈ {configured source, GitHub API
hosts}, or state the egress choice in §11.12 next to "withhold or replay …
and nothing else".

### C13. ✅ Node-local downgrade refusal (defense-in-depth) or docs line (L · S)
`execUpdate` never compares `cmd.version` vs own `NODE_VERSION`; the refusal
lives plane-side only (`update-node.route.ts:268-286`, fails open if a node
never reported a version; impossible at protocol ≥12, so undocumented-edge
only). Fix: one `semverLt` guard in the agent, or a sentence in §11.12.

### C14. ✅ Superseded node socket: identity probe before dispatch (INFO · S)
`handleNodeMessage` live path has no `getLive(nodeId)?.ws === conn` guard
(held path has one); A's queued frames after supersede can rewrite the same
node's fresh facts with stale ones; no privilege crossing, same key,
same node. Optional: `ws.data.nodeConn === getLive(nodeId)` before the switch.

## Operator ruling: RESOLVED (2026-09-24)

### Q1. ✅ Ruled: disabling an account takes its NODES out of service
Verified behavior: disable kills the person's sessions, panes' tokens, and WS
mints, but `node-ws-handler.ts:189-217` never looks at the key owner's
disabled state: their enrolled machines keep connecting and taking LAUNCHES
(their own panes die since tokens mint per-launch for the disabled owner,
but the node stays operational as infrastructure). Docs say "unauthenticated
on both paths" meaning cookie+bearer REST; neither reading says nodes.
Ruling: **(b) HONOR: "2, but in the disable confirm dialog, inform the admin
what will happen."** Shipped same day: upgrade-chain tier refuses a disabled
owner's key (4403 close, pre-socket), the disable route evicts the target's
live AND held node sockets, `local`/system-owned rows unaffected, re-enable
recovers within the agent's 60 s backoff cap, `nodesDisconnected` rides the
audit metadata, and the admin's confirm dialog states the full effect list.

### Round-3 verification
Every item landed red-first with tests; the whole tree re-verified after the
last dependency bump: `verify-types`/`lint:check`/`lint:design`/`test`
(50 tasks)/`turbo build` all exit 0; `bun audit` 26 → 5 advisories, all
allowlisted (`scripts/dep-audit.ignore.json`), gated in CI via the new
`dep-audit` job on `lint.yml`. C8's dispatch premise ("SQLite re-creates
sidecars WAL-less") was DISPROVED by measurement before implementing; a stale
self-consistent WAL replays onto a restored snapshot, so the shipped order is
checkpoint-TRUNCATE before sidecar unlink. Known residue by decision: rows
renamed raw before C1 keep their bytes; operator ruled NO backfill
migration (2026-09-24, "Don't"); pre-users product, settled.

## Resolved: Round 2, 2026-09-23

### R1. ✅ Sign-in and sign-out are audited
`auth.sign_in` (better-auth after-hook, endpoint table; SUCCESS only: a
failed sign-in writes nothing so credential-stuffing can't spam the trail)
and `auth.sign_out` (session-delete DB hook: one row per session ACTUALLY
ended; the `/sign-out` endpoint answers success even when nobody was signed
in, so the row is the proof). Metadata: method (password/passkey) + ids,
never tokens, emails, IPs, or UAs. Break-glass deduped: its
`emergency_login.rewrite_credential` row wins, no parallel sign-in row.
Audit-write failure warn-swallowed; auth never breaks on the trail. §10
rewritten, §12 item satisfied, `audit-log.mdx` fixed. 12 tests incl. a
hand-forged full WebAuthn passkey ceremony. One existing keyset-ledger test
re-sequenced (its fixture's sign-in now lands above its snapshot).

### R2. ✅ Admin Setup-keys UI pinned by tests
Confirmed the original wave's component coverage (switch hidden for non-admins,
`?all=1` fires only after toggle, creator label, foreign DELETE), then added:
hook-level URL-shape pins (`search === "?all=1"`, disabled = zero fetches),
the shared-prefix invalidation proof (ONE invalidate, BOTH list shapes
re-read, revoked row gone from the all-cache), and in-place foreign-revoke
refresh. Mutation-verified non-vacuous. `use-nodes.test.tsx` +
`setup-keys-section.test.tsx`; web suite 1829/0.

### R3. ✅ Retention setter on the node
`GET/PUT /api/self/log-retention` (dashboard) with per-field layer truth
(`env|stored|default` + `forced`), per-field env-force refusal (409 naming the
variable; a combined write touching a forced field stores NOTHING; one status
can't half-report), 400 on junk/empty. Shared setter module
`retention-settings.ts`; the pass re-reads `config.json` hourly so changes go
live without restart; the stated honest limit: a node that BOOTED at `0+0`
scheduled no timer, so leaving keep-forever waits for restart. Node-local
`LogRetentionCard` on Settings (the debug-logging control sits in a
plane-SHARED card, so "beside it" was impossible without a plane twin route
that doesn't exist, recorded). No CLI verb invented: `configure` is
deliberately plane-address-only. Agent suite 749/0.

### R4. ✅ Attach journal: decision recorded
Stays log-only (info line: subshell id, geometry, build, 90-char UA slice into
the 0600 bounded file). Rationale in §10 next to the new auth events: audit is
for ACTS, the log for DIAGNOSTICS; those fields answer real stale-client bugs
and adding an audit row per attach would flood a 50-row reader. `auth.sign_*`
now covers the human half of "who was on".

## Held by decision: Round 2 (open until their trigger arrives)

### R5. Per-IP login backoff behind a gate (M, conditional)
Login backoff is per-email only; under a `public-with-gate` plugin every
request looks like 127.0.0.1. The shape is already prescribed (§8): read
`CF-Connecting-IP` ONLY where the Access guard verified the request, never any
other proxy header. **Trigger: the first genuinely public-gated deployment**;
building it now is dead code defending a scenario nobody runs.

### R6. Re-probe trimmed entitlements under a real Developer ID (S, release-gate)
Both desktop plists were trimmed to `allow-jit` +
`allow-unsigned-executable-memory` measured under AD-HOC signatures; a real
Developer ID + notarization changes what the system validates. **Before the
next desktop cut:** one signed build per app, confirm the bundled Bun binary
boots (failure mode = crash at process start, invisible to local tests).
Release-operator checklist item; needs the CI certificate.

## Deferred by decision (unchanged; re-open only with operator sign-off)

- **Web-push payload carries the subshell display name**
  (`services/notify.service.ts:53`); Expo names nothing. Documented §5.
  **Operator ruled to keep the name, 2026-09-24** ("let's not alter display
  names for web push"); the useful half of a notification wins; settled.
- **Expo relay anonymous** unless `EXPO_PUSH_ACCESS_TOKEN` set. Operator config.
- **5-minute better-auth cookieCache** for copied cookies: library design,
  the one surviving disable asymmetry (§2). **Operator ruled ACCEPT
  (2026-09-24)**; disabling it costs a DB read per request to narrow a
  5-minute window on better-auth-own endpoints that grant nothing in
  Subshell; documented, settled, not a defect.
- **Node loopback dashboard has no credential**: loopback + OS user IS the
  control (§6); `SUBSHELL_DASHBOARD=0` on shared hosts; §12 lists the
  credential as pre-public prerequisite. **Operator declined building one
  (2026-09-24)**; do not resurface unless the dashboard ever stops being
  loopback-only.
- **Instance plugin secrets** (`SUBSHELL_SECRETS_KEY`): designed, NOT built
  (§8); roadmap feature, not a defect. **Operator ruled: no vault until a
  real plugin needs one (2026-09-24, "no until we need it")**; the four
  built-ins deliberately need no reusable stored secret; env/config.env
  remains where plugin-adjacent credentials live. Build only when a shipped
  third-party plugin actually requires it.

## Resolved: Round 1, 2026-09-23 (condensed; full prose in git history)

1. ✅ Disable drops live WebSockets (parity with demotion; close 1012; audited count).
2. ✅ Bearer list enumeration KEPT (operator option A) + pinned by enumerate-ok/act-denied tests.
3. ✅ Node-side pane-log retention: days+hours, env>config>default 1 day, 0+0=forever, unknown-is-not-dead.
4. ✅ Admin setup-key `?all=1` view + revoke; `{foreign:true}` audit; SPA toggle.
5. ✅ Manifest parser refuses sudo/doas/pkexec at ANY shell boundary (basename-exact).
6. ✅ Plugin id-collision refused before the module loads; double-check kept pre-swap.
7. ✅ Backend `assertNodePathId` at all node-path composition sites (leaf module, cycle-aware).
8. ✅ WS attach-token store capped at 10 000 (sweep-then-503).
9. ✅ First-user promotion counts real accounts (shared filter, orphan-row witness).
10. ✅ Node api-key rows carry no permissions map; kind guard recorded as the whole boundary.

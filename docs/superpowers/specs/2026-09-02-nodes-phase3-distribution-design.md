# Nodes Phase 3 — Distribution, service, e2e, docs (Design 2026-09-02)

**Parent spec:** `docs/superpowers/specs/2026-08-31-nodes-design.md` §7/§8/§11 and
`docs/superpowers/plans/2026-08-31-nodes.md` "Phase 3". This design closes the
remaining Phase 3 scope; everything the enroller already shipped during Phase 2
is listed under "Already shipped" and is NOT rebuilt.

**Delegation note:** the product owner approved design §1 and delegated the
remaining design calls ("make what you think is the best decision from here on
out"); each ruling is marked **RULING** below. The three carried debt tickets
they selected are folded in (§7).

## Already shipped (Phase 2, verified on `main` at `fadb7af`)

- `GET /api/downloads/node/:target` + per-target `.sha256` routes — cookie-or-
  setup-key gate (`peekValid`, consumption-free), sidecar-wins + mtime-keyed
  cache, closed-target gate in-handler, tests (`downloads-route.test.ts`).
- `GET /install.sh` (root, pre-SPA) — platform detect, download, **sha256
  verify before exec**, `chmod +x`, `enroll`, next-step echo; usage-script
  (exit 2) on absent/invalid key, no oracle.
- `MOTE_NODE_ARTIFACTS_DIR` constant (+ default `<SESSION_DATA_DIR>/node-artifacts`).
- Add-node dialog renders `curl -fsSL "<origin>/install.sh?setup_key=…" | bash`.
- `.claude/rules/security-context.md` "Nodes" section per spec §11.
- Enroll-response loopback hint (backend side).

## 1. Release pipeline — cross-compile + atomic publish

- `apps/agent` gains script `compile:release` (a real `src/scripts/release.ts`
  under the app, run via `bun run`), kept SEPARATE from `compile` (host-only,
  `--bytecode`; dev loop untouched — **RULING**: cross builds never run in the
  normal `compile`/`build`/test path; first cross-build downloads the four
  target runtimes over the network, which must not be a hidden cost).
- Builds five artifacts into `dist/release/`: the four cross targets
  (`bun build --compile --target=bun-<os>-<arch> --minify`, NO `--bytecode` —
  spec risk #9) plus the host build (with `--bytecode`, identical to `compile`).
  Names: `mote-agent-<os>-<arch>` (the host build ships under its own triple
  too, so the downloads route can serve the control-plane host's arch).
- Each artifact gets a freshly generated `<name>.sha256` sidecar (64-hex +
  newline). Never reuse an old sidecar.
- **Publish = copy to `$MOTE_NODE_ARTIFACTS_DIR/<name>.tmp-<pid>` then
  `rename()`** — the atomic swap the downloads route's mtime cache contract
  requires. All-or-nothing: if ANY target fails (e.g. a runtime download), the
  script exits non-zero naming the failure and publishes NOTHING.
- The script resolves the artifacts dir from `MOTE_NODE_ARTIFACTS_DIR` exactly
  like `constants.ts` (same default) and refuses with a pointer to
  `turbo build` when workspace `dist/` outputs are missing.
- Root `package.json`: `release:agent` → `bun run --cwd apps/agent compile:release`.
- The release dance lands in `AGENTS.md`: `turbo build` → `bun run release:agent`
  → restart `mote.service` (and the `turbo build` wipes `apps/agent/dist` →
  re-`compile` gotcha).

## 2. `mote-agent service install|uninstall`

New `apps/agent/src/service.ts`, wired as `case "service"` in `cli.ts`
(subcommand `install`/`uninstall`; anything else → usage). Both require an
existing config (`run` refuses without it — same posture) and print what they
did.

- **Linux (systemd user):** write
  `~/.config/systemd/user/mote-agent.service` —
  `[Unit] Description=mote-agent (mote node daemon)`;
  `[Service] ExecStart=<line>, Restart=always, RestartSec=5`; then
  `systemctl --user daemon-reload && systemctl --user enable --now
  mote-agent.service`. After success print the linger hint:
  `loginctl enable-linger <user>` keeps the daemon across logout.
- **macOS (launchd):** write `~/Library/LaunchAgents/dev.mote.agent.plist`
  (`ProgramArguments` = exec line, `KeepAlive`, `RunAtLoad`, stdout/err to
  `~/Library/Logs/mote-agent.log`), then
  `launchctl bootstrap gui/<uid> <plist>` (tolerate "already bootstrapped" by
  bootout-then-bootstrap on reinstall). Uninstall: `launchctl bootout
  gui/<uid>/dev.mote.agent` (tolerate not-loaded) + remove plist.
- **Exec line (RULING):** the spec's "`process.execPath` so compiled binaries
  self-reference" generalizes to source runs: if `basename(process.execPath)`
  starts with `mote-agent` → `ExecStart=<execPath> run`; otherwise (running
  under `bun`) → `ExecStart=<execPath> <abs entry from process.argv[1]> run`.
- **Uninstall on a platform where nothing is installed** exits 0 with a note
  (idempotent). **Other platforms** ("win32", …): explicit "unsupported
  platform for service install" error, exit non-zero.
- Testability: `service.ts` exports `installService(deps)` /
  `uninstallService(deps)` with injected `{platform, home, execPath, argv1,
  uid, runCmd}`; unit tests assert the exact unit/plist text and the command
  sequence WITHOUT touching systemd/launchd. CLI case wires the real deps.

## 3. Install-script deltas + loopback warning

- `renderInstallScript`: add `--data-dir` pass-through via an env knob
  (`curl … | MOTE_DATA_DIR=/path bash`): when set, `enroll` gets
  `--data-dir "$MOTE_DATA_DIR"` and the binary is installed to
  `"$MOTE_DATA_DIR"/mote-agent` (default stays CWD, unchanged). Add one
  non-root guidance line to the final echo ("no root needed; it runs as the
  invoking user"). Add a **runtime loopback warning** in the script itself:
  when `SERVER` matches `https?://(localhost|127\.|::1|\[::1\])`, echo that
  remote machines cannot dial this URL.
- **Checksums "rendered on the Nodes page":** satisfied by the verified install
  path (download → `sha256sum -c` before exec); the dialog stays uncluttered —
  **RULING** (YAGNI: the human never types the digest).
- **UI loopback warning (RULING on plumbing):** add `appBaseUrl: t.String` to
  `GET /api/settings/public` (the value is already public — `usageScript`
  bakes `APP_BASE_URL` into a keyless response today). The Add-node dialog
  builds the command from `appBaseUrl` when present (fall back to
  `window.location.origin`), so the rendered command always matches what the
  script bakes; a loopback `appBaseUrl` renders an amber hint ("a remote node
  must dial this machine's VPN/LAN address — `APP_BASE_URL` currently points
  at loopback").

## 4. e2e — fake node agent + `12-nodes.spec.ts`

- `e2e/stub/mote-agent-fake.ts` — a plain **Bun script** (`bun`, never
  compiled; the real compiled binary must not be an e2e prerequisite — `turbo
  build` wipes `apps/agent/dist` per the known gotcha). It speaks the REAL
  protocol with real crypto: `POST /api/nodes/enroll` (setup key) → keep
  `{nodeId, nodeKey, controlPublicKey}` → connect `ws://…/ws/node` with the
  bearer header → `ready` (protocolVersion from `@internal/session-protocol`,
  `agentVersion: "e2e-fake"`, capabilities `[]`, os/arch, harnesses: the stub
  `pi` reported installed via `PI_PATH` parity) → per-frame JWS **verify**
  (jose `compactVerify` against `controlPublicKey`; enforce exp/aud, ignore
  seq) → execute against a REAL second tmux socket
  (`-L mote-e2e-node`, passed through the command bodies) using
  `@internal/harnesses` `TmuxRunner`: `launch` (new-session + pipe-pane log +
  meta record), `terminate`/`kill`, `capture`, `resize`, `input`,
  `prompt_deliver`, `log_read`, `tail_start`/`tail_stop` (fs.watch + backstop),
  `sessions_report`, `probe`/`probe_resume` (minimal), `stat_dir`;
  `write_file`/`remove_paths` → `result{ok:false,error:"unsupported"}`.
  Pane-exit watcher posts `exit`. Structure mirrors the real agent's command
  modules but stays standalone (~300 lines) — drift is acceptable here BECAUSE
  the protocol validators in `@internal/session-protocol` reject any frame the
  backend wouldn't accept, so drift fails loud.
- `e2e/tests/12-nodes.spec.ts` (admin state, workers:1): mint setup key via
  API → assert the Add-node dialog renders the install one-liner (and the
  loopback hint, since e2e is loopback by definition) → spawn the fake agent
  (`Bun.spawn`, env: server URL, key) → poll `GET /api/nodes` until online →
  Nodes page shows the row, OS/arch chips, harness chip → New-session form:
  node dropdown lists the fake node → create a session there (stub `pi`
  harness) → assert pane truth per the terminal gotcha (NO canvas-text
  asserts): session `running`, `/api/sessions/:id/log` contains stub output,
  ws-token + `/ws?session=` upgrade fires for the remote relay, resize round-
  trip 200 → terminate via API → session `ended`, fake-agent tmux session
  gone (`has-session` exit code), agent still online. Kill the fake agent in
  teardown.
- `e2e/seal.ts` (folded ticket, §7): becomes a re-export of
  `@internal/mcp-core` (`seal`, `open`, `DecryptError`, identity types); add
  the workspace dep (pinned `workspace:*`).

## 5. Docs close-out

- `docs/architecture.md`: new **Nodes** section — registry + wire (signed
  commands/unsigned events), NodeLauncher seam, ws/node relay, distribution
  (artifacts dir, downloads gate, install.sh), service install, trust boundary
  pointer to security-context.
- Root `AGENTS.md`: `apps/agent` in the directory tree (missing today),
  `release:agent` command + release dance, build-order note.
- `apps/agent/AGENTS.md` (+ `CLAUDE.md` mirror, repo pattern): app-specific
  commands (`compile` vs `compile:release` vs `build`), config/data-dir layout,
  `MOTE_AGENT_HOME`, service units, the `turbo build`-wipes-binary gotcha.
- `apps/backend/AGENTS.md` delta: downloads/install routes + artifacts dir
  under the routes tree, one line on the node-ws relay already documented.
- `apps/frontend/AGENTS.md` delta: Nodes pages + add-node dialog +
  `appBaseUrl`-sourced command.
- `.claude/rules/security-context.md`: one line under Nodes — artifacts are
  served to cookie-or-valid-setup-key only (never anonymous), digest-verifiable
  by design.

## 6. Error handling

- Release script: no partial publishes (§1); sidecar regenerated always.
- `service install`: `systemctl`/`launchctl` failure → print the failed
  command + stderr, unit file stays on disk (user can retry); non-systemd
  Linux (`DBUS_SESSION_BUS_ADDRESS` unset) → clear "start a systemd user
  session" error before writing anything.
- Fake agent: any verify failure closes with 1008 + stderr line (parity with
  the real agent); unknown command → `unsupported` result.

## 7. Folded debt tickets (user-selected)

1. **recent-paths form wiring** — `new-session-form.tsx` calls
   `useRecentPaths()` unscoped; pass the selected `nodeId` so recents follow
   the node (`?node=` gating shipped in FOLLOWUP-19; the form never used it).
2. **`e2e/seal.ts` mirror drift** — §4: re-export from `@internal/mcp-core`.
3. **Watcher re-registration window** (agent `commands/report.ts` shared tick)
   — a relaunch landing inside the forget-await un-watches the NEW pane (next
   natural death unreported until the `sessions_report` backstop). Fix the
   ordering (re-assert the watch set AFTER the forget settles; a pane present
   in the latest list is never dropped) and add the two accepted minors in the
   same pass: mid-tick-kill test, `intervalMs` arm-once.

## 8. Verification

Per task: root trio (`verify-types`, `lint:check`, `test`); `turbo build` after
backend schema changes (settings/public!) and re-`compile` the agent binary
after any build. Phase exit: full `bun run test:e2e` including
`12-nodes.spec.ts`, plus a real `compile:release` dry-run on this host
(publishes to a temp `MOTE_NODE_ARTIFACTS_DIR`, checks downloads route serves
the linux-x64 artifact + matching sha).

## 9. Explicit non-goals

- CI/GitHub-Actions publishing (operator-published release is the posture).
- Mobile node picker (stays deferred; server default `local` keeps behavior).
- Signing-key rotation flow, offline>N-days marking, semver-floor launch
  refusal (spec §12 open questions — unchanged).
- Displaying digests in the UI (§3 ruling).

## Deviation (execution, 2026-09-02)

- **§4's fake agent was never written.** Plan deviation #1 superseded it:
  `e2e/tests/12-nodes.spec.ts` spawns the REAL agent from source
  (`bun apps/agent/src/main.ts enroll|run`, `MOTE_AGENT_HOME` at a temp dir)
  via `e2e/stub/agent.ts` — the same "no compiled binary required" property,
  zero drift, real crypto. Recorded in the parent spec's
  "Errata (implementation, 2026-08-31)". The spec-12 story gained a
  connect-time inventory push along the way (plan tasks T8b/T8c; also an
  erratum bullet) — without it a fresh node was ONLINE yet 409'd every launch.
- Two statements here were already stale at writing, corrected by note rather
  than by prose rewrite: §1's "Builds five artifacts" is FOUR on a machine
  whose triple is served (the host build wins its own triple — `buildTargets()`
  in `src/scripts/release.ts`), and §9's "Mobile node picker (stays deferred)"
  shipped in Phase 2 (`apps/mobile/app/(tabs)/new.tsx` + `src/lib/node-anchor.ts`).

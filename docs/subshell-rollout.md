# Live-host rollout: mote → subshell (clean cut)

Run this after merging `rename/subshell` (or main once merged). It migrates THIS
host's systemd deployment, data dirs, and enrolled nodes. There are no
compatibility shims: the old names are gone from the code, so the deployment
must move in one pass.

**Read first:**

- Do this from a **plain shell / SSH session**, not from a Subshell-managed pane —
  step 3 kills every harness pane (tmux sockets are renamed `mote-<hash>` →
  `subshell-<hash>`; the new backend cannot attach old sockets, so running panes
  end here). Accepted, per the rename spec.
- Step 11 renames the repo directory — nothing can be running with that cwd
  (step 12's smoke test runs from the new path).
- Keep old units stopped but their files readable until step 12 smoke passes —
  the unit-file deletion happens only in the final cleanup note after it.
- `docker-compose.override.yaml` is untracked by design, so the rename never
  touched it: if you use Docker on this host, open it now — it still keys the
  service `mote:` while `docker-compose.yaml` now says `subshell:`, and
  `docker compose config` fails on the mismatch. (Fixed on this host during
  the rename; check any other machine.)

1. **Build fresh artifacts** (repo root):

   ```bash
   bun install && bunx turbo build
   ```

2. **Stop the control plane and any host agent:**

   ```bash
   systemctl --user stop mote.service
   systemctl --user stop mote-agent.service 2>/dev/null || launchctl remove dev.mote.agent 2>/dev/null || true
   ```

3. **Kill orphaned tmux servers** (all harness panes die — accepted):

   ```bash
   tmux ls 2>/dev/null; pkill -f 'tmux.*mote-' || true
   ```

4. **Migrate the server data dir and DB name:**

   ```bash
   mv ~/.config/mote ~/.config/subshell
   mv ~/.config/subshell/mote.db ~/.config/subshell/subshell.db
   mv ~/.config/subshell/mote.db-wal ~/.config/subshell/subshell.db-wal 2>/dev/null || true
   mv ~/.config/subshell/mote.db-shm ~/.config/subshell/subshell.db-shm 2>/dev/null || true
   ```

5. **E2EE/identity stores need nothing**: they live under the session data dir —
   `dirname(DATABASE_PATH)` — so step 4's `mv` carries `identities/` and
   `peers.json` along, and channel history stays readable. (To rotate identities
   instead of keeping them: `rm -rf ~/.config/subshell/identities ~/.config/subshell/peers.json`
   — old sealed posts then become unreadable and peers must re-pin.)

6. **Rewrite `MOTE_*` in every env file the service reads** (the unit's
   `EnvironmentFile` under `~/.config/subshell/`, plus any local `.env`):

   ```bash
   grep -rl "MOTE_\|mote\.db\|\.config/mote\|mote\.service" ~/.config/subshell .env* 2>/dev/null \
     | xargs -r sed -i -e 's/MOTE_/SUBSHELL_/g' -e 's/mote\.db/subshell.db/g' \
         -e 's|\.config/mote|.config/subshell|g' -e 's/mote\.service/subshell-server.service/g'
   ```

7. **Fix session working dirs that point at the old repo path** (run AFTER step 11's
   directory rename if you prefer; shown now for the live DB). The table is named
   `sessions` until migration 0019 runs at the renamed backend's first boot, `subshells`
   after — probe `sqlite_master` and target whichever exists:

   ```bash
   tbl=$(sqlite3 ~/.config/subshell/subshell.db \
     "SELECT name FROM sqlite_master WHERE name IN ('sessions','subshells') LIMIT 1;")
   [ -n "$tbl" ] || { echo "neither sessions nor subshells table exists" >&2; false; }
   sqlite3 ~/.config/subshell/subshell.db \
     "UPDATE $tbl SET working_dir = replace(working_dir, '/home/theo/projects/mote', '/home/theo/projects/subshell') WHERE working_dir LIKE '/home/theo/projects/mote%';"
   ```

8. **Drop ALL stored API keys — this step is mandatory, not cosmetic.**
   better-auth's api-key plugin applies the prefix only at *creation*;
   verification is a plain hash lookup, so old `mote_` keys **still authenticate**
   until deleted. This is also the opportunity to clear them wholesale (it is
   also the one irreversible step here — see Rollback):

   ```bash
   sqlite3 ~/.config/subshell/subshell.db '.schema apiKey'   # inspect first
   sqlite3 ~/.config/subshell/subshell.db 'DELETE FROM apiKey;'
   sqlite3 ~/.config/subshell/subshell.db "DELETE FROM \"user\" WHERE email='system@mote.local';"
   ```

   (`sessions.api_key_id` is a plain text column — no FK — so no reference
   cleanup is needed; live sessions re-mint their key on restart. The `user`
   delete drops the orphaned service user — boot creates `system@subshell.local`
   fresh, and the old row's keys are already gone with the DELETE above.)

9. **Install and start the new unit** (svc.sh now writes `subshell-server.service`
   with `DATABASE_PATH=$HOME/.config/subshell/subshell.db`):

   ```bash
   ./svc.sh install
   systemctl --user daemon-reload
   systemctl --user enable --now subshell-server.service
   systemctl --user disable mote.service
   ```

   The `disable` is load-bearing, not tidiness: while `mote.service` stays
   enabled it also starts at login, and the two backends then fight over the
   same sessions/nodes (WS supersede kicks → a permanent dial/reconnect loop
   until one is disabled). The old unit FILE stays until post-smoke cleanup.

   The new unit MUST carry `KillMode=process` (svc.sh writes it since
   2026-09-03; hosts rolled out before that need
   `~/.config/systemd/user/subshell-server.service.d/keep-panes.conf`):
   the backend's tmux servers live in this unit's cgroup, and the default
   control-group kill SIGKILLs every live pane on stop/restart — the
   `mote.service.d/keep-panes.conf` drop-in does NOT follow a renamed unit,
   and that is exactly how all running sessions died on the 2026-09-03
   restart after this rollout. Verify:
   `systemctl --user show subshell-server.service -p KillMode` → `process`.

10. **Re-enroll node hosts**: on each node, run the new enroll command from the
    Nodes page (fresh setup key). The old `mote-agent` binaries still dial in,
    but their rows can be deleted in the Nodes page once the new enrollments
    check out. On a macOS node, `subshell service install` creates a NEW
    launchd job (`dev.subshell.client` since the 2026-09-03 addendum) — it does
    NOT touch the old `dev.mote.agent` KeepAlive job, which would respawn the
    old agent alongside the new one;
    remove it explicitly (step 2 covers the control-plane host; on the node:
    `launchctl remove dev.mote.agent`).

11. **Rename the repo directory and the Claude memory folder — the only steps that
    must run from OUTSIDE the repo, with no Claude session open in it:**

    ```bash
    cd ~ && mv projects/mote projects/subshell
    mv ~/.claude/projects/-home-theo-projects-mote ~/.claude/projects/-home-theo-projects-subshell
    cd ~/projects/subshell && ./svc.sh install && systemctl --user daemon-reload \
      && systemctl --user restart subshell-server.service
    ```

    The `svc.sh install` re-run is NOT optional: the script bakes its own
    directory into the unit's `WorkingDirectory` and `EnvironmentFile`
    (`svc.sh:19,72-73`), so the step-9 unit points at the OLD path after the
    rename — the running service survives, but the next restart would fail on
    the missing `WorkingDirectory`.

    The GitHub repo `disaresta-org/mote` was renamed to `disaresta-org/subshell`
    and the local remote URL updated at merge time (plan Task 8) — after step 11,
    `git fetch` from the new directory confirms it.

12. **Smoke test**: sign in (your existing session cookie survives — better-auth
    cookies are baseURL-derived, not brand-derived); create a session; attach the
    terminal pane; in a Claude pane confirm the MCP server registers as
    `subshell` with tools `list_channels`, `create_subshell`, … (no prefix; the
    session-named tools became `list_subshells` / `get_subshell` / `create_subshell`
    / … in the 2026-09-02 rename below); fire a push notification and confirm the
    title reads `subshell`.

**Post-smoke cleanup** (only after step 12 passes):

```bash
rm -f ~/.config/systemd/user/mote.service
systemctl --user daemon-reload
```

**Rollback**: there is none in code. Restoring means checking out the pre-rename
commit, moving the data dir/DB names back (steps 4–6 reversed), and reinstalling
`mote.service` (run the old tree's `svc.sh`, or recreate the unit from
`git show HEAD~:svc.sh` if you already deleted the file — which is why cleanup
above waits for smoke). Step 8's key deletion does NOT roll back: every system
key must be re-created regardless.

---

## 2026-09-02: sessions → subshells (breaking)

One-time breaking rename of the product entity (no aliases, no compat shims):
REST `/api/sessions` → `/api/subshells`, WS `?session=` → `?subshell=`, DB
tables/columns renamed by migration `0019-subshell-rename` (runs on boot),
harness env `SUBSHELL_SESSION_ID` → `SUBSHELL_ID` and
`SUBSHELL_SESSION_NAME` → `SUBSHELL_NAME`, backend env `SESSION_DATA_DIR` →
`SUBSHELL_SERVER_DATA_DIR`. Pane meta + logs also move:
`<dataDir>/sessions/` → `<dataDir>/subshells/` on **both** the backend host and
every node — the code reads only the NEW path, so the `mv` steps below are
load-bearing (skip them and pane history silently starts empty).

1. **Backup the DB, then rebuild everything the rename ships** (repo root):

   ```bash
   cp ~/.config/subshell/subshell.db ~/.config/subshell/subshell.db.bak-0019
   bunx turbo build && bun run release:client
   ```

   (`release:client` republishes the node binaries — they bake the new
   `SUBSHELL_ID`/`SUBSHELL_NAME` env names. From a plain shell pass
   `SUBSHELL_NODE_ARTIFACTS_DIR` explicitly, per root `AGENTS.md`.)

2. **Backend host — env + pane-data dir.** Edit the unit's `EnvironmentFile`:
   rename `SESSION_DATA_DIR` to `SUBSHELL_SERVER_DATA_DIR` (same value), then:

   > **WARNING — forgetting this rename does NOT fail loudly.** The backend reads
   > only `SUBSHELL_SERVER_DATA_DIR`; the leftover `SESSION_DATA_DIR` line is
   > silently ignored and the value falls back to the dir derived from
   > `DATABASE_PATH`. If the fallback is not where the real data dir lives, the
   > control plane **lazily re-mints its secrets on first use**: a fresh
   > `node-signing.json` keypair (every enrolled node then rejects every command —
   > re-enroll all) and a fresh `vapid.json` pair (every web-push subscription
   > dies). Verify BEFORE the step-3 restart: the EnvironmentFile must name
   > `SUBSHELL_SERVER_DATA_DIR` with the same value, and that dir must already
   > contain `node-signing.json` and `vapid.json`.

   ```bash
   mv ~/.config/subshell/sessions ~/.config/subshell/subshells
   ```

   (The old path being moved is `<SUBSHELL_SERVER_DATA_DIR>/sessions`; it lands at
   `<SUBSHELL_SERVER_DATA_DIR>/subshells`. If the old dir doesn't exist the server
   never stored pane files there — skip the `mv`.)

3. **Restart the backend** — migration 0019 runs on boot, rows survive:

   ```bash
   systemctl --user restart subshell-server.service
   ```

4. **Every enrolled node**: re-run the enroll/update one-liner from the Nodes
   page (fresh setup key) so the agent binary picks up the new env names, and
   move its pane dir the same way — default data dir shown, substitute the
   `--data-dir` given at enroll:

   ```bash
   systemctl --user stop subshell.service   # or: launchctl remove dev.subshell.agent
   mv ~/.config/subshell-agent/data/sessions ~/.config/subshell-agent/data/subshells
   # …re-run the enroll one-liner, then start the service again (subshell run / service install)
   ```

5. **Mobile app**: rebuild + reinstall (it calls the renamed REST paths).

6. **Restart every running harness subshell** — the old `SUBSHELL_SESSION_*`
   vars are baked into live panes and `subshell mcp` now hard-fails without
   `SUBSHELL_ID`, so each one's MCP tools are dead until it is restarted (the
   terminal itself keeps working).

---

## Addendum 2026-09-03: client rename + config-home swap (spec 2026-09-03)

Clean cut, same rules as the main doc. ORDER IS LOAD-BEARING: the server
vacates ~/.config/subshell BEFORE the client moves in.

1. Server (control-plane host):

   ```bash
   systemctl --user stop subshell-server.service
   mv ~/.config/subshell ~/.config/subshell-server
   # .env / EnvironmentFile: update the DATABASE_PATH line to
   #   ~/.config/subshell-server/subshell.db
   # (svc.sh's regenerated unit now bakes the new path)
   systemctl --user daemon-reload && systemctl --user start subshell-server.service
   ```

   Docker users: same `mv`, plus check the UNTRACKED
   docker-compose.override.yaml for the old path (it still keys it).

2. Client on every enrolled host (including a host-agent here):

   ```bash
   subshell service uninstall 2>/dev/null || true      # old unit/plist, old name
   launchctl remove dev.subshell.agent 2>/dev/null || true   # macOS: stale KeepAlive guard
   mv ~/.config/subshell-agent ~/.config/subshell
   # config.json itself stores no env names (enrollment state only) — sweep
   # any HAND-KEPT env files that reference the old vars:
   grep -rl "SUBSHELL_AGENT_" ~/.config/subshell ~/.config/subshell-server 2>/dev/null \
     | xargs -r sed -i 's/SUBSHELL_AGENT_HOME/SUBSHELL_CONFIG_HOME/g; s/SUBSHELL_AGENT_SKIP_TMUX_CHECK/SUBSHELL_CLIENT_SKIP_TMUX_CHECK/g'
   ./subshell service install    # new binary from the release / apps/client build;
                                 # regenerates the unit/plist with the new names baked
   ```

3. Smoke: `subshell status --probe` on each node; Nodes page shows online;
   one test launch lands. Old `dev.subshell.agent`/`subshell.service` unit
   files: the new `service install` rewrites `subshell.service` (same name);
   launchd's old plist must be gone or it respawns the stale binary.

**Same-day path note:** the control-plane app now lives in `apps/server`
(`@internal/server`) and the client app in `apps/client` (`@internal/client`) —
deployment names are unchanged (`subshell-server.service`,
`SUBSHELL_SERVER_DATA_DIR`); the root release script is `bun run
release:client`.

## Addendum 2026-09-03 (later): subshell-server binary + CLI

The control plane also ships as ONE self-contained binary with the SPA
embedded (`bun run release:server` → `dist-server/subshell-server-<triple>`,
triples `linux-x64|linux-arm64|darwin-arm64`), carrying a CLI:
`subshell-server version | status | init | configure | service install |
service uninstall` (a bare invocation still boots — plan 2, spec 2026-09-03).
Nothing is forced by it: the disk-built frontend still wins over the
embedded copy, so existing deployments are byte-identical until switched.

- **This host: keep svc.sh.** `subshell-server service install` writes the
  SAME unit name as `svc.sh` (`~/.config/systemd/user/subshell-server.service`)
  — one owner per host. Until a deliberate cutover, the CLI here is
  read-mostly (`status` is a safe view of what the boot would resolve);
  the cutover itself would be `./svc.sh uninstall`, then `init` +
  `service install`, moving the repo `.env` values the unit currently
  exports into `~/.config/subshell-server/config.env` (0600) — the two
  flows share the DATA dir but not the config source (svc.sh: repo `.env`
  via `EnvironmentFile=`; CLI: `config.env`).
- **Mac host: the CLI is the binary-flow path.** Drop the ONE
  `subshell-server-darwin-arm64` binary on it, renamed `subshell-server`
  (it serves its own `mcp` subcommand — no companion to install;
  `subshell-server status` prints the resolved MCP entrypoint) — no
  bun, no checkout, no frontend dist needed (the SPA is embedded) — then
  `./subshell-server init && ./subshell-server service install` registers
  launchd agent `dev.subshell.server` (`~/Library/LaunchAgents/`, log
  `~/Library/Logs/subshell-server.log`).

Both `init`/`configure` and `service install` refuse without tmux
(the `local` node needs it; escape hatch `SUBSHELL_SERVER_SKIP_TMUX_CHECK=1`).
Details: `apps/server/AGENTS.md` ("Standalone binary & CLI").

---

## 2026-09-03 (evening): Mac-mini is live via the release binaries

`mac-mini` (172.16.2.177, arm64) now runs BOTH deployables from the GitHub
Releases, digest-verified before exec:

- **Server**: `subshell-server` 1.0.0 at `~/.local/bin`, launched by
  launchd `dev.subshell.server` (installed by `subshell-server service
  install`), bound 0.0.0.0:3080 behind `https://subshell.ein.disaresta.com`,
  config in `~/.config/subshell-server/config.env` (0600, NODE_ENV=production).
  Accounts: `theo@suteki.nu` (password in `/tmp/mac-admin-pw.txt` on the
  control-plane host — rotate after first login).
- **Client**: `subshell` 0.1.0 as node **mac-mini**, enrolled to this host
  (`https://mote.ein.disaresta.com`), launchd `dev.subshell.client`. Verified
  online with 5 harnesses; a launched subshell reached `running` on it.

Control-plane note: a CI account `deploy@subshell.local` (admin, password in
`/tmp/ci-admin-pw.txt` here) was created for key-minting — DELETE it in
Settings when no longer needed; it exists only because scripted login needs
the registration toggle flipped.

Update flow from now on: `gh release download <tag> -p 'subshell-*-darwin-arm64'`,
`shasum -a 256 -c`, move over `~/.local/bin`, `launchctl kickstart -k
gui/$(id -u)/dev.subshell.server` (or `.client`).

**1.4.0 upgrade (single-binary MCP):** one binary per triple again — the
`subshell-mcp-<triple>` companion is retired. After moving the new
`subshell-server` over, **delete any `SUBSHELL_MCP_COMMAND`/`SUBSHELL_MCP_ARGS`
lines from `~/.config/subshell-server/config.env`** (1.3.x stopgap keys): the env
override wins without an existence check, so a leftover line keeps baking the
deleted companion's path into every new pane. Verify with
`subshell-server status` — `mcp entrypoint = … (via self)`.

### 2026-09-03 (late): this host's data-dir migration — INCIDENT NOTE

`svc.sh install` regenerated this host's unit (new `DATABASE_PATH=~/.config/subshell-server/…`)
BEFORE the data `mv` ran; the next service restart opened a fresh empty DB — looked like a
full reset. Reality: nothing was lost. Recovery = stop service, shelve the interim DB files
(`*.interim-20260903`), move the REAL `subshell.db*` PLUS `node-signing.json`, `identities/`,
`vapid.json`, `mcp/`, `subshells/`, `node-artifacts/` into `~/.config/subshell-server/`, start.
Migrating the DB path and the data payload is ONE atomic step — do the `mv` in the same
window as the unit regen, every host. (Node reconnected without re-enrollment; signing keys
moved intact.)

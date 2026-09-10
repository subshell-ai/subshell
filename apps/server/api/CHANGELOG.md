# @internal/server

## 0.2.0

### Minor Changes

- [`6580d29`](https://github.com/subshell-ai/subshell/commit/6580d291219606b36a59a370880715beb8d92f56) Thanks [@theogravity](https://github.com/theogravity)! - A node now owns which harnesses it offers.
  
  `<dataDir>/plugins/` on the node is the answer: what is installed there is what that machine offers, and the enable table the control plane used to keep is gone. The node reports its set, the server mirrors it, and installing or removing one is a signed command to a running node. An offline node is refused rather than queued, so the Nodes page can never show a plugin a machine is not actually running.
  
  Two consequences you can see. A node can offer a plugin this control plane has never heard of, because the list comes from the node. And a node that has never reported shows nothing rather than a list invented here, which is the honest rendering for a machine running an older agent.
  
  Existing nodes keep working: on first start after upgrading, an agent seeds the built-ins it carries. That happens once, keyed on the plugins directory not existing yet, so uninstalling a plugin is not undone by the next restart.
  
  **This requires upgrading agents and the server together** (node protocol v6).

### Patch Changes

- [`da0dfaf`](https://github.com/subshell-ai/subshell/commit/da0dfaf6e2af6f913f81cd0bf1647fcb30505eb9) Thanks [@theogravity](https://github.com/theogravity)! - Harness detection now finds a harness installed through a version manager, says why a binary was not found, and reports when it last looked.
  
  The nvm fix in the previous release never ran: the production entry point suppressed the login-shell rung it added. That rung could not have fixed the case anyway, because nvm initializes in `~/.bashrc` and a non-interactive login shell returns early from it. Detection now globs the version-manager layouts directly (nvm, fnm, n, volta, asdf, mise, pnpm, bun).
  
  A lookup that fails reports `not-on-path` or `override-invalid`, so a mis-set `CLAUDE_PATH` is named instead of being answered with an install command that cannot help. Every entry carries the time it was probed, which is what distinguishes the control-plane host's live probe from an agent's cached inventory on screen.
  
  The version probe is now bounded, and the deadline holds even when the harness leaves a child holding its stdout.

- [`7e3d3be`](https://github.com/subshell-ai/subshell/commit/7e3d3bef23170f36644fe50c93025eaa1b4cf24d) Thanks [@theogravity](https://github.com/theogravity)! - The five built-in harnesses are now plugin packages behind a published contract.
  
  Nothing changes for a user: the same five harnesses are detected, launched and configured exactly as before, and parity is pinned by tests comparing each extracted plugin against the class it replaced. What changes is that a harness is no longer compiled into the control plane. `@subshell-ai/plugin-api` is the contract a third party builds against, and `packages/harnesses` is now `packages/pane-runtime`, which holds no plugin classes at all.
  
  One behaviour was nearly lost and is now explicit in the contract: Hermes prints a version banner rather than a bare version, so plugins can declare `parseVersion` to interpret their own probe output. The host still owns the timeout.
- Updated dependencies []:
  - @internal/pane-runtime@1.0.0

## 0.1.2

### Patch Changes

- [#34](https://github.com/subshell-ai/subshell/pull/34) [`e94135f`](https://github.com/subshell-ai/subshell/commit/e94135fee80751f08774fc882d212b92bc6bb195) Thanks [@theogravity](https://github.com/theogravity)! - Make the addresses an instance answers to configurable, so signing in from
  anything other than loopback no longer fails with 403 "Invalid origin". The
  allowlist was derived from the port, a *concrete* `HOST` and `APP_BASE_URL` —
  and on the default `0.0.0.0` bind the host is skipped and the base URL defaults
  to `http://localhost:<port>`, leaving only the two loopback spellings. A phone
  or a second hostname on the LAN sent an `Origin` nothing matched, and neither
  key was reachable from the desktop.
  
  Subshell Server console: **Public base URL** and **Other addresses browsers
  will use** join port and bind address, seeded from what the server reports and
  sent whole on save. `subshell-server configure` gains `--trusted-origins`
  (entries validated by component and stored canonicalized, so a trailing slash,
  a mixed-case host, expanded IPv6 or an explicit `:443` all work; wildcards and
  embedded credentials are refused), and `status` reports `TRUSTED_ORIGINS` plus
  per-entry `problems` — what a browser will *do* with a value the boot accepted,
  and which config layer supplied it — which the console shows beside the field.
  
  Node: `subshell configure --server <url>` repoints an enrolled node at a moved
  control plane without re-enrolling — it keeps the node id, node key and pinned
  control key, spends no setup key and mints no second node row (`enroll`, the
  only previous route, did all three). Subshell Client gains a matching
  **Repoint this node…** control, warns when its own control-plane address and
  the node's have drifted apart, and repoints both together.
  
  Fixes found along the way, all pre-existing:
  
  - `localOriginsFor` built its derived entries by string concatenation, so on a
    port-80 deployment `http://<host>:80` matched nothing a browser sends (80 is
    the scheme default) — the LAN address 403'd while `localhost` worked, from an
    entry that looked like it covered it. Every entry is now serialized through
    `URL.origin`.
  - `configure --port 080` was accepted and written, and the server then could
    not boot — nor could `status` or `configure`, which import the same module.
    The port must now be the canonical integer the boot accepts.
  - A mixed-case scheme (`HTTP://host`) was stored verbatim, and the node's dial
    URL is built by replacing the scheme with a case-sensitive match, so the
    agent tried to open a WebSocket to `HTTP://host/ws/node` and never connected.
  - `init --yes` reset every key it was given no flag for, so changing the port
    from the console silently repointed `DATABASE_PATH` and discarded a
    customised `APP_BASE_URL`. Stored values are now the defaults in every mode;
    flags still win. A value already on disk that this tool would not write is
    preserved with a warning rather than blocking the run.
  - `subshell enroll --server "  http://x  "` stored the padded string, which
    became a dial URL with spaces in it.

## 0.1.1

### Patch Changes

- [`ac5125d`](https://github.com/subshell-ai/subshell/commit/ac5125d22b231d3a51112e0110171e7b18f44efb) Thanks [@theogravity](https://github.com/theogravity)! - Fix `config.env` silently not applying under launchd (crash-looped macOS
  installs booting on defaults — `constants.ts` now applies the layer itself at
  import; systemd deployments were unaffected). `service status` reports the
  manager verbatim (`launchd: spawn scheduled`, and an unanswerable manager is
  `unknown`, not `stopped`) and names the log file (`logPath`), and
  `status` survives a PATH without `netstat`.
  
  Subshell Server console: reveal config.env, the server, the service
  definition and the log file in the file manager; the base URL is now "control
  plane URL" and opens in the system browser; port/host can be changed from
  every step; Start/Install are disabled with install advice while tmux is
  missing; installing a service is one click that also starts it; and the
  console re-probes after service verbs instead of landing on "installed but
  not running". The macOS login-items entry now reads Subshell Server with its
  icon instead of the signing organisation.
  
  Both desktop apps: close-to-tray now defaults ON, clamped off (switch
  disabled, refusal kept honest) on desktops where no tray answers.
  
  The node side got the same treatment. `subshell service status` reports the
  manager verbatim (crash-throttle `spawn scheduled`, and an unanswerable
  launchd is `unknown` with its stderr, not a confident "stopped") and names
  its log file; the macOS login-items entry for a node now reads Subshell
  Client with its icon. Subshell Client's page opens the control plane in the
  system browser, shows the log location and the manager's own words, and
  disables Enroll / Install / Start / Restart — with the install command named
  — while tmux is missing; its install button now says it also starts, because
  that is what the CLI does.

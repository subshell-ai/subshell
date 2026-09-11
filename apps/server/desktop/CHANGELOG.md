# @internal/desktop-server

## 0.2.0

### Minor Changes

- [#38](https://github.com/subshell-ai/subshell/pull/38) [`6a3daa8`](https://github.com/subshell-ai/subshell/commit/6a3daa8956f7d42658da5b55db03d104ef013468) Thanks [@theogravity](https://github.com/theogravity)! - First-run setup is now a guided wizard in its own window, and a hostname-confirmed "reset this machine" wipes the instance from the dashboard's Settings danger zone.

- [`e67b068`](https://github.com/subshell-ai/subshell/commit/e67b068a603991536ddad1668a198dc12a981f7c) Thanks [@theogravity](https://github.com/theogravity)! - One-press setup: a machine with nothing installed now gets a single disclosed "Set up and start" button instead of a four-step flow, and the app installs tmux (platform package manager, never a bare sudo) and Claude Code from the console instead of sending the user to a terminal.

### Patch Changes

- [`f760ae0`](https://github.com/subshell-ai/subshell/commit/f760ae048d5952ef727b3001d356f97dab18d1a8) Thanks [@theogravity](https://github.com/theogravity)! - The Subshell Server console moved to TypeScript, Vite and Tailwind (its logic now builds into `ui/dist`; `tauri dev`/`tauri build` run the build as their own before-hooks). Behavior is unchanged except a fix the rebuild caught: after a failed action the console's "That did not work. See the output below." line is no longer erased by the action's own re-probe before it can appear.

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

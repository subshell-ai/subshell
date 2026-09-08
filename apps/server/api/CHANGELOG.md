# @internal/server

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

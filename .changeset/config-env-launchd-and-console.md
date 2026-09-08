---
"@internal/server": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Fix `config.env` silently not applying under launchd (crash-looped macOS
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

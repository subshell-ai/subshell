---
"@internal/server": patch
"@subshell-ai/plugin-api": patch
"@subshell-ai/plugin-tailscale": patch
---

On macOS, Tailscale's card offers the app as the route and the daemon as the alternative

A Mac with nothing installed was told to `brew install --formula tailscale &&
sudo tailscaled install-system-daemon` and then grant an operator. That is the
open-source daemon, which Tailscale itself recommends "only for unattended
installs managed by experienced macOS system administrators", and the card named
nothing else. Installing the Tailscale app — which most people have or would
install — did not even clear the row: its CLI lives inside the app bundle and is
never on PATH unless the person enables the app's CLI integration.

Measured on 2026-09-16, the app's CLI drives `status`, `up`, `serve` and
`set --operator` with no root and no operator grant, because the app runs as the
local user and so does this server. Three things follow:

- Detection can name the bundle. A `knownPaths` entry that starts with `/` is
  now used as-is rather than joined onto HOME (which resolved
  `/Applications/Tailscale.app/…` to `$HOME/Applications/…` and silently matched
  nothing), so the app and both Homebrew directories are listed beside the
  HOME-relative one. The node agent shares that lookup and gains the same rule.
- Every run sets `TAILSCALE_BE_CLI=1`. Run with a bare environment the app's
  binary tries to start the GUI and dies with `Tailscale.CLIError error 3.`; the
  variable is inert for the formula and its wrapper.
- A privileged step can carry a `group`, which means ALTERNATIVE rather than
  next. The macOS row now prints one heading per route with an `or` between them
  and numbers inside a route only, where a flat 1-2-3 told a person to install
  the app AND the daemon. No other plugin is grouped, so no other row changed.

A dead daemon on macOS now says both routes too, since the plugin cannot tell
the app from the wrapper, and the two sentences cost less than a wrong guess.

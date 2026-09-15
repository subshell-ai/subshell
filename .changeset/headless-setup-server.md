---
"@internal/server": minor
---

Headless setup carries the sequence the desktop assistant carries.

`subshell-server init` is now the whole first run: it writes config.env as
before, then asks whether to run the server in the background and start it at
login (default yes, `--no-service` to skip), and ends by naming the address to
open — `Open http://…/setup in a browser to create the admin account.` Nothing
said that before: not `init`, not `configure`, not `service install`, not the
boot log, not `status`. `service install` prints the same line when run alone,
and the boot log says it once while no account exists.

- `install-server.sh` installs the control plane in one command: it resolves the
  platform, downloads the newest `server-v*` binary, verifies the published
  digest **before** the first `chmod +x`, installs to `~/.local/bin`, and runs
  `init`.
- `status` gained a `setup` line saying whether the admin account exists — the
  first question an operator has, from the command they are told to run first.
- `configure` warns about the LAN-bind trap: a wildcard bind with a loopback
  base URL and no trusted origins is the configuration whose only symptom is a
  403 "Invalid origin" naming nothing. The validator is shared, so the
  dashboard's Addresses card inherits it.
- The browser `/setup` wizard has a tmux row, detection-first, with an Install
  button where the package manager needs no privilege. `POST
  /api/setup/tmux/install` is admin-cookie only and refuses anything
  `sudo`-prefixed.
- Settings → General has a "Finish setting up" card listing only what is still
  undone: tmux, supervision and lingering, LAN sign-in, the placeholder auth
  secret, no agent CLI on this host. It renders nothing when there is nothing
  left.
- The agent-CLI installer has a second door: the control-plane node's harness
  card can install one, so skipping the wizard's agent step is recoverable.
- The Add-node dialog says what the one-liner will do to the machine, and its
  success line links to the node that arrived.

Interactive prompts are now rendered with `@clack/prompts`.

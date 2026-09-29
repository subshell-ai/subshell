#!/bin/bash
# First boot provisions config.env - and with it a unique BETTER_AUTH_SECRET
# (32 random bytes, 0600) - through the SAME init rail the install one-liner
# hands off to. Stdin is forced off-a-TTY so every question takes its skip
# branch no matter how the container was started; the volume then keeps the
# file forever, so updates (which replace the container, never the volume)
# never rotate the secret. (spec 2026-09-28 § 3)
set -euo pipefail
if [ ! -f "${SUBSHELL_SERVER_CONFIG_DIR:-/data}/config.env" ]; then
  subshell-server init < /dev/null
fi
exec subshell-server "$@"

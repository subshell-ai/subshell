#!/bin/bash
# First boot provisions config.env - and with it a unique BETTER_AUTH_SECRET
# (32 random bytes, 0600) - through the SAME init rail the install one-liner
# hands off to. setsid is what makes "no matter how the container was started"
# true: since 2026-09-26 init reads /dev/tty when stdin is /dev/null, so
# `docker run -it` alone would still prompt. Detaching the session makes
# /dev/tty answer ENXIO and init takes its skip branches on every spelling
# (setsid ships in util-linux, essential on trixie). The volume then keeps the
# file forever, so updates (which replace the container, never the volume)
# never rotate the secret. (spec 2026-09-28 § 3)
set -euo pipefail
if [ ! -f "${SUBSHELL_SERVER_CONFIG_DIR:-/data}/config.env" ]; then
  setsid -w subshell-server init < /dev/null
fi
exec subshell-server "$@"

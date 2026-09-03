#!/usr/bin/env bash
#
# svc.sh — manage subshell as a host systemd *user* service (no Docker).
# Shaped like the GitHub Actions runner's svc.sh: this script generates the
# unit file at install time and wraps systemctl around it.
#
#   ./svc.sh install     write ~/.config/systemd/user/subshell-server.service + enable
#   ./svc.sh uninstall   stop, disable and remove the unit
#   ./svc.sh start|stop|restart|status
#
# The service runs as the invoking user at boot (requires loginctl linger,
# checked by `install`), serves :3080, and keeps using the Docker deployment's
# data dir (~/.config/subshell-server) so accounts, sessions and logs carry over.
set -euo pipefail

SERVICE=subshell-server
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$SERVICE.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SERVER_PORT:-3080}"

usage() {
  sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

fail() {
  echo "svc.sh: $*" >&2
  exit 1
}

# --- guards (install) -------------------------------------------------------

check_prereqs() {
  [[ "${EUID}" -ne 0 ]] || fail "run as your normal user, not root (this is a --user unit)"
  [[ -n "${XDG_RUNTIME_DIR:-}" ]] || fail "no XDG_RUNTIME_DIR — systemd user session not available"
  command -v systemctl >/dev/null || fail "systemctl not found"
  systemctl --user is-system-running >/dev/null 2>&1 \
    || fail "the systemd user instance is not reachable (loginctl/linger problem?)"

  if command -v loginctl >/dev/null \
    && [[ "$(loginctl show-user "${USER:-$(id -un)}" --property=Linger --value 2>/dev/null)" != "yes" ]]; then
    fail "linger is off for $(id -un): the service would stop at logout and not start at boot.
  fix: sudo loginctl enable-linger $(id -un)"
  fi

  command -v bun >/dev/null || fail "bun not on PATH (needed at install time to record its path)"

  [[ -f "$REPO_DIR/apps/server/dist/index.js" ]] || fail "backend not built — run: turbo build"
  [[ -f "$REPO_DIR/apps/frontend/dist/index.html" ]] || fail "frontend not built — run: turbo build"

  local envfile="$REPO_DIR/.env"
  [[ -f "$envfile" ]] || fail "missing $envfile (BETTER_AUTH_SECRET / APP_BASE_URL live there)"
  grep -q '^BETTER_AUTH_SECRET=' "$envfile" || fail "$envfile has no BETTER_AUTH_SECRET"
  # (if/then, not &&: under set -e a passing grep's non-match would exit the script)
  if grep -q '"' "$envfile"; then
    fail "$envfile contains double quotes — systemd EnvironmentFile keeps them literally; remove them"
  fi
}

# --- unit generation (mirrors the Dockerfile's prod env) --------------------

write_unit() {
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=subshell-server — agent harness manager (host service)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=SERVER_PORT=$PORT
Environment=DATABASE_PATH=$HOME/.config/subshell-server/subshell.db
Environment=PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v bun) run ./apps/server/dist/index.js
Restart=unless-stopped
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  echo "wrote $UNIT_PATH"
}

# --- subcommands -------------------------------------------------------------

case "${1:-}" in
  install)
    check_prereqs
    write_unit
    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE"
    echo "installed & enabled; start with: ./svc.sh start"
    ;;
  uninstall)
    systemctl --user disable --now "$SERVICE" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload
    systemctl --user reset-failed "$SERVICE" 2>/dev/null || true
    echo "removed $UNIT_PATH"
    ;;
  start | stop | restart)
    systemctl --user "$1" "$SERVICE"
    ;;
  status)
    systemctl --user --no-pager --full status "$SERVICE" || true
    if curl -sf -o /dev/null "http://localhost:$PORT"; then
      echo "health: http://localhost:$PORT -> OK"
    else
      echo "health: http://localhost:$PORT -> NO RESPONSE"
    fi
    ;;
  *) usage ;;
esac

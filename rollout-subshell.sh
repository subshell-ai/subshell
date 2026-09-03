#!/usr/bin/env bash
# Live-host rollout: mote → subshell (implements docs/subshell-rollout.md).
#
# RUN FROM A PLAIN SHELL / SSH SESSION — never from a Subshell-managed pane:
# step 3 kills every harness pane (tmux sockets rename mote-* → subshell-*;
# the new backend cannot attach the old ones).
#
#   ./rollout-subshell.sh            # interactive: confirms before each blast
#   ROLLOUT_YES=1 ./rollout-subshell.sh   # unattended (you accept everything)
#
# Idempotent: safe to re-run after a partial failure; every step self-guards.

set -euo pipefail

REPO_OLD="$HOME/projects/mote"
REPO_NEW="$HOME/projects/subshell"
CFG_OLD="$HOME/.config/mote"
CFG_NEW="$HOME/.config/subshell"

step() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
say()  { printf '    %s\n' "$*"; }
confirm() {
  [ "${ROLLOUT_YES:-0}" = "1" ] && return 0
  read -r -p "    >>> $1 — type 'yes' to proceed (anything else aborts): " a < /dev/tty
  [ "$a" = "yes" ] || { say "aborted by operator"; exit 1; }
}

# You are about to kill your own substrate if run from a pane. Cheap heuristic
# guard, not a proof: managed panes almost always carry SESSION_TOKEN.
if [ -n "${SESSION_TOKEN:-}" ] && [ -z "${ROLLOUT_YES:-}" ]; then
  say "WARNING: SESSION_TOKEN is set — this looks like a Subshell-managed pane."
  confirm "continue anyway (this session will be orphaned)"
fi

step "0. Sanity: repo is built from the renamed code"
[ -f svc.sh ] || { echo "run me from the repo root"; exit 1; }
grep -q "SERVICE=subshell-server" svc.sh || { echo "svc.sh predates the rename — pull main first"; exit 1; }

step "1. Build fresh artifacts"
bun install >/dev/null && bunx turbo build >/dev/null && say "build ok"

step "2. Stop the control plane and any host agent"
systemctl --user stop mote.service 2>/dev/null && say "mote.service stopped" || say "mote.service not running"
systemctl --user stop mote-agent.service 2>/dev/null && say "mote-agent stopped" || true
launchctl remove dev.mote.agent 2>/dev/null || true

step "3. Kill orphaned tmux servers (ALL harness panes die)"
tmux ls 2>/dev/null || true
confirm "kill running tmux panes"
pkill -f 'tmux.*mote-' || true
say "tmux servers killed"

step "4. Migrate the server data dir and DB name"
if [ -d "$CFG_OLD" ]; then
  mv "$CFG_OLD" "$CFG_NEW"
  say "$CFG_OLD → $CFG_NEW"
fi
[ -d "$CFG_NEW" ] || { echo "no config dir at $CFG_NEW?!"; exit 1; }
for ext in "" "-wal" "-shm"; do
  [ -f "$CFG_NEW/mote.db$ext" ] && mv "$CFG_NEW/mote.db$ext" "$CFG_NEW/subshell.db$ext" && say "mote.db$ext → subshell.db$ext" || true
done
say "(step 5: E2EE identities ride along in the dir move — nothing to do)"

step "6. Rewrite mote remnants in env files the service reads"
grep -rl "MOTE_\|mote\.db\|\.config/mote\|mote\.service" "$CFG_NEW" "$REPO_OLD/.env"* 2>/dev/null \
  | xargs -r sed -i -e 's/MOTE_/SUBSHELL_/g' -e 's/mote\.db/subshell.db/g' \
      -e 's|\.config/mote|.config/subshell|g' -e 's/mote\.service/subshell-server.service/g' \
  && say "env files rewritten" || say "nothing to rewrite (clean)"

step "7. Fix stored session working_dirs (old repo path)"
n=$(sqlite3 "$CFG_NEW/subshell.db" \
  "UPDATE sessions SET working_dir = replace(working_dir, '$REPO_OLD', '$REPO_NEW') WHERE working_dir LIKE '$REPO_OLD%'; SELECT changes();")
say "working_dirs updated: $n row(s) rewritten"

step "8. Drop ALL stored API keys + the old system user (IRREVERSIBLE)"
sqlite3 "$CFG_NEW/subshell.db" '.schema apiKey' | head -3 || true
confirm "delete every stored API key (old mote_ keys otherwise STILL authenticate)"
sqlite3 "$CFG_NEW/subshell.db" 'DELETE FROM apiKey;'
sqlite3 "$CFG_NEW/subshell.db" "DELETE FROM \"user\" WHERE email='system@mote.local';"
say "keys dropped; boot will recreate system@subshell.local"

step "9. Install and start the new unit; disable the old one"
./svc.sh install
systemctl --user daemon-reload
systemctl --user enable --now subshell-server.service
systemctl --user disable mote.service 2>/dev/null && say "mote.service disabled (file kept until smoke passes)" || true

step "10. Node hosts (manual)"
say "Re-enroll each node from the Nodes page (fresh setup key)."
say "macOS nodes: launchctl remove dev.mote.agent after the new job is installed."

step "11. Rename the repo dir + Claude memory folder"
confirm "move $REPO_OLD → $REPO_NEW (must be run with no Claude session open in it)"
if [ "$PWD" = "$REPO_OLD" ]; then cd "$HOME"; fi
[ -d "$REPO_OLD" ] && mv "$REPO_OLD" "$REPO_NEW" && say "repo moved" || say "repo already at $REPO_NEW"
mv "$HOME/.claude/projects/-home-theo-projects-mote" "$HOME/.claude/projects/-home-theo-projects-subshell" 2>/dev/null \
  && say "claude memory folder moved" || say "claude memory folder already moved"
cd "$REPO_NEW"
./svc.sh install   # re-bake WorkingDirectory/EnvironmentFile at the new path
systemctl --user daemon-reload
systemctl --user restart subshell-server.service

step "12. Smoke"
sleep 3
systemctl --user is-active subshell-server.service && say "service active"
curl -sf http://127.0.0.1:3080/ | grep -q favicon && say "index.html serves the brand"
curl -sfo /dev/null http://127.0.0.1:3080/icons/favicon-32.png && say "favicon-32 200"
git -C "$REPO_NEW" remote -v | head -1
cat <<'EOF'

  Remaining by hand:
    - sign in (old session cookie survives), create a session, attach a pane
    - confirm MCP server registers as `subshell` in a Claude pane
    - push a notification → title should read "subshell"
    - once happy: systemctl --user disable mote.service (done above);
      rm ~/.config/systemd/user/mote.service && systemctl --user daemon-reload
EOF
say "ROLLOUT COMPLETE"

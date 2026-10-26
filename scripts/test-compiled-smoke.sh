#!/usr/bin/env bash
# Exercise the bundle without touching the operator's config or service.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/apps/server/api"
bun run compile
bin="$PWD/dist/subshell-server"
expected="subshell-server $(jq -r .version package.json)"
actual="$("$bin" version)"
[ "$actual" = "$expected" ] || { echo "version mismatch: got '$actual', want '$expected'"; exit 1; }
bash "$root/scripts/smoke-mcp-refusal.sh" "$bin"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$bin" "$work/renamed-server"
status_out="$(SERVER_PORT=31997 SUBSHELL_SERVER_CONFIG_DIR="$work/config" SUBSHELL_SERVER_DATA_DIR="$work/data" "$work/renamed-server" status 2>&1 || true)"
if printf '%s' "$status_out" | grep -q 'via self'; then
  echo 'renamed compiled binary resolved its MCP entrypoint from the build path'
  exit 1
fi
echo 'Compiled smoke passed: version, MCP refusal, renamed binary'

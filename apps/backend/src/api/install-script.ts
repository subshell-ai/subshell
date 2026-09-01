import { Elysia, t } from "elysia";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";

/**
 * Rendered body for a missing/invalid setup key. It is a SCRIPT (still exit
 * 2), never a 401 JSON — the surface is `curl … | bash`, and a JSON error
 * piped into bash would execute as garbage commands. The presented key is
 * deliberately not echoed: the "invalid" case renders byte-identically to
 * the "absent" case, so the endpoint is not a setup-key oracle.
 */
function usageScript(): string {
  return `#!/usr/bin/env bash
# mote-agent installer — a valid one-time setup key is required (spec 2026-08-31 §5.1/§8).
set -euo pipefail

echo "usage: curl -fsSL \\"${APP_BASE_URL}/install.sh?setup_key=SETUP_KEY\\" | bash" >&2
echo "       mint a key first: Settings → Node setup keys in the mote web UI." >&2
exit 2
`;
}

/**
 * Render the real installer for a validated setup key.
 *
 * The key is interpolated only into the single `KEY=` assignment (spec §11
 * posture: it rode in on the query string anyway) — every later use goes
 * through `$KEY`. It is safe to embed because `peekValid` just proved it
 * hashes to a live DB row, i.e. it matches the `nsk_<base64url>` mint shape;
 * no attacker-controlled string ever reaches this template.
 *
 * That safety argument leans on the CALLER, so the template also defends
 * itself: the first line re-checks the mint shape (`nsk_` + 32 base64url
 * chars, see `NodeSetupKeysRepository.create`) and falls back to the usage
 * script otherwise. Today it can never fire; it exists so a future row
 * writer (different mint format, imported keys) cannot silently regress the
 * no-shell-metacharacters property of this template.
 * @param key - The setup key, already validated with {@link NodeSetupKeysRepository.peekValid}
 */
function renderInstallScript(key: string): string {
  if (!/^nsk_[A-Za-z0-9_-]{32}$/.test(key)) return usageScript();
  return `#!/usr/bin/env bash
# mote-agent installer — rendered by mote for this instance (spec 2026-08-31 §8).
set -euo pipefail

SERVER="${APP_BASE_URL}"
KEY="${key}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)             TARGET="linux-x64" ;;
  Linux/aarch64|Linux/arm64) TARGET="linux-arm64" ;;
  Darwin/x86_64)            TARGET="darwin-x64" ;;
  Darwin/arm64)             TARGET="darwin-arm64" ;;
  *)
    echo "mote-agent: unsupported platform: $OS/$ARCH" >&2
    exit 1
    ;;
esac

echo "==> downloading mote-agent ($TARGET) from $SERVER"
curl --fail --silent --show-error --location \\
  "$SERVER/api/downloads/node/$TARGET?setup_key=$KEY" \\
  --output mote-agent

# Verify the digest BEFORE the file is ever executed. The endpoint answers
# with the bare 64-hex; sha256sum -c / shasum -a 256 -c both take the
# "<hash>  <file>" spelling.
EXPECTED="$(curl --fail --silent --show-error --location \\
  "$SERVER/api/downloads/node/$TARGET.sha256?setup_key=$KEY" | tr -d '[:space:]')"
printf '%s  mote-agent\\n' "$EXPECTED" > mote-agent.sha256
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c mote-agent.sha256
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c mote-agent.sha256
else
  echo "mote-agent: need sha256sum or shasum to verify the download" >&2
  exit 1
fi
rm -f mote-agent.sha256

chmod +x mote-agent

echo "==> enrolling with $SERVER"
./mote-agent enroll --server "$SERVER" --key "$KEY"

echo "==> installed and enrolled. start the agent with:  ./mote-agent run"
`;
}

const InstallQuerySchema = t.Object({
  setup_key: t.Optional(
    t.String({
      description:
        "One-time `nsk_…` setup key; absent or invalid renders the usage script (exit 2), never a JSON error",
    }),
  ),
});

/**
 * `GET /install.sh` — the one-line install entry point (spec §8):
 * `curl -fsSL <server>/install.sh?setup_key=… | bash`. Mounted at ROOT (not
 * under `/api`) and BEFORE the static SPA plugin in `server.ts`, which would
 * otherwise treat the dotted path as a dist file and 404 it.
 *
 * Deliberately NOT behind authGuard: the human pastes this into a terminal,
 * cookieless. The setup key's validity (peekValid — unconsumed, unexpired;
 * the consumption stays reserved for `enroll`) is the only credential, and
 * failing it yields the usage script, so every response on this surface is
 * `text/plain`.
 *
 * The baked `SERVER` is `APP_BASE_URL` — the same source `enroll` derives its
 * `wsUrl` from, so the install pipeline and enrollment always agree.
 */
export const installScriptRoute = new Elysia().get(
  "/install.sh",
  async ({ query }) => {
    const key = query.setup_key;
    const body =
      key && (await new NodeSetupKeysRepository(db).peekValid(key)) ? renderInstallScript(key) : usageScript();
    return new Response(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
  {
    query: InstallQuerySchema,
    detail: {
      operationId: "getInstallScript",
      tags: ["downloads"],
      description:
        "Renders the mote-agent install script (text/plain) — with a valid setup_key it downloads, verifies and enrolls; without one it is a usage error exiting 2",
    },
  },
);

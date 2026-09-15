import { COPYRIGHT_LINE } from "@internal/subshell-protocol";
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
# subshell installer: a valid one-time setup key is required (spec 2026-08-31 §5.1/§8).
set -euo pipefail

echo "usage: curl -fsSL \\"${APP_BASE_URL}/install.sh?setup_key=SETUP_KEY\\" | bash" >&2
echo "       mint a key first: Settings → Node setup keys in the subshell web UI." >&2
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
 *
 * Install dest / data dir: the DEFAULT install lands in `~/.local/bin/subshell`
 * — the same path Subshell Client's own installer writes — and runs the verb
 * WITHOUT `--data-dir`, so the agent keeps its own default data dir and a
 * stray `curl | bash` never relocates agent state. It used to be `./subshell`
 * in whatever directory the curl ran in, which a later `service install` then
 * baked into a unit file by absolute path: a stable home is what makes that
 * definition survive someone tidying up their downloads.
 * The `SUBSHELL_DATA_DIR` env knob OPTS into a relocated install: dest
 * `$SUBSHELL_DATA_DIR/subshell`, installer-created dirs at 0700, and
 * `--data-dir "$SUBSHELL_DATA_DIR"` so binary and state stay together —
 * `curl … | SUBSHELL_DATA_DIR=/opt/subshell bash` (`curl | bash` has no argv).
 * `SUBSHELL_NO_SERVICE` is the other knob: set, it forwards `--no-service` so
 * a scripted install enrolls and installs no background service.
 *
 * The script ends at ONE CLI verb, `setup` (spec 2026-09-15 §4.5), which is
 * where every question lives. It used to end at `enroll` plus a printed
 * suggestion to run `subshell run` — a foreground daemon that dies with the
 * SSH session that started it, with nothing on the whole path ever naming
 * `service install`.
 * @param key - The setup key, already validated with {@link NodeSetupKeysRepository.peekValid}
 */
function renderInstallScript(key: string): string {
  if (!/^nsk_[A-Za-z0-9_-]{32}$/.test(key)) return usageScript();
  return `#!/usr/bin/env bash
# subshell installer: rendered by subshell for this instance (spec 2026-08-31 §8).
set -euo pipefail

SERVER="${APP_BASE_URL}"
KEY="${key}"

# Install dest + setup --data-dir. Unset/empty SUBSHELL_DATA_DIR installs to
# ~/.local/bin and runs WITHOUT --data-dir (the agent keeps its own default
# data dir). Setting the knob OPTS INTO a relocated install: everything lands
# under $SUBSHELL_DATA_DIR, which the installer creates (0700, with any
# missing parents). The SETUP_DATA_DIR_ARGS expansion below is guarded
# ("+word" form) so the empty array stays clean under set -u even on bash 3.2
# (macOS default), where a bare empty-array expansion would abort as
# "unbound variable".
if [ -n "\${SUBSHELL_DATA_DIR:-}" ]; then
  DATA_DIR="$SUBSHELL_DATA_DIR"
  (umask 077; mkdir -p "$DATA_DIR")
  BIN_DIR="$DATA_DIR"
  SETUP_DATA_DIR_ARGS=(--data-dir "$DATA_DIR")
else
  # NOT the curl's CWD. A later \`subshell service install\` bakes this path
  # into a systemd unit or a launchd plist by absolute path, so the binary has
  # to live somewhere that outlives a tidied-up downloads folder — and this is
  # the same path Subshell Client installs the agent to, so one machine cannot
  # end up with two.
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  SETUP_DATA_DIR_ARGS=()
fi
DEST="$BIN_DIR/subshell"

# A warning, never a failure: the install itself works either way, and the one
# thing missing is being able to type \`subshell\` by name later.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "subshell: note: $BIN_DIR is not on your PATH, so the agent is installed" >&2
    echo "    but 'subshell' will not be found by name. Add it with:" >&2
    printf '      export PATH="%s:$PATH"\\n' "$BIN_DIR" >&2
    ;;
esac

# Runtime loopback guard (the enroll-time trap): the URL is baked at render
# time, but whether "localhost" is the WRONG machine is only known on the
# target. The [::1] arm stays quoted — unquoted it is a character class.
case "$SERVER" in
  *://localhost*|*://127.*|*"://[::1]"*)
    echo "subshell: WARNING: SERVER is a loopback address; a remote node" >&2
    echo "    must dial this machine's VPN/LAN address instead (Nodes page)." >&2
    ;;
esac

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)             TARGET="linux-x64" ;;
  Linux/aarch64|Linux/arm64) TARGET="linux-arm64" ;;
  Darwin/x86_64)
    # Refused BY NAME rather than resolved to a target that 404s. Intel Macs
    # are not a published target, and "this server publishes no binary for your
    # platform" would read as "the operator has not published one yet" — a
    # different problem with a different fix.
    echo "subshell: Intel Macs are not supported: no agent is published for darwin-x64." >&2
    echo "    Apple silicon and Linux have binaries; on an Intel Mac, run the agent from a checkout." >&2
    exit 1
    ;;
  Darwin/arm64)             TARGET="darwin-arm64" ;;
  *)
    echo "subshell: unsupported platform: $OS/$ARCH" >&2
    exit 1
    ;;
esac

# tmux BEFORE the download, and a warning rather than a refusal. A node cannot
# run a single subshell without it, and the old path let you find that out from
# a launch that failed an hour later — the enroll preflight refuses correctly,
# but by then a 70 MB download has already happened and nobody said why.
# Not fatal, because \`setup\` refuses properly on its own and a download is
# cheap next to an exit an operator cannot act on.
if ! command -v tmux >/dev/null 2>&1; then
  echo "subshell: tmux is not installed; a node needs it to run subshells." >&2
  case "$OS" in
    Darwin) echo "    install it with: brew install tmux" >&2 ;;
    Linux)  echo "    install it with: sudo apt-get install tmux   (or your distribution's package manager)" >&2 ;;
  esac
fi

echo "==> downloading subshell ($TARGET) from $SERVER"
# Download to a temp path and only REPLACE $DEST after verification: curl
# --fail leaves an existing output file byte-intact, so the historical
# fetch-straight-into-$DEST made a failed re-run in an installed agent's
# directory a clobber-or-delete of a WORKING binary. The HTTP code is
# inspected rather than curl's exit status alone — "404, this server has no
# artifact" and "401, your key is spent" need different advice (bare curl(22)
# said neither, and an exit-status-only guard says 404 for both, and for
# every network failure too).
TMP="$DEST.part"
if ! HTTP="$(curl --silent --show-error --location \\
  "$SERVER/api/downloads/node/$TARGET?setup_key=$KEY" \\
  --output "$TMP" --write-out '%{http_code}')"; then
  rm -f "$TMP" 2>/dev/null || true
  echo "subshell: could not reach $SERVER; nothing was installed ($DEST untouched)." >&2
  exit 1
fi
case "$HTTP" in
  200) ;;
  401)
    rm -f "$TMP" 2>/dev/null || true
    echo "subshell: the setup key was rejected: invalid, expired, or already used." >&2
    echo "    Mint a fresh one (Nodes → Add node in the web UI) and rerun the install command." >&2
    exit 1
    ;;
  404)
    rm -f "$TMP" 2>/dev/null || true
    echo "subshell: this server could not provide a $TARGET agent binary." >&2
    echo "    It serves what is in its node-artifacts dir, and downloads a missing build from the" >&2
    echo "    project's own node-vX.Y.Z release on first use — so this usually means the server" >&2
    echo "    cannot reach that release (no outbound network, or SUBSHELL_NODE_RELEASE_URL is" >&2
    echo "    empty). Check the server's log for the reason. To supply it by hand instead, run" >&2
    echo "    'bun run release:node' from a checkout on the server host, or copy the" >&2
    echo "    'subshell-node-cli-$TARGET' asset from a node-vX.Y.Z GitHub Release into that dir." >&2
    echo "    Or install the agent for this machine another way and run setup directly:" >&2
    echo "      subshell setup --server $SERVER --key $KEY\${DATA_DIR:+ --data-dir \\"$DATA_DIR\\"}" >&2
    exit 1
    ;;
  *)
    rm -f "$TMP" 2>/dev/null || true
    echo "subshell: server answered HTTP $HTTP for the agent download; nothing installed ($DEST untouched)." >&2
    exit 1
    ;;
esac

# Verify the digest on the temp file BEFORE it can be executed or replace
# $DEST. The endpoint answers with the bare 64-hex; sha256sum -c /
# shasum -a 256 -c both take the "<hash>  <file>" spelling. A mismatch is a
# corrupt download or a server serving a stale sidecar — either way the old
# $DEST survives.
if ! EXPECTED="$(curl --fail --silent --show-error --location \\
  "$SERVER/api/downloads/node/$TARGET.sha256?setup_key=$KEY" | tr -d '[:space:]')"; then
  rm -f "$TMP" 2>/dev/null || true
  echo "subshell: could not fetch the checksum; nothing was installed ($DEST untouched)." >&2
  exit 1
fi
printf '%s  %s\\n' "$EXPECTED" "$TMP" > "$TMP.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  VERIFY="sha256sum -c"
elif command -v shasum >/dev/null 2>&1; then
  VERIFY="shasum -a 256 -c"
else
  rm -f "$TMP" "$TMP.sha256" 2>/dev/null || true
  echo "subshell: need sha256sum or shasum to verify the download" >&2
  exit 1
fi
if ! $VERIFY "$TMP.sha256"; then
  rm -f "$TMP" "$TMP.sha256" 2>/dev/null || true
  echo "subshell: checksum mismatch: corrupt download or inconsistent server artifacts;" >&2
  echo "    nothing was installed ($DEST untouched)." >&2
  exit 1
fi
rm -f "$TMP.sha256"
mv -f "$TMP" "$DEST"

chmod +x "$DEST"

# Reattach the controlling terminal. \`curl … | bash\` leaves stdin on the pipe,
# which is at EOF by the time setup asks whether to install a background
# service — so the question would be answered by nobody and take its default
# with the operator watching. Written as an \`if\` rather than an "&&" chain
# because under \`set -e\` a chain whose first test fails aborts the install; and
# guarded on /dev/tty because a CI pipe has none.
if [ -t 1 ] && [ -r /dev/tty ]; then
  exec </dev/tty
fi

# The scripted opt-out (\`curl … | SUBSHELL_NO_SERVICE=1 bash\`), for anyone who
# wants enrollment without a service and cannot pass argv through a pipe.
SETUP_SERVICE_ARGS=()
if [ -n "\${SUBSHELL_NO_SERVICE:-}" ]; then
  SETUP_SERVICE_ARGS=(--no-service)
fi

echo "==> enrolling with $SERVER"
"$DEST" setup --server "$SERVER" --key "$KEY" \${SETUP_DATA_DIR_ARGS[@]+"\${SETUP_DATA_DIR_ARGS[@]}"} \${SETUP_SERVICE_ARGS[@]+"\${SETUP_SERVICE_ARGS[@]}"}

echo "==> done."
echo "    the agent runs as the invoking user; no sudo needed (data lives in \${DATA_DIR:-the default agent data dir})."
# A piped-curl install is a distribution, and the recipient never sees a
# LICENSE file: what lands is one bare binary. Naming the terms once here, and
# pointing at the subcommand that prints them in full, is the only moment this
# path has to do that.
echo "    ${COPYRIGHT_LINE}. Apache-2.0. Run \\"$DEST\\" license for the full notice."
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
        "Renders the subshell install script (text/plain): with a valid setup_key it downloads, verifies and enrolls; without one it is a usage error exiting 2",
    },
  },
);

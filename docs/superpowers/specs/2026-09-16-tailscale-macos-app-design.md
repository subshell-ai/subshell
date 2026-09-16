# Tailscale on macOS: the app as the first route

**Date:** 2026-09-16
**Status:** approved, ready to build
**Amends:** `2026-09-15-network-plugins-design.md` (Tailscale plugin, privileged steps)

## 1. The defect

On a Mac with nothing installed, the Tailscale card says to
`brew install --formula tailscale && sudo tailscaled install-system-daemon`
and then grant an operator. That is the open-source daemon variant, which
Tailscale itself recommends "only for unattended installs managed by
experienced macOS system administrators". Most people have, or will
install, the Tailscale **app** — Mac App Store or the standalone download —
and the card never mentions it.

Worse, if they do install the app, the card keeps saying "not installed":
the app's CLI lives at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
and is never on PATH unless the person enables the app's CLI integration.

Everything below was measured on 2026-09-16 on a Mac running the standalone
app, 1.102.4, with the CLI integration on (which installs a two-line shell
wrapper at `/usr/local/bin/tailscale`):

- `status --json`, `serve status --json`, `up`, `set --operator` all exist
  on the app's CLI. `serve` works. No root and no operator grant is needed:
  the app runs sandboxed as the local user, and the server runs as that
  same user.
- Run with a **bare environment**, the app binary tries to start the GUI
  and fails: `The Tailscale GUI failed to start: … (Tailscale.CLIError
  error 3.)`. With `TAILSCALE_BE_CLI=1` in the environment (documented at
  tailscale.com/kb/1080/cli) it behaves as a CLI. The wrapper script needs
  nothing.
- `brew install --cask tailscale-app` installs the standalone app (the cask
  was renamed from `tailscale` when the formula took that name).

## 2. The design

### 2.1 Detection finds the app

`knownPaths` entries are joined onto HOME by `detectBinaryWithOptions`
(`packages/pane-runtime/src/binary-lookup.ts`), so an absolute entry is
silently joined into `~/Applications/…` and never matches — the Tailscale
plugin's `cli.ts` docblock says so. An entry that **starts with `/`** is now
used as-is:

```ts
const candidate = isAbsolute(rel) ? rel : join(home, rel);
```

Same rung, same position in the ladder (after PATH, before version
managers), so nothing already detected changes. The `knownPaths` docblock in
`packages/plugin-api/src/manifest.ts` and `cli.ts`'s note both say
"HOME-relative, or absolute when it starts with `/`". The node agent shares
this function and gains the same rule, which is correct there too.

Tailscale's manifest:

```json
"knownPaths": [
  ".local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
]
```

The two Homebrew directories are listed because a launchd service's PATH
does not include them and the login-shell rung depends on the user's
profile; the app bundle is last so a person who deliberately installed the
formula beside the app keeps driving the formula.

### 2.2 Every invocation asks for CLI mode

`cli.ts` gains one helper used by every `host.run` in `status.ts`,
`join.ts` and `publish.ts`:

```ts
export function runTailscale(host, binary, args, opts = {}) {
  return host.run([binary, ...args], { ...opts, env: { ...opts.env, TAILSCALE_BE_CLI: "1" } });
}
```

No direct `host.run` remains in the plugin. Harmless for the formula build
and the wrapper, load-bearing for the app bundle.

### 2.3 Privileged steps can be alternatives

`PrivilegedStep` gains an optional `group?: string` (non-empty when
present; the parser refuses `""`). Steps sharing a group are one sequence;
different groups are **alternatives**. Steps with no group behave exactly as
today, so no other plugin changes.

Carried through the three restatements: `packages/plugin-api/src/manifest.ts`
(type + parser), `apps/server/api/src/api/network/schemas.ts`
(`PrivilegedStepSchema`), `apps/server/web/src/types/network.ts`, and
passed by `network-view.ts`.

**Card rendering** (`network-plugin-card.tsx`, the `not-installed` branch):

- No step has a group → unchanged.
- Otherwise, group the steps by `group` in first-appearance order. Each
  group renders a heading line (the group label, `text-detail font-strong
  text-foreground`) and its steps beneath, numbered within the group only
  when the group has more than one step. Between groups, a single muted
  `or` line (`text-detail text-muted-foreground`).
- `NetworkHints`' `startAt` is `undefined` when steps are grouped (a
  continued number would belong to no group). Tailscale emits no
  post-command hints in this state, so nothing visible changes there.

### 2.4 Tailscale's macOS steps

```json
"darwin": [
  {
    "group": "The Tailscale app (recommended)",
    "label": "Install the Tailscale app, or get it from the Mac App Store, then open it and sign in",
    "command": "brew install --cask tailscale-app",
    "docsUrl": "https://tailscale.com/kb/1016/install-mac"
  },
  {
    "group": "The command-line daemon",
    "label": "Install the Tailscale daemon",
    "command": "brew install --formula tailscale && sudo tailscaled install-system-daemon",
    "docsUrl": "https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS"
  },
  {
    "group": "The command-line daemon",
    "label": "Allow this server to control Tailscale",
    "command": "sudo tailscale set --operator=$USER",
    "docsUrl": "https://tailscale.com/kb/1080/cli"
  }
]
```

Linux is unchanged (no groups).

The cask stays **copy-only**, not an `install.command`: the standalone app
ships as a `.pkg`, and whether Homebrew installs that cask without a
password prompt is unconfirmed. A button that may hang on sudo is worse
than a line to copy.

### 2.5 Daemon-down on macOS names both routes

`daemonDownHints("darwin", detail)` becomes:

1. `{ text: "Tailscale is not running on this machine. If you use the Tailscale app, open it and sign in, then re-check." }`
2. `{ text: "If you installed the command-line daemon instead, install and start it, then re-check.", command: "sudo tailscaled install-system-daemon", docsUrl: <wiki>, privileged: true }`
3. the daemon's own `detail`, as today.

The plugin cannot cheaply tell the variants apart (the wrapper hides the
bundle path), and the two sentences cost less than a wrong guess. Linux is
unchanged. `needs-privilege` never arises on the app variant, so its hint
stays as it is.

## 3. Files

- `packages/pane-runtime/src/binary-lookup.ts` (+ its test).
- `packages/plugin-api/src/manifest.ts` (`knownPaths` doc, `PrivilegedStep.group`, parser) (+ test).
- `packages/plugins/tailscale/{package.json, src/cli.ts, src/status.ts, src/join.ts, src/publish.ts, src/hints.ts}` (+ tests).
- `apps/server/api/src/api/network/schemas.ts`, `network-view.ts`.
- `apps/server/web/src/types/network.ts`, `components/networking/network-plugin-card.tsx` (+ test).
- If `packages/plugin-api/README.md` documents `knownPaths` or
  `privileged`, update it in the same change.

## 4. Testing

TDD; each test seen failing first.

- **binary-lookup**: an absolute `knownPaths` entry pointing at an
  executable in a temp dir is found; a HOME-relative one still resolves
  against HOME; an absolute non-executable is skipped.
- **manifest parser**: `group` round-trips; `group: ""` is refused by name.
- **tailscale**: the darwin manifest has three steps in two groups with the
  labels above; `knownPaths` contains the app bundle path; every `host.run`
  the plugin issues (status, serve status, up with and without a key,
  serve reset, serve, serve reset on unpublish) carries
  `env.TAILSCALE_BE_CLI === "1"` — assert on a recording host;
  `daemonDownHints("darwin", …)` yields the three hints in § 2.5 and
  `"linux"` is unchanged.
- **network-plugin-card**: grouped steps render two headings, an `or`
  between them, numbering only inside the two-step group; ungrouped steps
  render exactly as before (existing test stays green).
- **network schemas / view**: `group` reaches the row.

Verification: `bunx turbo build`, `bun run verify-types`,
`bun run lint:check`, `bun run lint:design`, `bun run test`.

## 5. Out of scope

- Detecting WHICH variant is installed and tailoring later hints to it.
- Running the cask install from the page (§ 2.4).
- Any change to Linux steps or hints.

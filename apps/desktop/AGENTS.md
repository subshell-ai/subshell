# Desktop AGENTS.md

`apps/desktop` (`@internal/desktop`) — a **Tauri v2** shell that installs, runs
and manages a `subshell-server` on this machine, so a user never has to touch a
CLI binary.

## The two windows, and why they are two

| Window | Page | Why |
| --- | --- | --- |
| `console` | `ui/index.html`, bundled, `tauri://` | Must render with the server **down**, and is the only surface allowed to drive the CLI. |
| `main` | the SERVER's own SPA over `http://127.0.0.1:<port>` | `apps/frontend` is hard same-origin. |

**`main` never loads a bundled copy of the SPA.** `src/lib/api.ts` fetches
root-relative with `credentials: "include"`, `src/lib/auth-client.ts` sets no
`baseURL`, `src/lib/use-subshell-ws.ts` builds its WebSocket URL from
`window.location.host`, and there are zero `import.meta.env` reads in the whole
frontend. A `tauri://localhost` page cannot carry the `SameSite=Lax; httpOnly`
session cookie to any of them, and admin routes reject bearer keys by design —
so serving the SPA ourselves would mean an auth rework, not a build change.

## Commands

```bash
bun run dev:app            # tauri dev (needs a staged sidecar — see below)
bun run compile            # tauri build --debug
bun run compile:release    # the release pipeline (src/scripts/release.ts)
bun run test               # bun test src   (the TS half)
cd src-tauri && cargo test  # the Rust half — the ladder, the parsers, the policy
```

**There is deliberately no `build` script.** `bun run build` runs on hosted
`ubuntu-latest` in both `test.yml` and `lint.yml`, where there is no Rust
toolchain, so cargo must stay structurally out of the turbo `build` graph —
the same discipline `apps/mobile` uses to keep Xcode out. There is also **no
`dev` script**: root `bun run start` is `turbo watch dev`, which would
otherwise launch a Tauri window for everyone.

## The staged sidecar

`bundle.externalBin` is `binaries/subshell-server-bundled`. The staged file
carries the **Rust** triple (`…-aarch64-apple-darwin`); Tauri **strips** that
suffix on copy, so inside the bundle — and beside the dev binary — it is just
`subshell-server-bundled`. Those are two different strings and both are needed;
see `BUNDLED_SIDECAR_NAME` in `src-tauri/src/sidecar.rs`.

To stage one by hand for `tauri dev`:

```bash
SUBSHELL_SERVER_RELEASE_TRIPLES=darwin-arm64 \
SUBSHELL_SERVER_RELEASE_DIR="$PWD/apps/desktop/src-tauri/binaries" \
  bun run release:server
cd apps/desktop/src-tauri/binaries \
  && mv subshell-server-darwin-arm64 subshell-server-bundled-aarch64-apple-darwin \
  && rm -f subshell-server-darwin-arm64.sha256
```

Three rules about that binary:

- **`compile:release`, never `compile`.** Only the release build embeds the SPA
  (`src/generated/embedded-web.ts`); the plain `compile` ships the tracked stub
  with `EMBEDDED = false`, and `selectStaticPlugin` then throws at boot on a
  user's machine, where there is no `apps/frontend/dist` to fall back to.
- **Delete the `.sha256` sidecar.** It describes the bytes BEFORE Tauri re-signs
  the nested binary with `--force`, so it is a lie the moment the `.app` is
  sealed. Digests are never comparable between the bare-binary download channel
  and this one.
- **Never pre-sign or separately notarize it.** Tauri signs nested binaries
  inside-out with the bundle's single entitlements slot, and the app-level
  notarization mints tickets for nested files. A pre-minted ticket binds to a
  cdhash Tauri is about to replace.

`binaries/*` is gitignored — it is a ~110 MB build input.

## Where things live

```
src-tauri/src/
├── lib.rs         # plugins, command registration, setup (opens `console` FIRST)
├── windows.rs     # the two windows, the 1024px floor, the UA marker
├── control.rs     # the tauri commands — argument-poor wrappers over the CLI
├── server_bin.rs  # the resolution ladder, ExecStart parsing, bundled-vs-installed policy
├── sidecar.rs     # the shipped server, and installing it atomically
├── proc.rs        # every spawn: login PATH + a deadline
├── shell_env.rs   # the PATH a GUI app does not have
├── settings.rs    # three fields, one JSON file
└── version.rs     # semverLt, mirrored from the protocol package
```

## Things that will bite

- **A GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** No `/opt/homebrew/bin`,
  no `~/.local/bin`. `service install` runs a tmux preflight through an injected
  `which`, AND bakes `Environment=PATH=` from the installing process — so
  without `shell_env.rs` you get either a refusal or, worse, a service that
  installs cleanly and then cannot launch a single pane. Every spawn goes
  through `proc::run`, which injects the login PATH.
- **`execLine()` records two tokens for a dev-form install.**
  `ExecStart=/path/to/bun /repo/apps/server/src/index.ts`. Anything reading a
  service definition must carry both or it runs bun with nothing to run.
- **`disable_drag_drop_handler()` on `main` is load-bearing.** Tauri's native
  file-drop handler otherwise swallows HTML5 drag events, which silently breaks
  both drag-a-subshell-into-a-workspace (the `application/x-subshell-id`
  payload) and the terminal's own file-drop uploads.
- **`min_inner_size` is 1024×640, not a preference.** `useIsWide()` is
  `matchMedia("(min-width: 1024px)")`; below it the SPA renders its PHONE
  drawer — the exact chrome this app exists to replace.
- **Never downgrade the installed server.** Boot runs
  `migrator.migrateToLatest()`, which is forward-only. `decide_server` offers a
  newer bundled server and ADOPTS a newer installed one; the reverse is data
  loss, not a choice to present.
- **Icons** are generated with `tauri icon` from
  `apps/frontend/public/icons/icon-512.png`, itself a `brand/` output. Regenerate
  them from the brand master, never by hand.

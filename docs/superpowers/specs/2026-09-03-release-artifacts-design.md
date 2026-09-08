# Release artifacts: subshell-server & subshell binaries + component rename

Date: 2026-09-03
Status: implemented (plans 1–3 landed 2026-09-03; first releases server-v1.0.0 + client-v0.1.0 cut via workflow_dispatch)

## 1. Purpose

Ship installable release artifacts for the two deployables, versioned and
published independently from GitHub Actions:

- **server** — `subshell-server`, a single compiled binary per platform that
  embeds the built SPA (linux-x64, linux-arm64, darwin-arm64).
- **client** — the `subshell` node daemon, already compiled today by
  `release:agent` (linux-x64, linux-arm64, darwin-arm64, darwin-x64 — the
  served `NODE_TARGETS` set keeps darwin-x64).

Alongside: rename the client app so the product vocabulary matches
(`apps/agent` → `apps/client`, config dirs named per component), and give the
server binary first-run CLI ergonomics (`init` / `configure` / `service`) so a
standalone download is actually operable without a repo checkout.

### Spike evidence (2026-09-03, bun 1.4.0)

- `bun build --compile` of `apps/server/src/index.ts` bundles clean (1913
  modules); the binary boots, applies all 19 migrations from the static map,
  seeds the system user, and serves `/docs`.
- Cross-compiles with `--bytecode` succeed for **all four** triples (the old
  spec risk #9 — "bytecode + cross is a known compile risk" — does not
  reproduce on 1.4.0; the real agent entry cross-builds to darwin-arm64 with
  bytecode, 71 MB). Design decision 5 relies on this and pins a bun floor.
- Known gap: the SPA is read from disk (`FRONTEND_DIST` relative to
  `dist/index.js`), so a lone binary serves no UI → §4 embedding.

## 2. Naming (the whole table)

| Surface | Client | Server |
| --- | --- | --- |
| directory | `apps/client` (was `apps/agent`) | `apps/server` (was `apps/server`) |
| package | `@internal/client` (was `@internal/agent`) | `@internal/server` (was `@internal/backend`) |
| binary | `subshell` (unchanged) | `subshell-server` (new) |
| config/data home | `~/.config/subshell` (was `~/.config/subshell-agent`) | `~/.config/subshell-server` (was `~/.config/subshell`) |
| env override | `SUBSHELL_CONFIG_HOME` (was `SUBSHELL_AGENT_HOME`) | `SUBSHELL_SERVER_DATA_DIR` (unchanged) |
| systemd unit | `subshell.service` (unchanged) | `subshell-server.service` (unchanged) |
| launchd label | `dev.subshell.client` (was `dev.subshell.agent`) | `dev.subshell.server` (new) |
| release tag | `client-vX.Y.Z` | `server-vX.Y.Z` |
| artifacts | `subshell-<triple>` (unchanged) | `subshell-server-<triple>` |

The homes swap halves of their old names: the server vacates
`~/.config/subshell` first, then the client moves in. **Rollout ordering is
load-bearing** — `mv ~/.config/subshell ~/.config/subshell-server` BEFORE
`mv ~/.config/subshell-agent ~/.config/subshell`. The client's default changes
in code (`apps/client/src/config.ts`); the server's OLD location was never a
code default — `paths.ts` `DEFAULT_DATABASE_PATH` is `./data/subshell.db` and
`~/.config/subshell` arrives only via `svc.sh`/`docker-compose.yaml`, so the
server half of the swap is DEPLOY-FILE changes only. No compat shim
(precedent: the mote→subshell rollout was a clean cut); the rollout doc gains
the steps.

Code touchpoints (from grep): root `package.json` scripts, `e2e/stub/agent.ts`
(`AGENT_MAIN` → point at `apps/client/src/main.ts`, file renamed
`stub/client.ts`), `apps/server`/`e2e` comment references, `AGENTS.md`
(root + both apps), `docs/architecture.md`. The backend never imports
`apps/*` code; comment-only mentions update in the same commit.

## 3. Server CLI (new subcommands, compiled binary is self-sufficient)

Mirror the client's DI'd, test-pinned `service.ts` pattern.

```
subshell-server                    # foreground run (today's whole behavior)
subshell-server version            # from package.json import (client's version.ts pattern)
subshell-server init               # mkdir ~/.config/subshell-server; generate a random
                                   #   BETTER_AUTH_SECRET if absent; then run `configure`
subshell-server configure          # interactive Q&A; re-runnable any time
subshell-server service install | uninstall | status
```

- `configure` asks, each defaulting to the shown value (enter accepts):
  `SERVER_PORT` (3080), bind `HOST` (127.0.0.1; offering a LAN-bind choice),
  `APP_BASE_URL` (`http://localhost:<port>`, with the existing loopback warning
  when this server will be dialed by remote nodes), `DATABASE_PATH`
  (`~/.config/subshell-server/subshell.db`). Non-interactive flags
  (`--port --host --base-url --db-path`) plus `--yes` accept all defaults —
  that's what a future `install.sh` uses. `init` on a non-TTY is `--yes`.
  `configure` REWRITES `config.env` but carries the existing
  `BETTER_AUTH_SECRET` forward verbatim (never regenerates silently).
- Config file is `~/.config/subshell-server/config.env`, mode 0600, plain env
  syntax — deliberately NOT json: `constants.ts` already reads env via
  `env-var` with defaults, dotenvx is already a dependency, and a second
  config mechanism would be a second source of truth. The client's
  `config.json` stays json because it stores enrollment state, not knobs.
- Precedence: **process env > config.env > built-in defaults**. The binary
  loads config.env at boot before `constants.ts` evaluates.
- `service install` writes `subshell-server.service` (systemd user unit;
  `EnvironmentFile` → config.env, `ExecStart` → the binary's own path, baked
  `PATH` like the client's unit) or `dev.subshell.server` launchd plist on
  macOS — **macOS-as-server is in scope**. Refuses without config.env ("run
  init first"). `status` prints the resolved config (secret masked) +
  liveness.
- `svc.sh` and Docker keep working for the repo-checkout flow, unchanged.

## 4. Embedded SPA in the server binary

- Build-time generator `apps/server/src/scripts/embed-web.ts` (outside the
  runtime import graph, `import.meta.main`-guarded like the client's
  `release.ts`): walks `apps/frontend/dist`, emits gitignored
  `src/generated/embedded-web.ts` — a static `export const EMBEDDED_WEB:
  Record<string, string /* base64 */>` map plus a build-time assertion that
  `index.html` is present. Static import at the plugin; no dynamic imports
  (project rule).
- `static.plugin.ts` gains a memory mode sharing the existing content-type
  map and routing contract (SPA fallback → index.html, `/assets/*` immutable,
  traversal guard, `/api/*` untouched). Hash each value once at module init;
  serve ETag from the digest.
- **Precedence: disk dir when present, else embedded.** Dev checkout and
  svc.sh deployments behave byte-identically; the compiled binary has no disk
  dir and serves embedded bytes. Boot fails loudly when neither exists
  (today's "built frontend not found" throw, extended to "…and no embedded
  assets").
- Bytecode protects the TypeScript only; the SPA is served to browsers
  verbatim (minified) by design — stated so nobody later "fixes" this.

## 5. Build pipelines (both apps) — bytecode everywhere

- `buildArgs` ALWAYS includes `--bytecode --minify` (host and cross alike);
  the "host wins its triple" special case and the cross-without-bytecode rule
  are deleted from the client's `release.ts`; the comments retire risk #9 with
  a pointer to this spec's spike. Minimum release bun: **1.4.0** (asserted in
  both scripts' preflight).
- Server gets `apps/server/src/scripts/release.ts` cloning the client
  script's shape: pure exports (`buildTargets`, `buildArgs`, `buildAll`,
  `publishArtifacts`) + DI deps + `import.meta.main` CLI. Targets:
  `linux-x64 linux-arm64 darwin-arm64`. Shared helpers (`digestFile`,
  atomic tmp+rename publish) move to `@internal/subshell-protocol` beside
  `NODE_TARGETS`, and both scripts import them.
- The client's served-artifacts flow is unchanged in contract: local
  `bun run release:client` (renamed from `release:agent`) still publishes to
  `NODE_ARTIFACTS_DIR` for `GET /api/downloads/node/*`. New root
  `release:server` compiles `subshell-server-<triple>` locally for the
  operator's own host (embed preflight: requires `apps/frontend/dist`, like
  the agent's requires `packages/harnesses/dist`).
- All-or-nothing holds everywhere: a failed target publishes nothing.

## 6. Changesets (loglayer-style)

`@changesets/cli` + `@changesets/changelog-github`; `.changeset/config.json`
with `changelog: ["@changesets/changelog-github", { repo:
"subshell-ai/subshell" }]`, `baseBranch: "main"`, and `"ignore"` listing EVERY
workspace package except `@internal/server` and `@internal/client` — version
PRs touch only the two releasable apps; their versions drift independently
(hence `server-v*` vs `client-v*`). Both apps' `package.json` `private: true`
stands: changesets still versions private packages (it merely skips npm
publish, which we don't do at all).

Per-app `CHANGELOG.md` under `apps/server/` and `apps/client/` (changesets-
generated); root `CHANGELOG.md` stays as the hand-written highlights log.
Contributor flow: `bunx changeset` → pick app(s) + semver bump → version PR on
merge to main → release (below).

## 7. CI — `.github/workflows/release.yml`

Modeled on `loglayer/loglayer/.github/workflows/release.yml` (fetched
2026-09-03), adapted for private packages (changesets creates no tags for
them, so we tag ourselves). **As shipped (plan 3, 2026-09-03):**

1. **`changesets` job** — `push: main` (and every dispatch): bun 1.4.0 +
   node 22 (the `changeset` bin is a node-shebang script; the Linux runners
   ship node 18) → `changesets/action@v2` maintains the version PR
   ("chore: release package(s)"). NO publish script, and v2's
   `create-github-releases`/`push-git-tags` are switched off — releases and
   tags belong to the jobs below.
2. **`plan` job** — emits an EMPTY matrix on push events: merging the version
   PR does NOT auto-cut. **The first-cut path is an explicit
   `workflow_dispatch`** (`app` = server|client|both; blank `version` reads
   `apps/<app>/package.json`) — simpler and honest for a private-changesets
   repo, and it is the only cut path. Tag = `server-vX.Y.Z` /
   `client-vX.Y.Z`, created and pushed by THIS job before any build starts
   (no tag race downstream). An existing tag WITH a release skips the app; a
   tag WITHOUT one is the documented retry state — re-dispatching completes
   the half-cut (softprops creates the release on the existing tag).
3. **`build` job matrix** — one shard per `{app, triple}`, all on the owner's
   **self-hosted fleet** (no hosted runners): linux-x64 and linux-arm64 →
   `[self-hosted, Linux, X64]`, darwin-* → `[self-hosted, macOS, ARM64]`
   (mac-builder). **linux-arm64 is CROSS-BUILT on x64 — no native arm64
   Linux runner exists — and its smoke is digest sidecar + `file(1)` magic
   only, never an exec** (bytecode cross is proven on bun 1.4.0, §1 spike).
   darwin-x64 (client) smoke-runs under Rosetta on mac-builder (proven
   available; degrades to the magic check where it is not). Native triples
   exec-smoke: `version` output must carry the released version; the server
   additionally BOOTS on a temp DB with `apps/frontend/dist` moved aside, so
   `/` + `/docs` can only be served by the EMBEDDED SPA (the disk dir wins
   when present — hiding it is the proof). Each shard: `bun install` →
   `turbo build` → the app's release script scoped to its one triple →
   upload binary + `.sha256`. Node 22 via setup-node is load-bearing: the
   tsdown/rolldown bins are node-shebang scripts needing `util.styleText`
   (node ≥ 20.12; the Linux runners' node 18 broke the first dispatch).
4. **`publish` job** — per tagged app: `softprops/action-gh-release` creates
   the DRAFT with every artifact, then a second invocation (same tag, `draft`
   omitted) flips it live. Chosen over `gh release` because the Linux
   self-hosted runners have **no gh CLI** (measured). Any build failure ⇒ no
   release. Draft-last keeps the atomicity story CI-wide.
5. Cutting the CURRENT main is just a dispatch: `gh workflow run release.yml
   -f app=both`.

Scoping the release script to one triple: the scripts accept
`SUBSHELL_RELEASE_TRIPLES` / `SUBSHELL_SERVER_RELEASE_TRIPLES` (env,
space-separated) so CI shards reuse the exact local build code instead of
reimplementing flags.

Cost note: the fleet is self-hosted (no hosted-minute billing); mac-builder
doubles as the only darwin builder, and a full cut is 7 shards.

## 8. Error handling & atomicity

- Build scripts: non-zero exit + nothing published on any target failure
  (existing client contract, now also server + CI).
- `publishArtifacts`: per-file tmp+rename atomic swap, fresh `.sha256`
  sidecar per artifact (known per-file-not-per-set window documented in the
  moved helper's comment, unchanged semantics).
- `configure` writes config.env via tmp+rename (no half-written secrets);
  refuses (exit 1, no writes) on invalid port/base-url input rather than
  booting misconfigured.
- `service install` refuses without config.env; `service uninstall` does not
  (deleted-config-is-uninstall precedent from the client).
- CI: draft→published flip means a mid-matrix failure never ships a partial
  release; a dead runner leaves a draft (harmless, visible, deletable).

## 9. Testing

- **Moved protocol helpers**: existing client release-script tests follow
  `digestFile`/`publishArtifacts` into the protocol package.
- **Client `release.ts`**: tests re-pinned for always-bytecode argv +
  `SUBSHELL_RELEASE_TRIPLES` scoping (host-wins tests deleted).
- **Server `release.ts`**: mirror the client suite (targets, argv, all-or-
  nothing, scoping env).
- **`embed-web.ts`**: fake dist dir → map round-trips bytes exactly (incl. a
  binary asset with invalid UTF-8); missing index.html → generator fails.
- **static plugin memory mode**: fallback routing, content types, traversal
  guard, ETag, disk-precedence over embedded, loud failure with neither.
- **Server CLI**: `configure` prompt flow + `--yes` + flag overrides + secret
  carry-forward; `init` non-TTY → defaults; `service install/uninstall` unit
  and plist text pinned via `ServiceDeps`-style DI (copy the client's test
  approach); PATH baking.
- CI smoke steps (§7.3) are the integration layer; no e2e changes beyond the
  stub path rename.

## 10. Docs & rollout

- Root `AGENTS.md`: publish dance section gains `release:server`, the tag
  scheme, and the GitHub Releases flow; `release:agent` → `release:client`.
- `apps/client/AGENTS.md` (moved), `apps/server/AGENTS.md` (server CLI +
  release section), `docs/architecture.md` path mentions.
- New `docs/release-rollout.md` (or a dated section in the existing
  `docs/subshell-rollout.md`): the two ordered `mv`s, `launchctl remove
  dev.subshell.agent` + re-`service install` on enrolled hosts, `sed` pass for
  `SUBSHELL_AGENT_HOME` → `SUBSHELL_CONFIG_HOME` in unit/env files, and the
  server's new `~/.config/subshell-server` + `config.env` (svc.sh users can
  keep their EnvironmentFile; the DATABASE_PATH default is the only line
  that changes).

## 11. Out of scope

- npm publishing (packages stay private), Docker image publishing, code
  signing/notarization for macOS artifacts (trusted-network posture; revisit
  if distribution ever goes public), real JS obfuscation for the SPA,
  auto-update mechanisms, install.sh for the SERVER (only if wanted later —
  the CLI's init/service covers it), Windows targets.

## 12. Decisions log

- Server artifact = single embedded binary (chosen over tarball+web/,
  explicitly, this session).
- `--bytecode` on ALL targets after the 1.4.0 cross spike disproved risk #9;
  honest limit: deters inspection, does not prevent determined reversing.
- Changesets for versioning on the loglayer model; per-component tags
  `client-v*` / `server-v*`; CI builds per-triple on native hardware and
  smoke-runs every artifact.
- Client keeps shipping darwin-x64 (served set unchanged); server ships the
  requested three.
- Env-file config (not json) for the server; interactive `configure` under
  `init`; macOS-as-server supported.

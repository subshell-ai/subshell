# Release & CI

The publishing, release-cut, updates and CI-runner detail lifted out of
`AGENTS.md`, verbatim, so it loads when you are doing release or CI work
instead of in every session's preamble. **Read this before touching any of
it**: the `release:*` scripts, the release/docs/website workflows, version
bumps' interaction with npm, artifacts, signing/notarization, the runner
setup, or an update path. The always-loaded core (component id table,
changeset rules, "never cut tags by hand", pointers to the update rules and
the specs) stays in `AGENTS.md` under "Changesets & releases" and
"Updates".

### Publishing subshell binaries (Nodes)

The prebuilt `subshell` binaries served by `GET /api/downloads/node/*` (the
node enroll flow) are built separately from the app build. The release dance,
from the repo root:

```bash
bunx turbo build                          # 1. package dists the node binary bundles
bun run release:cli-node                  # 2. compile:release — cross-build + atomic publish
systemctl --user restart subshell-server.service     # 3. the server serves the new files
```

- `release:cli-node` runs `apps/node/agent`'s `compile:release` (`src/scripts/release.ts`):
  the four served triples (`linux-x64`, `linux-arm64`, `darwin-arm64`,
  `darwin-x64` — Intel Macs publish again, proven by bun 1.4.2's cross-build),
  each cross-built WITH
  `--bytecode` (uniform since spec 2026-09-03 §5); `SUBSHELL_RELEASE_TRIPLES`
  scopes a subset (CI uses this); each digested and published as
  `subshell-node-cli-<triple>` + a fresh `.sha256` sidecar via temp-file + `rename()`
  (the atomic swap the downloads route's mtime-keyed cache requires). See
  `apps/node/agent/AGENTS.md` for the app itself.
- Publish destination: `SUBSHELL_NODE_ARTIFACTS_DIR`, else
  `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts`, the same default the server resolves.
  From a plain shell none of those vars are set (the service gets them from its
  unit/`EnvironmentFile`), so the ladder silently publishes to
  `apps/node/agent/data/node-artifacts` where the server never looks; pass
  `SUBSHELL_NODE_ARTIFACTS_DIR` explicitly when deploying from a terminal.
- Cross builds download their target's bun runtime on first use; every target
  ships `--bytecode` (risk #9 retired at bun 1.4.0, spec 2026-09-03 §5; the
  pipeline refuses older bun). A failed target exits non-zero and publishes
  NOTHING, never a half set.
- **The artifact names carry `cli` as of 2026-09-07** (`subshell-node-cli-<triple>`,
  `subshell-server-cli-<triple>`), so a downloaded file says whether it is the
  CLI or the desktop app that wraps it. That makes republishing a DEPLOY-ORDER
  step, not a detail: an already-running instance's `node-artifacts` dir still
  holds the old names, and every node download 404s (`install.sh` says "this
  server could not provide a <target> node binary") until `release:cli-node`
  publishes into it again. The installed binary names are unchanged: a
  downloaded artifact is still renamed to `subshell` on install.

  `publishArtifacts` writes but never deletes, so after republishing, the
  old-named files are still sitting there, unreachable (nothing resolves to
  them any more) but occupying ~70 MB each. Clear them with:

  ```bash
  bun run prune:node-artifacts <dir>            # list what no target can produce
  bun run prune:node-artifacts <dir> --delete   # remove it
  ```

  Pruning is deliberately NOT part of publishing. `publishArtifacts` is an
  atomic-swap publisher rather than the directory's owner, and it is scoped by
  `SUBSHELL_RELEASE_TRIPLES`: a publisher that pruned would delete every
  triple it had merely been told not to build. The script instead decides from
  the COMPLETE target set, so a file survives if ANY current target could
  publish it; scope cannot reach it. It also leaves directories and in-flight
  `.tmp-<pid>` files alone.
- `turbo build` wipes the compiled `apps/node/agent/dist/subshell` dev binary;
  re-create it with `cd apps/node/agent && bun run compile`.
- Separately, `bun run release:cli-server` builds the **control-plane** binary
  (not a Nodes download artifact): the three `SERVER_TARGETS` triples
  (`linux-x64`, `linux-arm64`, `darwin-arm64`), each `--bytecode`, with the
  built SPA **embedded** so the binary serves the UI with no frontend dist
  on the host (an embed step overwrites, then `git checkout` restores, the
  tracked `embedded-web.ts` stub). Published atomically as
  `subshell-server-cli-<triple>` + `.sha256` to `SUBSHELL_SERVER_RELEASE_DIR`,
  default `<repo-root>/dist-server`, a local drop dir to scp/deploy; there is
  no data-dir ladder here. See `apps/server/api/AGENTS.md` ("Standalone binary & CLI")
  and its deep dive `apps/server/api/docs/cli.md` for the CLI
  (`init`/`configure`/`status`/`update`/`backup`/`service install|uninstall|status|start|stop|restart`)
  and config.env.

### Publishing the desktop apps

```bash
bunx turbo build                          # 1. workspace dists — the embed/bundle preflight
bun run release:desktop-server            # 2. stage the SERVER sidecar, then `tauri build`
bun run release:desktop-client            #    or stage the AGENT sidecar instead
```

Each script (`apps/<dir>/src/scripts/release.ts`) builds the CLI its app wraps,
stages it as the Tauri sidecar, and bundles. Three rules about that staged
binary, each with a failure that only appears on a user's machine:

- **`compile:release`, never `compile`**: for the server, only the release
  build embeds the SPA, and a stub-shipping binary throws at boot where there is
  no `apps/server/web/dist`.
- **Never pre-signed or separately notarized**: Tauri re-signs nested binaries
  with `--force` under the bundle's identity, so a prior ticket binds to a
  cdhash that no longer exists. The shard clears `SUBSHELL_RELEASE_SIGN_CMD`
  for the nested build.
- **Its `.sha256` is deleted**: it describes pre-seal bytes. Digests are never
  comparable between the bare-binary channel and this one.

Targets are `DESKTOP_TARGETS` (`linux-x64`, `darwin-arm64`), narrower than
`SERVER_TARGETS` and for a different reason: there is no native arm64 Linux
runner, and `file(1)` cannot see a GUI's characteristic failure, which is an
invisible window.

**Every published desktop artifact carries a `Desktop` suffix**, and every CLI
artifact carries `cli` (`subshell-server-cli-<triple>`, `subshell-node-cli-<triple>`),
because all four publish from this same repo into one downloads folder. Before
the markers, `subshell-server_0.5.0_amd64.deb` beside
`subshell-server-darwin-arm64` said nothing about which one was the
application. Both markers are on the FILE NAME only; `productName` stays
`Subshell Server` and the installed CLI is still `subshell-server`, so the
installed app, its window title, its menu bar and every CLI command are
unchanged. A test pins the whole set: across all four producers and every
triple, no published file (sidecars included) equals or prefixes another, and
each name carries the word (as a whole token, since `client` contains `cli`)
that says which kind it is.

One consequence is deliberate and worth knowing: Tauri derives the Debian
`Package:` field from `productName`, so it is still `subshell-server`. Two
packages cannot share a name, so a future server-CLI `.deb` would collide with, and on install replace,
the desktop app. The `/usr/bin` paths do NOT collide
(that is what the `-bundled` sidecar suffix buys), so this is package identity
only, and the lever if it ever matters is `productName`.

Artifacts are `Subshell-Server-Desktop-<version>-darwin-arm64.dmg` /
`Subshell-Client-Desktop-<version>-darwin-arm64.dmg` and
`subshell-server-desktop_<version>_amd64.deb` /
`subshell-client-desktop_<version>_amd64.deb` (no AppImage: `linuxdeploy` cannot
cross-compile and downloads at build time). The old "no DMG" rule was never
quite wrong: Tauri signs the image but still (2.11.5, measured) neither
notarizes nor staples IT: it stops at the `.app`. What changed is that the gap
is three commands, not a reason to ship tarballs: after `tauri build`, each
desktop pipeline runs `notarizeAndStapleDmg` (`@internal/subshell-protocol/release-artifacts`)
with the notary API credentials release.yml already exports, BEFORE the digest
(so the `.sha256` describes the stapled bytes), and the CI smoke mounts the
image and `stapler validate`s it, which is the check that the step actually
happened.

**Those published names are chosen HERE, not read off the bundler**
(`desktopArtifactFileName` in `@internal/subshell-protocol`), and they are
space-free because they are download URLs and shell arguments. What Tauri
emits is discovered instead: each pipeline asserts exactly one requested
bundle directory (the `macos/` and `share/` directories a DMG build also
fills, the `.app` intermediate and create-dmg's staging area, are tolerated,
never published), then GLOBS it for the one
`.deb` / `.dmg` that appeared (`selectBundleOutput`: zero or several is a
refusal, never a pick) and renames it into the published name. Discovery
rather than prediction, because the `.deb` name goes through Debian's own
package-name sanitizer and is not knowable without running the Linux bundler,
which is also what frees `productName` to be anything, spaces included.

The `.app` INSIDE the DMG (and the mounted volume) keep their real name,
`Subshell Server`, space and all, because that is what the user installs and
what the bundle identifier belongs to. A space in a bundle path is therefore
a real case: the published image name is space-free, and
`scripts/smoke-desktop-bundle.sh` quotes every path built from `PRODUCT`.

**The two apps' identities are four-way distinct on purpose**: crate name,
bundle identifier, `productName`, and sidecar stem. Both can be installed on one
machine, both put a binary in `/usr/bin` on Debian, and both keep a settings
file keyed by their identifier, so a shared string is a collision:
`dev.subshell.server` / `dev.subshell.client`, and Linux settings directories
`subshell-desktop-server` / `subshell-desktop-client`.

**Those Linux directory names are not the CLIs'**, and that asymmetry is the
point: `~/.config/subshell-server` is where the SERVER CLI keeps `config.env`
(`apps/server/api/src/config-env.ts`) and `~/.config/subshell` is the node CLI's
own config home (`apps/node/agent/src/config.ts`). A desktop app dropping
`settings.json` into either would put two different programs' state in one
directory, so each app prefixes `subshell-desktop-`. An identifier is an
identity rather than a label: it keys the macOS settings directory, the
notification permission grant, the single-instance lock and the window-state
store, which is why each app's `release.test.ts` and `lib.rs` pin it instead
of letting it live only at its use site.

Cargo crate names (`subshell-desktop`, `subshell-desktop-client`, also the
`/usr/bin` binary names in the debs) and sidecar stems
(`subshell-server-bundled`, `subshell-node-bundled`: they name the binary each
app WRAPS, not the app) are deliberately NOT renamed in step with the products,
and neither are the `desktop-server-v` / `desktop-client-v` tag prefixes: those
are the component ids, which used to be read off the directory name and are now
mapped to it explicitly (see "GitHub Releases" below).

Window titles, tray tooltips and menu titles read "Subshell Server" /
"Subshell Client"; those are free-form strings and are not `productName`. Keep
the word "node" wherever it names the control-plane CONCEPT rather than this
app: "register this machine as a node", the Nodes page, the `node_*` command
names, `NODE_TARGETS`.

The Linux shards run in `ghcr.io/subshell-ai/desktop-builder:ubuntu24.04`
(`docker/desktop-builder.Dockerfile`), so the apps' minimum glibc is **2.39 by
choice** rather than by accident of the runner image, which excludes Ubuntu
22.04 and Debian 12, and is the one lever if that has to change.

Shared Rust lives in `crates/desktop-core`: process spawning with a login PATH
and a deadline, the login-shell PATH probe, semver comparison, the settings
file, and the atomic sidecar install. It is a standalone package with a `path`
dependency from each app, NOT a cargo workspace: two apps, two `Cargo.lock`s,
two `target/`s, and no change to how either app builds. Deliberately outside it:
each app's `control.rs`, its binary-resolution ladder, and the whole
tauri-typed window/tray/menu layer, because the two window models genuinely
differ and an abstraction over one real consumer and one guess is worse than
the duplication.

### Updates: how an installation moves to the next version

Spec `docs/superpowers/specs/2026-09-15-updates-design.md` (read §15
"Amendments made while building": several decisions changed during the work
and the code, not §§1–14, is what shipped). Four facts worth holding before
you touch any of it:

- **Every component reads the SAME release list with the same pure code, and
  the same publisher signature.** `packages/subshell-protocol/src/releases.ts`
  picks the newest release of a component off the tag list by semver (never
  by date, because four components share one repository and "latest" is
  whichever was cut last), and `apps/server/api/src/services/releases.ts` is
  the I/O half, one fetch behind a 15-minute TTL. The URL is the only seam:
  `SUBSHELL_RELEASE_URL` (which replaced `SUBSHELL_NODE_RELEASE_URL`; there is
  deliberately no alias), **empty = air-gapped and every network path refuses
  by name**. If `downloads.subshell.sh` ever exists it serves this JSON shape
  at that URL and nothing else changes. Since spec 2026-09-17 each release's
  `release-manifest.json` is verified against `release-manifest.json.sig`
  (detached minisign, the desktop updater's keypair) by code in
  `@internal/subshell-protocol/release-signature` before ANY of it is trusted,
  at every update path and on the node itself, and the install digest comes
  from the manifest's signed `assets` map, never from the `.sha256` sidecar.
  The release source chooses WHICH signed release you get (including an old
  one); it cannot choose WHAT you run.
- **Every install of a binary is a transaction the NEW binary completes at
  boot.** Whoever swaps writes a marker and keeps the old file as
  `.previous`; whoever boots either finishes it (migrations pass → audit,
  delete both) or reverts it (restore the database backup, rename `.previous`
  back, record the failure, exit 1 so the manager respawns the old version).
  That is what makes the CLI path, the dashboard path and the desktop path
  ONE implementation. The node does the same without the database half.
- **Never write the installed binary by convention.** It is the file the
  SERVICE DEFINITION names, else the one this process IS, else nothing:
  `services/installed-binary.ts` on the server, `selfInvokePrefix()` on the
  node. Writing `~/.local/bin/subshell-server` on a host whose unit points
  elsewhere is an update that reports success and changes nothing.
- **The database is backed up before every upgrade**, and that is not a
  nicety: Kysely's migrator is forward-only and refuses names it does not
  know, so an old binary cannot boot on a newer database at all. Putting the
  old binary back without the snapshot is not a rollback.

Where each half lives: `apps/server/api/AGENTS.md` ("Updating the server") for
the four server modules, the measurements and `test:cli`'s `server-update.sh`;
`apps/node/agent/docs/update.md` for the node, the frozen `update`
command shape and the 4406 revert; `apps/server/desktop/docs/updating.md`
and `apps/client/desktop/docs/updates.md` (each app's `AGENTS.md` routes
there) for `tauri-plugin-updater`, `latest.json` and the `update --from`
delegation;
`docs/security.md` §11.12 for what all of it costs.

### Everything runs on GitHub-hosted runners

**Moved wholesale on 2026-09-11.** Every Linux job targets `ubuntu-24.04`
(pinned, never `ubuntu-latest`) because the runner image now sets the glibc
floor for every Linux artifact this repo ships: the desktop apps by design
(the builder image is 24.04 too), and the CLI binaries by inheritance (a
`bun build --compile` output links against the build host's glibc, and the
server/node Linux shards build bare on that runner). That floor is **glibc
2.39** for all of it, which excludes Ubuntu 22.04 and Debian 12 from running
anything, not just the GUIs. The darwin release shards run on `macos-14`:
GitHub-hosted Apple Silicon, native arm64.

The reason was operability, and the cost is the accepted trade: the repo is
public now, and hosted minutes are still metered on the free plan, so a push
bills what used to be free fleet time. What the fleet bought in persistence it lost in
visibility (its runners are org-registered, so the repo page shows none of
them, which is how a CI outage starts looking like a missing fleet), and
keeping machines cut-ready is standing human attention that stopped being
paid. A hosted runner is disposable and identical; a fleet runner that has
drifted is invisible until a job dies on it.

The org fleet still exists, and every workflow is written so it could pick
them up UNCHANGED: the un-root steps, the `git tag -f`, and the
`safe.directory` fixes each stay for exactly that reason. But no job names
its labels any more. `runner-maintenance.yml` and
`reset-linux-runner-workspace.yml` stay as fleet ops; with no jobs selecting
the fleet, they simply find nothing to do.

The one job that was hosted BEFORE the move, `release.yml`'s
**`npm-publish`**, stays hosted for the reason it always had: npm's OIDC
trusted publishing does not support self-hosted runners
(docs.npmjs.com/trusted-publishers, checked 2026-09-09), so it never had the
choice the others lost. Its gating survives intact: it runs only when the
`changesets` job's `needs_publish` output says npm is missing a version AND
the repo variable `NPM_PUBLISH_ENABLED` is `true`, so ordinary pushes never
attempt a publish. The alternative it displaced, an `NPM_TOKEN` checked
into repo secrets, remains rejected rather than quietly adopted.

`test.yml`'s eleven jobs run **inside the repo's own builder image**
(`ghcr.io/subshell-ai/desktop-builder:ubuntu24.04`, which is therefore the CI
image as well as the release one). The first job routes the other ten:
`scripts/ci-test-plan.ts` asks turbo which packages changed since the base
plus their dependents, and the test jobs `if:` on those flags: a docs-only
PR runs Plan and greys the rest, and every path the router cannot answer
fails wide to run-everything. Rust inputs are not in the turbo graph, so the
two Rust jobs stay unconditional. It already carries bun (1.4.2, pinned to
the root `packageManager` so CI runs what developers run), rustup stable and
Tauri's system dependencies; `tmux`, `rustfmt` and `clippy` were added for
CI's sake. That is what lets `setup-bun`, `dtolnay/rust-toolchain` and every
`sudo apt-get` stay out of the workflow. The image is PRIVATE (it inherits
the repo's visibility), and a container job pulls a same-repo ghcr image
with the job token: the `packages: read` permission is what authenticates
it; a PAT is not needed and none is used. Inside a container we simply ARE
root, which is also what makes Playwright's `install-deps` possible.

`lint.yml` and `cla.yml` run BARE: bun and a JS action need no system
libraries, and the builder image would buy nothing there.

Four things this arrangement makes load-bearing:

- **Toolchains come from the workflow, never from the runner image.** The
  fleet-era lesson (its node 18 broke rolldown's `styleText` floor) applies
  verbatim to hosted images, which float their own versions: `setup-bun`
  pins 1.4.0 where a job runs bare, `setup-node` pins 24 (the root
  `package.json`'s `engines.node`), and `actions/setup-node` is not
  optional just because the runner "already has node".
- **Every job needs `timeout-minutes`.** Minutes are now metered, so a hung
  job costs money instead of just fleet time, and the GitHub default of
  360 minutes is not a timeout, it is an outage either way.
- **Nothing persists between runs.** Hosted workspaces start clean; warmth
  comes only from the `actions/cache` steps (bun install cache, turbo,
  cargo, Playwright browsers), and correctness comes from not assuming a
  warm state. The fleet-era defect class (`git tag -f` in the plan job,
  because a tag deleted upstream survived in the runner's clone) cannot
  recur here; the flag stays so the fleet still works if it ever returns.
- **The un-root steps closing the container jobs are vestigial, kept on
  purpose.** A hosted runner is ephemeral, so chowning the workspace back
  changes nothing. They stay because the org fleet can still run these
  workflows, and there, skipping them poisons the next checkout with
  `EACCES`, the failure `reset-linux-runner-workspace.yml` exists to
  repair.

**Not done: running the containers as a non-root user.** It would restore
the one test skipped under root (`uploads-route.test.ts`, which chmods a
directory to 0500; root ignores permission bits) and let both the Chromium
`--no-sandbox` workaround and the un-root steps go. It needs
`container.options: --user 1000`; on the fleet that hardcoded a uid the
un-root step discovers at runtime with `stat`, and a differently-provisioned
machine made it fail nondeterministically. Hosted runners remove that
variance, so the trade is better than it was, but it still buys one test
and re-opens every container step to a CI round trip of proving, while the
un-root steps have to stay for the fleet's sake regardless.

The wall-clock cost the fleet-era write-up predicted but did not see did
materialise after the move. The persisted `target/` and `node_modules` made
fleet jobs faster (desktop Rust legs measured ~1m10s there against ~2m
hosted), and hosted CI pays a cache-restore for warmth instead, with every
one of those minutes metered. That is the trade as made, knowingly.

### GitHub Releases (CI: `.github/workflows/release.yml`)

The four pipelines run sharded in CI and ship as **GitHub Releases** under
component-scoped tags: `cli-server-vX.Y.Z` (three `subshell-server-cli-<triple>`
binaries + `.sha256` sidecars), `cli-node-vX.Y.Z` (3 + 3),
`desktop-server-vX.Y.Z` (2 + 2) and `desktop-client-vX.Y.Z` (2 + 2). Tagging
and releasing is OWNED BY THE WORKFLOW; never cut tags by hand.

**An app has two names, and the workflow keeps them apart.** It used to be one
string: tag prefix = directory = dispatch option = artifact prefix. Nesting
the apps broke that (`server/api-v1.9.0` is not a usable tag), so the plan job
carries an explicit table and emits BOTH names in every matrix entry:

| id (`matrix.app`) | directory (`matrix.dir`) |
|---|---|
| `cli-server` | `server/api` |
| `cli-node` | `node/agent` |
| `desktop-server` | `server/desktop` |
| `desktop-client` | `client/desktop` |

- **id**: the git tag (`tag="$app-v$version"`), the `upload-artifact` name,
  the publish job's download pattern and file glob, the dispatch option, and
  every `matrix.app == …` condition. These are PUBLISHED, so moving one is a
  cutover and not a rename: an installed binary looks only for its own
  compiled-in prefix. 2026-09-18 did exactly that to the CLI pair. The CLI pair carried no form marker
until then (`server`, `node`); renaming them to `cli-server` and `cli-node`
also removed a real wart: `desktop-server-v` used to have `server-v` as a
suffix, which both the TypeScript and the Rust tag parsers carried comments
about.
- **directory**: `apps/$dir/package.json` for the version read,
  `repo/apps/$DIR/CHANGELOG.md` for the release-notes slice, and every
  `--cwd`/`working-directory`/cargo path. Nothing else.

The plan job still asserts that no **id** is a prefix of another: the publish
job downloads `<id>-*`, so `desktop` and `desktop-client` as siblings would
have mixed two releases, and `fail_on_unmatched_files` could not have seen it
(it only fires on too FEW files). The guard is about ids, not directories.

Both desktop apps are releasable components on exactly the same terms as the
other two: their own changesets package, tag prefix, CHANGELOG sliced into the
release body, and shards in the same `build`/`publish` jobs. The only thing that
differs is the SHAPE of what they publish, a bundle rather than a bare binary,
which is why they share their own smoke, parameterized by app id.

- **Release assets:** `cli-server-vX.Y.Z` carries ONE binary per triple:
  `subshell-server-cli-<triple>` (SPA embedded; the binary serves its own
  `mcp` subcommand, so a server-only host self-resolves its MCP entrypoint);
  install that ONE file **renamed to `subshell-server`**: dropping only the
  triple would leave `subshell-server-cli`, which is not the name the service
  unit invokes. `cli-node-vX.Y.Z` carries `subshell-node-cli-<triple>` the same way,
  installed as `subshell`. The 1.3.x companion-binary era is retired.
  `desktop-server-vX.Y.Z` carries
  `Subshell-Server-Desktop-<version>-darwin-arm64.dmg` (Tauri signs it; the
  pipeline notarizes and staples the image before digesting; the smoke mounts
  it and validates the image's own staple) and
  `subshell-server-desktop_<version>_amd64.deb` (linux-x64);
  `desktop-client-vX.Y.Z` carries `Subshell-Client-Desktop-<version>-darwin-arm64.dmg`
  and `subshell-client-desktop_<version>_amd64.deb`. Each with a
  `.sha256`, and no AppImage (`linuxdeploy` cannot cross-compile and downloads at build time).
  **Every release also carries `release-manifest.json` + `release-manifest.json.sig`**
  (spec 2026-09-15 §3.2, signed by 2026-09-17 §7): the component id, the
  version, `NODE_PROTOCOL_VERSION`, `MIN_NODE_VERSION`, the commit sha and an
  `assets` map (published filename → sha256), written by each `release.ts` and
  shipped by the existing `files:` glob, plus the detached minisign signature
  over the manifest's EXACT bytes (shells out to `tauri signer sign` with
  `TAURI_SIGNING_PRIVATE_KEY`, the same keypair as the desktop updater, one
  publisher key for all four components). It exists so a control plane can
  answer "is this node release compatible with me" WITHOUT downloading a
  binary, and, since the signature, so every product can answer "were these
  bytes the publisher's" without trusting the release host: install digests
  come from the signed `assets` map, never from the sidecar. In CI the
  manifest is written PER SHARD (each names only its own triple, so the
  publish job merges them and signs once via
  `scripts/merge-release-manifest.ts`; the per-shard copies are deleted before
  upload; softprops collides by basename, and since `assets` diverged the
  collision would have silently published a one-platform release). A release
  without a manifest is treated as unknown and is not offered to nodes, true
  of every cut before 2026-09-15; an UNSIGNED one (no `.sig`, or one that does
  not verify against `RELEASE_PUBKEY`) is refused BY NAME too, true of every
  cut before 2026-09-17, which makes local unsigned publishes fine for
  one's own instance (digest-served) while a plane will never OFFER them.
  **Each desktop release carries more**, for the apps' self-update
  (§7.2): the updater package (`…​.app.tar.gz` on macOS, the `.deb` itself on
  Linux), `latest.json` (the updater plugin's static manifest, merged from
  the shards' `latest.<triple>.json` by a step in the publish job) and those
  per-triple `latest.<triple>.json` files themselves, which the shard glob
  (`dist/$APP-*/*`) sweeps up alongside everything else a shard produced.
  **The minisign `.sig` BESIDE A DESKTOP BUNDLE is NOT published, and that is
  deliberate** (this is about the updater signature over the bundle; the
  release-wide `release-manifest.json.sig` above is a different asset and IS
  published): the bundle's signature travels INLINE in `latest.json`, which is
  the only document `tauri-plugin-updater` ever reads, so a `.sig` beside the
  artifact would be an asset nothing consumes. `release.ts` says so at the
  point it reads the file. macOS bundles **`app,dmg`, not `dmg`**: the `.app` is
  the updater-enabled target, and asking for `dmg` alone makes tauri refuse
  with "requested to create updater artifacts but no updater-enabled targets
  were built". The `.app` and `share/` directories a DMG build also fills stay
  intermediates and are never published.
  Each bundle SHIPS the CLI it wraps, so a desktop cut re-releases that CLI: a
  server-only or node-only fix does not reach desktop users until the matching
  desktop cut, which is why a security-relevant release should be dispatched as
  `app=all`.
- **Never write a changeset for an `ignore`d package; it is inert and it
  wedges the version PR.** `.changeset/config.json` ignores ten workspaces,
  `@internal/server-web` among them, because they are not independently
  released: the SPA ships EMBEDDED in the server binary, so a version on it
  would name nothing a user can install. A changeset naming one of them can
  never be consumed: changesets will not version an ignored package, so the
  file stays on main forever and the action opens a "chore: release
  package(s)" PR whose `# Releases` section is empty, on every later push.
  That happened on 2026-09-11 (PR #39, from a `"@internal/server-web": minor`
  changeset) and it reads as a broken release pipeline rather than as a
  misfiled note. **Describe a change to one of those workspaces in the
  changeset of the APP THAT SHIPS IT**: SPA work belongs to
  `@internal/server`, pane-runtime or subshell-protocol work belongs to
  whichever of the four apps a user sees it through.
- **Version bumps (changesets):** `bunx changeset` after user-visible
  changes to any of the four releasable apps (or to `@internal/docs`, whose
  bump drives the docs deploy instead of a release cut) → a version PR ("chore:
  release package(s)") maintained on every push to main; merging it bumps the
  app's `package.json` + CHANGELOG. Merging does NOT cut a release; that
  stays true for the four GitHub Releases app cuts, which are an explicit
  `workflow_dispatch`. It DOES publish npm packages: merging the version PR
  bumps the seven `@subshell-ai/*` packages and the `npm-publish` job then ships
  them and pushes their `<pkg>@<version>` tags. The
  Action commits those bumps itself, which is why `version-packages` also
  resyncs `bun.lock`; see `AGENTS.md` ("The one thing `bun install` will not fix").
  All seven were bootstrapped on npm by hand at `0.0.1` (six on 2026-09-10
  and `@subshell-ai/plugin-terminal` on 2026-09-11) because a trusted
  publisher cannot be configured for a package that does not exist yet; every
  version after that comes from CI. **That bootstrap is done and needs no
  repeating.** The proof is on the registry rather than in anyone's memory:
  each package's later versions carry SLSA provenance attestations
  (`npm view <pkg> dist.attestations`) and its `0.0.1` does not, and an
  attestation comes only from a CI publish under OIDC, never from a hand
  `npm publish` at a terminal. (Strictly it proves "published by CI with
  `--provenance`" rather than "trusted publisher" specifically; since this
  repo's `npm-publish` job has no `NPM_TOKEN` to fall back on, the two are
  the same thing here.) An EIGHTH package
  would need the same bootstrap before a version PR including it can publish;
  until a package exists, CI can bump it forever and never ship it.
- **Release notes live in the GitHub Release.** The publish job slices this
  version's section out of `apps/<dir>/CHANGELOG.md` and passes it as the
  release body, so the page a user lands on says what changed instead of
  listing six assets. Treat `apps/<dir>/CHANGELOG.md` as a BUILD ARTIFACT, not
  a document to read or hand-edit: changesets renders it from the
  `.changeset/*.md` files (which it then deletes), and the release body is
  derived from it, so the two cannot disagree. This is the same mechanism
  changesets' own `createGithubReleases` uses; that path is off here because
  it fires only on npm publish, which is out of scope, and tags releases
  `<pkg>@<version>` rather than `<app>-v<version>`.
  The ROOT `CHANGELOG.md` is gone (2026-09-05): it predated changesets, still
  carried the monorepo template's 2024 history, and its `Unreleased` section
  described work that had shipped in 1.0–1.5. A hand-written changelog beside
  generated ones is the one that goes stale.
- **macOS signing + notarization (darwin shards):** the Release-build step sets
  `SUBSHELL_RELEASE_SIGN_CMD=scripts/macos-sign-notarize.sh` for darwin triples;
  the release scripts run it per artifact **between build and digest**, so the
  `.sha256` sidecars describe the signed bytes and a refused signature fails
  the shard (⇒ nothing publishes). Provisioning is SECRETS-BASED: the job
  builds a throwaway keychain from `MACOS_CERT_P12_BASE64` (password
  `MACOS_CERT_PASSWORD`) and notarizes with an App Store Connect API key
  (`NOTARY_API_KEY_P8_BASE64` + `NOTARY_KEY_ID` + `NOTARY_ISSUER_ID`), then
  cleans both up; NO host keychain state is read or written, so a new mac
  runner needs only the runner install + label. (Replaced 2026-09-03: the
  original host-keychain design failed three cuts three different ways and
  had no backup. The `.p12` in your password manager IS the backup.) Missing
  secrets or a chain-less identity fail the shard loudly. Entitlements: Bun's
  JIT keys from `scripts/macos-entitlements.plist`.
- **Updater signing (ALL FOUR components since spec 2026-09-17; both desktop
  shards before it)**: a SECOND keypair, unrelated to
  the Apple one, and the thing an installed component checks before it replaces
  itself. Operator, once:
  `bunx @tauri-apps/cli signer generate -w ~/.tauri/subshell-desktop.key`. **ONE keypair
  for the whole product line**: the four components are one publisher, and the
  pubkey is the publisher's identity rather than the app's. Commit the `.pub`
  contents as `plugins.updater.pubkey` in BOTH `tauri.conf.json`s AND as
  `RELEASE_PUBKEY` in `packages/subshell-protocol/src/releases.ts`; a test
  (`release-pubkey.test.ts`) pins all THREE spellings to one string, because a
  CLI build whose compiled-in key differs from what CI signs would refuse every
  release, which is exactly as dead as a lost key and less obvious. Set two repo
  secrets: `TAURI_SIGNING_PRIVATE_KEY`, which holds **the key file's
  CONTENTS, not a path** (measured 2026-09-15: tauri 2.11 does not read
  `TAURI_SIGNING_PRIVATE_KEY_PATH`), and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  The `.key` in your password manager IS the backup, exactly as the `.p12` is:
  **losing it means every installed component of all four kinds can never
  auto-update again**: a new key is a new publisher, and an app pinned to the
  old pubkey refuses everything signed with it. Two refusals guard the cut, both
  loud: EVERY shard (desktop and CLI) dies if `TAURI_SIGNING_PRIVATE_KEY` is
  unset, and `release.ts` refuses outright while the committed pubkey is still
  the `REPLACE_ME_…` placeholder.
  Publishing an unsigned updater artifact or an unsigned release manifest would
  be publishing a lie: every installed product refuses it.
  `apps/server/desktop/docs/updating.md` carries the full signing setup; the
  one local cost worth naming here: with the pubkey configured, `bun run compile`
  in either desktop app needs a private key set (a throwaway is fine);
  `tauri dev` bundles nothing and is unaffected. The CLI path's verifier is
  pure TypeScript (`@internal/subshell-protocol/release-signature`, node:crypto
  ed25519 over a BLAKE2b-512 prehash, the tauri CLI's "ED" pre-hashed scheme,
  pinned against real `tauri signer` fixtures); signing always shells to the
  real CLI, never a hand-rolled reimplementation.
- **The cut is an explicit dispatch:**
  `gh workflow run release.yml -f app=all` (or
  `app=cli-server|cli-node|desktop-server|desktop-client`, optional
  `-f version=X.Y.Z`; blank = read `apps/<dir>/package.json`). `all` is the
  input's default: every component is cuttable, and each desktop bundle ships
  the CLI it wraps, so the whole set is the safe cut.
  The plan job pushes the missing tag(s) FIRST, then one build shard per
  app×triple on GitHub-hosted runners (linux on `ubuntu-24.04`:
  linux-arm64 cross-built there, `file` magic check only, never exec'd;
  darwin on `macos-14`: darwin-arm64 natively, darwin-x64 cross-built and
  exec-smoked under Rosetta — the `rosetta` smoke mode every darwin-x64 launch
  runs through `arch -x86_64`). Native shards exec `version`; server shards also
  BOOT on a temp DB with `apps/server/web/dist` hidden (the embedded-SPA
  proof). Publish = softprops draft-with-assets → second invocation flips
  live; any build failure ⇒ no release.
- **A desktop cut re-ships a CLI.** Each desktop app bundles the binary it
  wraps, built from the same commit, so a fix to `apps/server/api` or `apps/node/agent`
  does NOT reach desktop users until the matching desktop cut. Dispatch a
  security-relevant release as `app=all`.
- **Retry:** a mid-flight failure leaves the tag without a release:
  re-dispatching COMPLETES the half-cut. Re-cutting a PUBLISHED version
  requires deleting the release and its tag first.

### Docs site (CI: `.github/workflows/docs.yml`)

The documentation site ships on its own tag and workflow, outside the four
release components: `docs-vX.Y.Z` is owned by the workflow (never cut by
hand), and what ships is the static export (`apps/docs/out/`) deployed to
Cloudflare Workers static assets at **docs.subshell.sh** (`apps/docs/wrangler.jsonc`,
custom-domain route; secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`). The dance, from the repo root:

```bash
bunx changeset          # docs work rides a `"@internal/docs": minor` changeset
# …merge the version PR, then, on main:
gh workflow run docs.yml
```

The properties that make a docs cut behave like a release cut: `plan` refuses
any dispatch not on `main` and any `-f version=` that disagrees with
`apps/docs/package.json` ("merge the changesets version PR first": same
refusal, same reason, as release.yml's); the tag has three cases: absent
creates, **present at THIS commit redeploys** (re-dispatch is how you re-push
a broken deploy, because for docs the deploy is the release), present at
another commit refuses until the tag is deleted. There is **no CI gate**: the
`ci-gate` job that waited for this commit's push-triggered Test + Lint runs
was removed by operator ruling of 2026-09-25, the day a flaky job in an
unrelated package's Test run blocked both site deploys until a human re-ran
it. What proves a site is `lint.yml` building its export on every push, and
PR CI before that; the gate only borrowed server/node test luck. (The specs
that designed it, 2026-09-16 docs and 2026-09-23 website, keep their gate
sections as dated records.) The export is static for now
(`output: "export"`); the vinext-at-1.0 follow-up lifts that. Broken docs
fail PR CI, not just the deploy: the package's `build` script runs inside
`bun run build`, which `lint.yml` runs on every push. The marketing site
(`apps/website`, `website-v*` tags, `website.yml`, subshell.sh) follows the
identical deploy shape, gate removed there too.

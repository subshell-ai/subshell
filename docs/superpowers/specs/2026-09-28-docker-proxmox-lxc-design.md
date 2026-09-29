# Docker image + Proxmox LXC install rail

Date: 2026-09-28
Status: approved design, pre-implementation
Builds on: `2026-08-31-docker-deploy-design.md` (the dev compose rail), `docs/release-and-ci.md` (release shards and signing)

## 1. Problem

Self-hosters on Proxmox have no supported way to install Subshell. The product ships
a compiled binary plus a one-liner installer and a systemd-user service; none of that
matches how Proxmox users install apps, which is helper scripts that create an LXC.
The repo's existing root `Dockerfile` is a dev artifact: it runs built sources under
bun instead of the release binary, its deps stage no longer resolves, and its own
header says it is broken and unbuilt.

Goal: people can install Subshell on a Proxmox host with one curl command, and update
it later with one command, with data and sessions surviving the update.

## 2. Decisions

| question | ruling |
|---|---|
| Install shape | Proxmox helper-script convention: root script on the host creates an unprivileged LXC with Docker inside (nesting=1) running our GHCR image. Standard verbs (install/update/remove/backup/restore). |
| Update path | Image-pull. The helper script's `update` verb pulls the new image and recreates the container. The in-place binary updater stays refused inside a container; the UI points at the script instead. |
| Image contents | Server binary + tmux + all five harness CLIs (claude-code, codex, opencode, hermes, pi), so panes work on a fresh install. |
| Architectures | linux/amd64 and linux/arm64, both from the already-published release shards. |
| Binary source | The image packages the published, signed release binary. It does not compile. One artifact, one source of truth; `subshell-server version` answers the same inside Docker and outside it. |
| Secrets | Per-install generation, no shared value in the image. Entrypoint runs `init` when the volume has no config (see §3). |

## 3. The image

- Base `debian:trixie-slim`. The Linux release floor is glibc 2.39; trixie carries
  2.41, and trixie is what the helper script's LXCs run, so host and container agree.
- A `subshell` runtime user (uid 1000), `HOME=/home/subshell`, config and DB under a
  single `/data` volume.
- Baked at build time: `/usr/local/bin/subshell-server` (verified release binary),
  apt `tmux git openssh-client ca-certificates curl`, then the five vendor one-liners
  from the harness manifests run as the runtime user, landing in `~/.local/bin` and
  `~/.npm-global/bin`, both on `PATH`. Harness versions therefore float with build
  day; the existing per-agent install route (`POST /api/setup/agents/:id/install`)
  refreshes any harness inside a running container without an image rebuild.
- Baked env: `HOST=0.0.0.0`, `NODE_ENV=production`, `DATABASE_PATH=/data/subshell.db`,
  `SUBSHELL_SERVER_CONFIG_DIR=/data`, `SUBSHELL_CONTAINER=1` (the marker §6 uses).
  `EXPOSE 3080`.
- Entrypoint `docker-entrypoint.sh`: if `/data/config.env` is absent, run
  `subshell-server init < /dev/null`, then `exec subshell-server "$@"`.
  Stdin is not a TTY, so every `init` question takes its skip-when-no-TTY branch
  (`init.ts` three-way rule); the tmux preflight passes because tmux is baked.
  The secret ladder then mints a unique 32-byte base64url `BETTER_AUTH_SECRET` into
  `/data/config.env` at 0600, on the customer's machine, once.
- Secrets lifecycle: the file lives only on the data volume (never in image, `docker
  inspect` env, host files, or script output); updates recreate the container but not
  the volume, so `init` sees the file and keeps it, and sessions survive every update;
  an operator who supplies `BETTER_AUTH_SECRET` as env gets the persist-env branch,
  same as the one-liner rail; and because `NODE_ENV=production` hard-fails the
  placeholder secret, no two installs can accidentally boot on a shared value.
- One volume at `/data` covers everything durable: config.env, the DB, backups,
  plugins, server logs, node artifacts (`SUBSHELL_SERVER_DATA_DIR` defaults to the DB
  dirname). Documented consequence, same as `docker.mdx` says today: a container
  restart ends every running subshell, because the container owns its tmux server.
- Root `Dockerfile` is replaced by this one; `.dockerignore` follows.
  `docker-compose.yaml` stays the dev/local rail, repointed at the GHCR image, with
  the `BETTER_AUTH_SECRET:?` hard requirement relaxed to optional now that the
  entrypoint covers it. `docker/desktop-builder.Dockerfile` is CI's test image and is
  untouched.

## 4. CI and publishing

- New workflow `docker-image.yml`: triggers on `release: published` with tags
  `cli-server-v*`, plus `workflow_dispatch` (a `version` input) for rebuilds.
- Steps: download `subshell-server-cli-linux-x64`, `-linux-arm64`,
  `release-manifest.json` and `.sig` from the release; verify the minisign signature
  against `RELEASE_PUBKEY` and both digests against the manifest's `assets` map, the
  same rule every update path obeys; refuse to push on any mismatch.
- buildx per-arch builds (amd64 and arm64 each on a native runner where available,
  QEMU as the fallback) that COPY the verified binaries and run the harness
  installers, then a manifest list pushed to `ghcr.io/subshell-ai/subshell:X.Y.Z`
  and `:latest`. The job carries a `version` smoke check: run the candidate image and
  require `subshell-server version` to print exactly `subshell-server X.Y.Z`, the same
  byte-exact contract the CLI e2e update scenarios use.
- The image build is packaging: no toolchain layers, and the only build-time network
  content is apt plus the five vendor installer rails. That is the product's existing
  posture (`docs/security.md` §0 does not defend the harness binaries' supply chain);
  the server half is signature-verified, and the GHCR image inherits GitHub's access
  controls. Image signing (cosign) is out of scope.

## 5. Proxmox helper script

- Root `proxmox.sh` (mirrors the `install-server.sh` placement precedent), served at
  `subshell.sh/proxmox.sh` through the existing website.yml root-file hosting, plus
  the repo path for raw GitHub use. It runs on the Proxmox host as root.
- `install` flow: prompts (hostname, cores=1, RAM=2048, disk=8, port=3080, all
  overridable); downloads the Debian trixie CT template; `pct create` unprivileged
  with `features nesting=1`; inside the CT, installs Docker via `get.docker.com`,
  generates nothing secret, and runs the container as
  `docker run --name subshell --restart unless-stopped -p PORT:3080
  -v /var/lib/subshell:/data ghcr.io/subshell-ai/subshell:latest`
  (a `SUBSHELL_VERSION` pin knob holds a tag instead); prints the instance URL.
- `update` verb: `docker pull`, recreate with the same port/volume/tag (read back
  from the existing container's config before replacing it), done. Data and secret
  live on the volume, so identity, sessions and settings ride through; running
  subshells do not (container owns its tmux server), and the docs say so.
- Plus `remove`, `backup`, `restore` in the convention's shape. No `updateapp`
  split-verb subtlety beyond `update`; the script is our file, not a community repo
  submission (getting listed on community-scripts.org is a later, separate step).

## 6. Update UX inside the container

Today the POST refuses unsupervised hosts with `RESTART_UNAVAILABLE`, which is true
but not helpful to someone reading a container. Small rail change:

- `server-deployment.ts` reports a `containerized` fact when `SUBSHELL_CONTAINER=1`.
- The update route's refusal carries `CONTAINERIZED` as its reason with the remedy
  string (`bash subshell.sh update` on the Proxmox host); the restart route's refusal
  gains the same reason. `--check` output mentions it in JSON so the CLI story is
  honest too.
- The admin update card, when the reason is `CONTAINERIZED`, shows two sentences of
  `detail`-role copy: the instance runs in a container; update it by pulling a new
  image from the host. The self-swap button is not offered there. Copy obeys the
  UI rules (two sentences, no em dashes, detail role).

## 7. Error handling

- Image build fails before any push on: missing manifest or bad signature (refused by
  name, per the signed-manifest rule), digest mismatch, or the version smoke check.
- Entrypoint: `init` failing propagates and the container exits nonzero rather than
  booting without config; `exec` replaces the shell so signals reach the server.
- `proxmox.sh`: `set -u`; fails loudly if the template download, `pct create`, the
  nesting feature, or the GHCR pull fails; the recreate step keeps the previous
  container (`docker rename` aside, then remove on success) so a bad `:latest` can be
  rolled back by name.
- A container booted with an older image tag still answers the admin UI, and the
  in-app check says "update by pulling a new image", never offering a swap that
  cannot restart correctly.

## 8. Testing

- `scripts/cli-e2e/docker-image.sh` (manual + a CI job with docker available; joins
  the `test:cli` family, not `bun run test`): boot the freshly built image on a free
  port; poll `/api/setup/status`; assert `version` prints the built tag; assert tmux
  plus the five harness binaries resolve on PATH in-container; assert the update
  route answers `CONTAINERIZED`; recreate the container and assert `config.env` is
  byte-identical and the instance boots.
- Server unit tests: the `CONTAINERIZED` refusal payload on the update and restart
  routes, and the deployment fact's env parsing. SPA test for the card copy.
- `proxmox.sh` gets shellcheck in `lint.yml`; it cannot be e2e'd without a PVE host,
  so acceptance includes one documented manual pass on Theo's Proxmox box (install,
  open first run, create a pane, `update`, pane dies, data survives) before docs
  point at it.

## 9. Out of scope

- In-place self-update inside the container (the swap would be lost on recreate and
  is invisible to the image tag); ruled in §2.
- Multi-stage build-from-source images; drift from the release rail, see §2.
- Running the node agent inside the server container (the `local` node is in-process;
  agents are for other machines).
- Community-scripts.org submission, cosign image signing, Windows containers,
  `SUBSHELL_SECRETS_KEY` (designed, not built, env-only anyway).

## 10. Touch list

- Replace `Dockerfile`; adjust `.dockerignore`; repoint `docker-compose.yaml`.
- New: `docker-entrypoint.sh`, `.github/workflows/docker-image.yml`, `proxmox.sh`.
- Server: `services/server-deployment.ts` (fact), `api/admin/server/update` and
  `restart` routes (reason + remedy), CLI `update --check --json` field.
- Web: the admin update card's containerized state.
- Website: host `proxmox.sh` at `subshell.sh/proxmox.sh` (website.yml asset list).
- Docs: refresh `server/docker.mdx`, new `server/proxmox.mdx`; README pointer line.
- CI: `lint.yml` shellcheck entry; `docker-image.yml`; smoke check job.
- Tests: the files named in §8.

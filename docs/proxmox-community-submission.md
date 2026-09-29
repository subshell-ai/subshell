# Listing Subshell on community-scripts.org (Proxmox helper-script project)

Researched 2026-09-29 against the live repositories. This is the gap analysis, not
a submission yet: the project's acceptance bar currently excludes us, and the facts
here go stale - reverify before spending effort.

## What their project is now

- Main repo `community-scripts/ProxmoxVE` (site community-scripts.org); **new scripts
  are auto-closed there**. New scripts go to its staging sibling
  `community-scripts/ProxmoxVED` and are promoted by maintainers/bots.
- The framework lives in a shared engine repo, `community-scripts/core`. App
  contributors ship only three files: a host-side `ct/<app>.sh` (engine bootstrap +
  resource vars + one `update_script()`), an in-CT `install/<app>-install.sh`, and
  `json/<app>.json` metadata (synced to the site via PocketBase; the old
  `display/*.md` files no longer exist).
- CT creation, CTID allocation, verb menus, destroy, and backups (PVE-native vzdump)
  are engine-side. App scripts do NOT carry remove/backup/restore verbs or menus.

## Why we are not listable yet

- **Docker is rejected for app scripts.** Their AGENTS.md: "do not wrap a container
  runtime, do not translate a Dockerfile into docker run... rejected on sight"; the
  PR template has a mandatory "installed bare-metal" checkbox. Our
  `proxmox-server.sh` is Docker-in-LXC on a GHCR image - the prohibited shape. A
  listing must be the NATIVE rail: `subshell-server` binary + tmux + the
  systemd-user service inside the CT - which is exactly what `install-server.sh`
  already does, so this variant is nearly free to write.
- **Acceptance bar with bot enforcement: 600+ stars, 6+ months old, actively
  maintained, official release tarballs.** Their agents look up the real star count
  and flag shortfalls immediately. At research time Subshell had **2 stars, created
  2026-08-31** - a submission now closes itself.

## The submission trio, when eligible

- `ct/subshell.sh`: their copyright header (MIT attribution, Author line, source
  URL), `_cs_boot` bootstrap immediately after the shebang (nothing above it),
  `var_cpu`/`var_ram`/`var_disk`/`var_os=debian`/`var_version=13`, one
  `update_script()`: existence check, stop service, `create_backup` (to `/opt`),
  fetch via their release helpers (`check_for_gh_release` / `fetch_and_deploy_gh_release`,
  never `git pull`), restart, final `exit`. Wrapping our own updater is fine:
  `subshell-server update` already backs up, swaps, and respawns.
- `install/subshell-install.sh`: runs INSIDE the fresh CT: their opening chain
  (`source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"; color; verb_ip6; catch_errors;
  setting_up_container; network_check; update_os`), then apt `tmux`, the server
  one-liner with `SUBSHELL_NO_SERVICE=1`, `subshell-server service install`, health
  wait on `/api/setup/status`, then their closing trio (`motd_ssh; customize;
  cleanup_lxc`).
- `json/subshell.json`: the required fields (name, slug, categories, dates,
  `interface_port: 3080`, `updateable: true`, docs/website/repo links,
  `architectures`, logo, notes carrying "the first registered account becomes the
  admin"), plus any prompt as `app_vars` (typed, secrets marked; their
  read-var-then-prompt convention replaces our `PVE_NO_PROMPT` idiom).
- Logo: a selfhst/icons contribution (jsDelivr webp URL is what the json points at).
  Independent and worth doing early.

## PR-process gates that will apply

- Real-PVE test evidence ("Tested on: PVE x / Debian 13 / fresh install + update").
- AI/LLM usage disclosure in the PR body; scripts "clearly AI generated and not
  further revised" may close without review.
- Template sections enforced by bots (missing "Application Requirements" or the
  6-months/600-stars/tarball confirmations auto-close).
- CI itself is light (`bash -n`); reviewers enforce their AGENTS.md/CODE-AUDIT
  checklist (`apt` not `apt-get`, no banners, no core packages as deps, root-only
  execution model, no custom download/version logic).
- Staleness: PRs close after 14 quiet days + 7 labeled days; keep the thread warm.

## What stays regardless of listing

The `proxmox-server.sh` / `proxmox-node.sh` rails on subshell.sh stay published as
they are - the community listing is marketing, not a dependency. Users already get
the one-command experience from our own site.

## Sources (2026-09-29)

- github.com/community-scripts/ProxmoxVE/blob/main/CONTRIBUTING.md (new scripts
  not accepted here; promotion flow; metadata via website)
- github.com/community-scripts/ProxmoxVED/blob/main/AGENTS.md (the script contract,
  no-Docker rule, eligibility numbers, style checklist)
- github.com/community-scripts/core (engine: pve/backend.func, ui/menu.func)
- community-scripts.org (site; PocketBase-driven metadata)

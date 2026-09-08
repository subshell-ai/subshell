# Docker SSH / git-push access — design

Date: 2026-08-30
Status: approved (Theo: "yes")

## Goal

Harness panes inside the mote container can `git push` (and make
signed commits) against private remotes using the host's SSH
credentials, headlessly — including right after a boot, when no user
session (and therefore no 1Password/gcr ssh-agent) is running.

Mechanism chosen: **bind-mount the host's `~/.ssh` read-only** into the
container's HOME. Rejected alternatives: forwarding the agent socket
(gcr/1Password agents exist only after graphical login — pushes would be
dead boot-until-login, incompatible with `restart: unless-stopped`) and
per-repo deploy keys (per-repo key management; not what was asked for).

## Verified host facts (this design depends on these)

- All private keys in `~/.ssh` (`id_ed25519`, `general-access`,
  `hmn_prod`, `new_prod`) are passphrase-free — `ssh-keygen -y -P ''`
  succeeds on each — so no agent is required for use.
- `known_hosts` is populated; a read-only mount keeps host verification
  fully functional.
- `~/.ssh/config` sets `IdentityAgent ~/.1password/agent.sock` for
  `Host *`; that socket will not exist in the container. Verified live:
  OpenSSH falls back to on-disk keys when the configured agent is
  unreachable (`ssh -o IdentityAgent=/nonexistent/agent.sock -T
  git@github.com` authenticates).
- The container runs as the host uid (`user: ${UID}:${GID}`) and
  `HOME=/home/mote`, so `600`-mode keys owned by the host uid pass
  ssh's ownership/permission checks unchanged.
- `~/.gitconfig` names a signing key that **is** the on-disk
  `id_ed25519`, but signs via `/opt/1Password/op-ssh-sign`, which does
  not exist in the image — mounting the host gitconfig as-is would break
  commits in repos with `commit.gpgsign=true` (e.g. `hmn-vm`).

## Image (`Dockerfile`)

- The runtime stage installs with `--no-install-recommends`, so `git`
  does **not** drag in `openssh-client` — no `ssh`, no `ssh-keygen`.
  Added `openssh-client` to the runtime apt set (found during
  verification: a throwaway container failed with "cannot run ssh"
  despite correct mounts).
- `usermod -d /home/mote bun`: when the host uid is 1000 it maps to the
  base image's `bun` user, whose passwd home is `/home/bun`. OpenSSH
  resolves `~/.ssh` via the **passwd entry, not `$HOME`**, so the
  mounted keys were invisible ("Host key verification failed" despite a
  populated known_hosts). Repointing bun's home at the pinned `$HOME`
  makes passwd and `$HOME` agree.
- Requires `docker compose build` before the volumes below do anything.

## Compose changes (`docker-compose.yaml`, volumes)

Entries added, in the existing commented style:

- `${HOME}/.ssh:/home/mote/.ssh:ro` — keys + known_hosts. ro is fully
  functional (passphrase-free keys, populated known_hosts); a new git
  host becomes visible to panes as soon as `ssh-keyscan` runs on the
  host (dir mounts track content live).
- `./docker/ssh-config:/home/mote/.ssh/config:ro` — overlays the host
  config with `Host *` / `IdentityAgent none`: git's ssh-format signing
  **aborts** on an unreachable IdentityAgent (the host config names the
  1Password socket) instead of falling back to key files. The overlay
  works only because the host's `config` already exists — Docker cannot
  create a mountpoint inside a read-only dir mount.
- `./docker/gitconfig:/home/mote/.gitconfig:ro` — see below.

Host prerequisite (created during implementation):
`~/.ssh/id_ed25519.pub`. Git needs `<signingkey>.pub` to locate the
private key for path-form signing; the host had no companion file, and
one cannot be created inside the container's ro mount.

## `docker/gitconfig` (untracked) + `docker/ssh-config` (checked in)

`docker/gitconfig` is personal identity and stays untracked (gitignored);
the repo ships `docker/gitconfig.example`, copied per machine like `.env`.

Host identity + ssh-format signing **without** the `op-ssh-sign`
program line — and `signingkey` in **path form**: git resolves a pubkey
*blob* only against ssh-agent keys (none exist in the container), while
a path to a `.pub` makes git sign via stock `ssh-keygen -Y sign` with
the private key beside it. The block itself is whatever
`docker/gitconfig.example` describes, filled in with the host's git
identity (real email deliberately never enters the repo).

Commits made in the container keep verifying on GitHub (same key the
host signs with, already registered on the account). In-container
*verification* (`log --show-signature`) would additionally need
`gpg.ssh.allowedSignersFile`; deliberately not configured — GitHub
verifies server-side.

## Future extras: `docker-compose.override.yaml`

The general "extra mounts" knob is Compose's native override file:
gitignored (add to `.gitignore`), auto-merged by every `docker compose`
command, so later credentials (e.g. `~/.config/gh`) need one line in an
untracked file and no base-compose edit:

```yaml
services:
  mote:
    volumes:
      - ${HOME}/.config/gh:/home/mote/.config/gh:ro
```

A pointer comment goes into the base compose volumes block.

## Security posture

The ro mount exposes unencrypted private keys to anything running in
harness panes (arbitrary agent shell). This is deliberate and consistent
with the existing rw `~/.claude` mount and the local/trusted-network
model (`.claude/rules/security-context.md`); ro bounds it (panes cannot
tamper with or exfiltrate-by-deletion, and cannot mint new keys).
Documented in the compose comment and README.

## Documentation

- `docker-compose.yaml`: the two mount comments above + override pointer.
- README §Docker: the new mounts, the override pattern, the
  `ssh-keyscan`-on-host note for new git hosts, and the "keys readable
  by panes" security note.

## Verification (acceptance)

All three passed in a throwaway container (rebuilt image, identical
mount set) before applying to the live service, and should be re-run
against the live container after `docker compose up -d`:

1. `docker compose exec mote ssh -T git@github.com` → authenticated
   banner (proves keys + known_hosts + home/passwd fix through the
   mount).
2. Signed commit in a scratch repo inside the container:
   `git init && git commit -S -m t` succeeds and `git cat-file commit
   HEAD` shows a `gpgsig -----BEGIN SSH SIGNATURE-----` header.
3. `git push --dry-run --no-verify` on a real mounted repo negotiates
   with no auth error (`--no-verify` skips the repo's own lefthook
   pre-push; `--dry-run` avoids mutating).

## Out of scope

Other credential mounts (`gh`, npm, AWS) beyond documenting the override
pattern; agent-socket forwarding; CI images; making the backend itself
(e.g. workspace cloning) use SSH — panes are the actor here, though the
mount happens to enable backend git too.

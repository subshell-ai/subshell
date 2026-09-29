# Node story: docs page, site line, Proxmox node helper

Date: 2026-09-29
Status: approved design, pre-implementation
Builds on: `2026-09-28-docker-proxmox-lxc-design.md` (the server rail this mirrors), security model §6 (node enrollment)

## 1. Problem

The product has three installable things (Server, Client, node), but a public install story for only two. The node install command is per-instance by design: the server renders `/install.sh?setup_key=...` with a single-use 24 h key from the app's add-node flow, so there is nothing public to publish. A Proxmox operator who wants a machine (or LXC) running panes as a node finds no docs page for the headless node install at all (the Docker/Proxmox page covers the server; headless.mdx is server-scoped; Client ships the agent only for macOS).

## 2. Decisions

| question | ruling |
|---|---|
| Public one-liner for nodes? | NO. A key-less public node installer would weaken the enrollment gate. The command's home stays the app. |
| Docs | New `server/nodes.mdx`: what a node is, the add-node flow as the source of the command, the Client-app route, plain-LXC note for Proxmox people, tmux requirement, retention/service facts at pointer depth. |
| Website | One line under the install column pointing at the node docs. No command-shaped string is published; the no-hardcoded-artifact rule stays intact. |
| Helper script | `proxmox-node.sh`: an unprivileged Debian 13 LXC that enrolls as a node. The operator pastes the per-instance install URL (with its key) once at install; nothing else about the node is invented by the script. |

## 3. proxmox-node.sh

- Sibling of `proxmox.sh`, same conventions (root on the host, prompts overridable, `PVE_NO_PROMPT=1`, standard verbs install/update/remove/backup/restore, self-save note at install end, served at `subshell.sh/proxmox-node.sh` via the prepare-data copy list).
- `install` prompts for the SETUP URL - the exact `http://host:3099/install.sh?setup_key=nsk_...` string the app shows - and validates it parses (http(s) origin, path `/install.sh`, a non-empty `setup_key` param) before touching Proxmox. It is single-use: the script says so and refuses to reuse it (one `docker`-free CT per key; a failed install tells the operator to mint a fresh key rather than retry the spent one).
- The CT: unprivileged, NO nesting (nothing here runs Docker), smaller defaults than the server rail (1 core / 1024 MB / 4 GB), hostname prompts the node NAME (the agent names itself via `--name`; `normalizeNodeName` semantics live server-side, the script just passes the hostname).
- Inside the CT: apt curl + tmux, a `subshell` user (uid 1000) with lingering enabled, then as that user: `curl -fsSL "$SETUP_URL" | bash` - the server-served rail does install, enroll, and the systemd-user service, exactly as it does on any machine. The script adds nothing to that path and reimplements none of it.
- Key hygiene: the URL is read from the tty (never argv of the host command), passed into `pct exec` as a here-doc argument, and never written to any file; host shell history stays clean. Residual exposure is the documented posture (the key rides the URL to the server's access log by design).
- `update` runs `subshell update` inside the CT as the node user (the agent's own rail; the in-app node update remains the primary lever and the docs say so). `remove`/`backup`/`restore` match the server script.
- No image, no registry: this rail touches no GHCR asset.

## 4. Website line

Under both install kinds (it is equally true from either tab): one sentence, `detail` density on the site's scale, "Want panes on another machine? Add a node inside Subshell - the install command lives with the node." linking `/docs/server/nodes`. No command text, no version, nothing derived from releases.json.

## 5. Docs

- `server/nodes.mdx` (new, meta.json after "proxmox"): what a node is (one paragraph, pointer-depth), the add-node flow as the only public entry to the command, the Client-app alternative, requirements (tmux, linux/macos), the Proxmox note (plain LXC + the app's command, or the helper), node self-update and retention at link depth. Voice: neutral, one-sentence openers, no em dashes.
- `server/proxmox.mdx` gains two sentences: the server container runs panes on its own host (in-process `local` node); a second machine or LXC as a node goes through the node docs.
- `server/index.mdx` / headless.mdx: cross-links only if their existing structure expects a sibling list (check meta and links, no restructures).

## 6. Error handling

- Setup URL validation failure: refuse before any `pct` call, name what is missing (https origin / /install.sh path / setup_key param).
- Enroll failure inside the CT (bad/expired key): the server-served script reports it; the helper surfaces stderr and says "mint a fresh setup link and re-run install on a clean CT" (never auto-retries a spent key).
- CT-already-exists: install refuses; the update verb is the right lever.

## 7. Testing

- shellcheck + `bash -n` in the existing lint.yml step (file list grows).
- Unit-level: the setup-URL validator is a shell function; a small bats-free check is out of convention here - the validator is pinned instead by a documented manual matrix in the PR (valid, no key param, non-http, wrong path). CI cannot run PVE; same acceptance posture as the server rail.
- Docs: content tests for the docs package (existing shipped-copy/voice tests must stay green); website tests for the new copy (install.test.ts patterns); lint:prose.
- Manual acceptance (operator, one box): install a node CT against a live instance, see it online in the app, run a pane on it, `subshell update` via the helper.

## 8. Out of scope

Public key-less node one-liner (ruled in §2); enrolling over an existing CT; anything that stores the setup key; a Docker-based node image (a node wants host paths to work on, plain LXC is the right shape).

# Node story: docs page, site line, Proxmox node helper

Date: 2026-09-29
Status: approved design, pre-implementation
Builds on: `2026-09-28-docker-proxmox-lxc-design.md` (the server rail this mirrors), security model §6 (node enrollment)

## 1. Problem

The public site's install column already carries the general node story (the add-a-machine line and page), but the Proxmox rail is server-only end to end: an operator who wants a second LXC running panes as a NODE finds no Proxmox-shaped path, and the server page never says how its container relates to the node concept. The node install command stays per-instance by design (the server renders `/install.sh?setup_key=...` with a single-use key), so what can be published is the PROXMOX SHAPE of that install, not a global command.

## 2. Decisions

| question | ruling |
|---|---|
| Public one-liner for nodes? | NO. A key-less public node installer would weaken the enrollment gate. The command's home stays the app. |
| Docs | Already exist: `get-started/add-a-machine.mdx` is the node install page and the website's install column already links it ("Already running Subshell? Add another machine...") - verified during planning, so this spec's original "new nodes page + new site line" scope collapsed to cross-links. Remaining: a plain-LXC note in add-a-machine, and a "node on Proxmox" section in `server/proxmox.mdx` covering the helper. |
| Website | Nothing to build (the line exists); verified `add-a-machine` is its target. |
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

- `get-started/add-a-machine.mdx`: one short Proxmox note (a plain LXC is a fine target machine: `pct create` unprivileged, run the pasted command inside; the helper automates this) pointing at the server's Proxmox page.
- `server/proxmox.mdx`: a "As a node" section: the server container runs panes on its own host (in-process `local` node); another LXC as a node uses `proxmox-node.sh` (or the plain-LXC path via add-a-machine). Update the page opener so the page is still honestly about the server rail.
- No new page, no meta.json change, no website change (the site line and add-a-machine already cover the general node story).

## 6. Error handling

- Setup URL validation failure: refuse before any `pct` call, name what is missing (https origin / /install.sh path / setup_key param).
- Enroll failure inside the CT (bad/expired key): the server-served script reports it; the helper surfaces stderr and says "mint a fresh setup link and re-run install on a clean CT" (never auto-retries a spent key).
- CT-already-exists: install refuses; the update verb is the right lever.

## 7. Testing

- shellcheck + `bash -n` in the existing lint.yml step (file list grows).
- Unit-level: the setup-URL validator is a shell function; a small bats-free check is out of convention here - the validator is pinned instead by a documented manual matrix in the PR (valid, no key param, non-http, wrong path). CI cannot run PVE; same acceptance posture as the server rail.
- Docs: content tests for the docs package (existing shipped-copy/voice tests must stay green); lint:prose.
- Manual acceptance (operator, one box): install a node CT against a live instance, see it online in the app, run a pane on it, `subshell update` via the helper.

## 8. Out of scope

Public key-less node one-liner (ruled in §2); enrolling over an existing CT; anything that stores the setup key; a Docker-based node image (a node wants host paths to work on, plain LXC is the right shape).

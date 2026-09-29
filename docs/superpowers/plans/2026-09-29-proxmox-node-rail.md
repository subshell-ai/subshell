# Proxmox node rail - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `proxmox-node.sh` (an unprivileged LXC that enrolls as a node using the operator's pasted per-instance install URL) plus the two docs cross-links, so the Proxmox audience gets the node story as well as the server one.

**Architecture:** The helper creates a plain Debian 13 CT (no Docker, no nesting), installs tmux, makes a uid-1000 `subshell` user with lingering, and runs the instance's OWN server-served install rail inside it as that user (`SUBSHELL_NO_SERVICE=1` + `SUBSHELL_NODE_NAME`), then `subshell service install` (which enables and starts). Nothing about enrollment is reinterpreted - the pasted URL is the product's command.

**Tech Stack:** bash (shellcheck-gated), fumadocs MDX.

**Spec:** `docs/superpowers/specs/2026-09-29-proxmox-node-rail-design.md`.

## Global Constraints

- No U+2014 em dash anywhere in prose or shipped strings; `bash -n` + `shellcheck -S warning` clean on every shell file.
- The script's remote blocks are QUOTED heredocs (`<<'REMOTE'`); host values arrive only as `bash -s --` arguments; the setup key is read with `read -rsp` (silent) and written to NO file.
- Every interactive read takes `< /dev/tty` and its variable is pre-initialized (the sibling script's settled pattern).
- Docs voice: neutral, one-sentence openers, no restructures of existing pages - additions only.
- Boundary gates per `verification.md`; commits terse conventional, author theo@suteki.nu, lefthook must pass.

---

### Task 1: `proxmox-node.sh` + serving + lint wiring

**Files:**
- Create: `proxmox-node.sh` (repo root, mode 755)
- Modify: `.github/workflows/lint.yml` (the shellcheck step's file list)
- Modify: `apps/website/scripts/prepare-data.ts` (copy list, line ~32)
- Modify: `apps/website/.gitignore` (ignore the generated `public/proxmox-node.sh` copy)

**Interfaces:**
- Consumes: the server-served `/install.sh?setup_key=...` rail with `SUBSHELL_NO_SERVICE=1` and `SUBSHELL_NODE_NAME` knobs (install-script.ts:99-307); `subshell service install` which enables AND starts (node agent service.ts:343); node CLI `update --yes` (cli.ts:181,360).
- Produces: `curl -fsSL https://subshell.sh/proxmox-node.sh | bash` and `bash /root/proxmox-node.sh update` (the self-save print); verbs install/update/remove/backup/restore.

- [ ] **Step 1: Write the script**

Full content (the header helpers `msg_ok`, `msg_err`, `header`, `fn_prompt`, `preflight`, `need_ct_id`, `default_storage`, `latest_template` are byte-identical to the same-named functions in `proxmox.sh` - copy them from the committed file, changing nothing; where a line below shows `# (same as proxmox.sh: <fn>)` expand it from the source):

```bash
#!/usr/bin/env bash
#
# Subshell - Proxmox VE NODE helper (spec 2026-09-29), run on the PROXMOX
# HOST as root. Creates an unprivileged Debian trixie container and runs
# YOUR Subshell instance's own node install rail inside it - the exact
# command the app shows under its Nodes screen. Paste that URL once; it
# carries a one-time setup key, so there is nothing to save and nothing to
# reuse. No Docker and no image: a node wants plain paths and tmux.
#
# The agent runs as the CT's `subshell` user and its panes inherit that
# account. Updating the AGENT is the product's own rail; this script's
# `update` verb runs it (the in-app node update is the other door).

set -u

APP="Subshell node"
CT_ID="${CT_ID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-subshell-node}"
CT_CORES="${CT_CORES:-1}"
CT_RAM_MB="${CT_RAM_MB:-1024}"
CT_DISK_GB="${CT_DISK_GB:-4}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
SETUP_URL="${SETUP_URL:-}"
TEMPLATE_CACHE="/var/lib/vz/template/cache"

# msg_ok / msg_err / header / fn_prompt / preflight / need_ct_id /
# default_storage / latest_template: copy verbatim from proxmox.sh.

# The exact shape the app renders: http(s) origin, /install.sh, one
# setup_key=nsk_... param. Validated before anything is created; the key
# value is never echoed.
validate_setup_url() {
  local url="$1"
  [[ "$url" =~ ^https?://[^/[:space:]]+/install\.sh\?setup_key=nsk_[A-Za-z0-9_-]{8,}$ ]]
}

# ---------- install ----------
install_ct() {
  preflight
  header "Create the ${APP} container"
  local last
  last=$(pct list 2>/dev/null | tail -n +2 | awk '{print $1}' | sort -n | tail -1)
  if [[ -n "$CT_ID" ]]; then
    msg_ok "using CT_ID=$CT_ID from the environment"
  else
    fn_prompt CT_ID "Container ID" "$(( ${last:-100} + 1 ))"
  fi
  fn_prompt CT_HOSTNAME "Hostname (the node names itself after it)" "$CT_HOSTNAME"
  fn_prompt CT_CORES "Cores" "$CT_CORES"
  fn_prompt CT_RAM_MB "Memory MB" "$CT_RAM_MB"
  fn_prompt CT_DISK_GB "Disk GB" "$CT_DISK_GB"
  fn_prompt CT_BRIDGE "Bridge" "$CT_BRIDGE"

  if [[ -z "$SETUP_URL" ]]; then
    echo "Paste the install URL from your Subshell instance (its Nodes screen)."
    echo "It carries a one-time key: this run gets one shot at it."
    read -rsp "Install URL: " SETUP_URL < /dev/tty || SETUP_URL=""
    echo
  fi
  validate_setup_url "$SETUP_URL" || msg_err "not an install URL from the app (expected http(s)://host/install.sh?setup_key=nsk_...); nothing was created"

  local tmpl st rootpass
  st=$(default_storage)
  tmpl=$(latest_template)
  if [[ ! -f "${TEMPLATE_CACHE}/${tmpl}" ]]; then
    header "Downloading ${tmpl} (this can take a minute)"
    ( cd "$TEMPLATE_CACHE" && wget -q --show-progress "https://download.proxmox.com/images/system/${tmpl}" ) \
      || msg_err "template fetch failed"
  fi
  rootpass=$(openssl rand -base64 12)

  local args
  args=("$CT_ID" "local:vztmpl/${tmpl}"
    --unprivileged 1
    --hostname "$CT_HOSTNAME" --ostype debian
    --memory "$CT_RAM_MB" --swap 512 --cores "$CT_CORES"
    --disk "size=${CT_DISK_GB}G" --storage "$st"
    --net0 "name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
    --password "$rootpass")
  pct create "${args[@]}" || msg_err "pct create failed"
  pct start "$CT_ID" || msg_err "pct start failed"
  msg_ok "CT $CT_ID created (CT root password: ${rootpass})"
}

install_node_in_ct() {
  header "Install tmux and the node agent inside the CT"
  local _
  for _ in $(seq 1 60); do pct exec "$CT_ID" -- true 2>/dev/null && break; sleep 1; done
  pct exec "$CT_ID" -- bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl tmux >/dev/null
    useradd --create-home --uid 1000 --shell /bin/bash subshell
    loginctl enable-linger subshell
  ' || msg_err "base setup inside the CT failed"

  # The rail itself: the instance's own install script, as the node user,
  # non-interactive, naming the node after the CT hostname. NO_SERVICE
  # because the service is installed explicitly below (enable AND start).
  pct exec "$CT_ID" -- bash -s -- "$SETUP_URL" "$CT_HOSTNAME" <<'REMOTE'
    set -eu
    url="$1"; name="$2"
    uid=$(id -u subshell)
    for _ in $(seq 1 30); do [ -d "/run/user/$uid" ] && break; sleep 1; done
    [ -d "/run/user/$uid" ] || { echo "logind never came up inside the CT" >&2; exit 1; }
    runuser -u subshell -- env HOME=/home/subshell USER=subshell LOGNAME=subshell \
      XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
      SUBSHELL_NO_SERVICE=1 SUBSHELL_NODE_NAME="$name" \
      bash -c 'curl -fsSL "$1" | bash' _ "$url"
    runuser -u subshell -- env HOME=/home/subshell USER=subshell LOGNAME=subshell \
      PATH="/home/subshell/.local/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
      subshell service install
    echo "agent: $(runuser -u subshell -- env HOME=/home/subshell PATH="/home/subshell/.local/bin:/usr/local/bin:/usr/bin:/bin" subshell version)"
REMOTE
  [[ $? -eq 0 ]] || msg_err "the node install failed inside CT $CT_ID (a spent or expired key is NOT retryable: mint a fresh setup link and re-run on a clean CT)"

  # A `curl | bash` install leaves no file to re-run; save our own copy
  # best-effort (the update verb needs it) so the print below is a promise.
  local update_hint=""
  if curl -fsSL https://subshell.sh/proxmox-node.sh -o /root/proxmox-node.sh && chmod 755 /root/proxmox-node.sh; then
    update_hint="Update the agent later with: bash /root/proxmox-node.sh update (a copy you kept works too)"
  else
    update_hint="WARN: could not save /root/proxmox-node.sh - keep your copy for the update verb"
  fi
  msg_ok "${APP} enrolled - watch it come online in your instance's Nodes list"
  echo "$update_hint"
}

# ---------- update ----------
update_agent() {
  preflight
  need_ct_id
  header "Run the agent's own updater inside the CT (its service restarts it)"
  pct exec "$CT_ID" -- bash -ec '
    uid=$(id -u subshell)
    runuser -u subshell -- env HOME=/home/subshell USER=subshell LOGNAME=subshell \
      PATH="/home/subshell/.local/bin:/usr/local/bin:/usr/bin:/bin" \
      XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
      subshell update --yes
  ' || msg_err "update failed inside CT $CT_ID"
  msg_ok "${APP} updated"
}

# ---------- remove / backup / restore ----------
# remove_ct, backup_ct, restore_help: copy verbatim from proxmox.sh,
# substituting ${APP} in the strings as they already read there.

# ---------- menu ----------
case "${1:-}" in
  install) install_ct; install_node_in_ct ;;
  update) update_agent ;;
  remove) remove_ct ;;
  backup) backup_ct ;;
  restore) restore_help ;;
  "")
    header "Menu"
    echo " 1) install   2) update   3) backup   4) restore help   5) remove"
    sel=""
    read -rp "Select: " sel < /dev/tty
    case "$sel" in
      1) install_ct; install_node_in_ct ;;
      2) update_agent ;;
      3) need_ct_id; backup_ct ;;
      4) restore_help ;;
      5) need_ct_id; remove_ct ;;
      *) msg_err "no such option" ;;
    esac
    ;;
  *) msg_err "usage: proxmox-node.sh [install|update|remove|backup|restore]" ;;
esac
```

The knobs are set once on `env` and reach the pipe's right-hand `bash` by inheritance (the inner `bash` is a child of the `bash -c` that already carries them).

- [ ] **Step 2: Gates**

```bash
chmod +x proxmox-node.sh
bash -n proxmox-node.sh
shellcheck -S warning proxmox-node.sh    # the v0.11.0 static binary or apt's
```
Expected: both silent/exit 0. The copy-from-proxmox.sh instruction means the helpers MUST be byte-identical (diff them).

- [ ] **Step 3: Wire serving + lint**

`apps/website/scripts/prepare-data.ts`: copy list becomes `["install-server.sh", "install-client.sh", "proxmox.sh", "proxmox-node.sh"]`. `apps/website/.gitignore`: add `public/proxmox-node.sh` beside the proxmox.sh line. `.github/workflows/lint.yml`: append `proxmox-node.sh` to the shellcheck step's file list.

Run: `bun test apps/website/lib/__tests__/install.test.ts apps/website/lib/__tests__/releases.test.ts` (from the apps/website package dir; the 14 root-level DOM failures are pre-existing - run per package as apps/website/AGENTS.md prescribes).

- [ ] **Step 4: Commit**

```bash
git add proxmox-node.sh apps/website/scripts/prepare-data.ts apps/website/.gitignore .github/workflows/lint.yml
git commit -m "feat(proxmox): node helper - plain LXC enrolling through the instance's own rail"
```

---

### Task 2: Docs cross-links

**Files:**
- Modify: `apps/docs/content/docs/server/proxmox.mdx` (new "As a node" section + one opener clause)
- Modify: `apps/docs/content/docs/get-started/add-a-machine.mdx` (one Proxmox note where it fits its existing shape)

**Interfaces:**
- Consumes: Task 1's script (its verbs, its one-time-key posture, the /root save).
- Produces: the pages the helper's and the server page's audiences route through; no code.

- [ ] **Step 1: proxmox.mdx**

Add one new section near the end, before any Next-steps block, and change nothing else on the page:

```mdx
## As a node

The container above is the control plane, and it runs panes on its own host: the server hosts subshells through its in-process `local` node, no agent involved. A second machine - or a second LXC - that runs panes for your instance enrolls as a node, and [add-a-machine](/get-started/add-a-machine) is the path.

On Proxmox the shape is a plain unprivileged Debian 13 container (no Docker, no nesting) running that same install command inside; `proxmox-node.sh` automates exactly that: paste your instance's install URL once at install, and the container enrolls, names itself after the CT hostname, and runs the agent as its `subshell` user. Updating the agent is the product's own rail - the in-app node update, or `bash /root/proxmox-node.sh update`.
```

- [ ] **Step 2: add-a-machine.mdx**

Read the page; add ONE note (a list item under Notes, or a short paragraph in step 2 where the command is run) - Proxmox people: the target machine may be a plain unprivileged LXC; the server rail's page documents a helper that automates the create-and-enroll shape. Point at `/server/proxmox`. Nothing else changes on the page.

- [ ] **Step 3: Gates + commit**

`bun run lint:prose`; docs tests from the apps/docs package dir.

```bash
git add apps/docs/content/docs/server/proxmox.mdx apps/docs/content/docs/get-started/add-a-machine.mdx
git commit -m "docs: node-on-proxmox cross-links"
```

---

### Task 3: Boundary + push

- [ ] `bun run verify-types && bun run lint:check && bun run lint:prose && bun run test && bunx turbo build` - all green.
- [ ] `bun test scripts/__tests__/docker-release-verify.test.ts` unaffected-green sanity (same suite covers it).
- [ ] Website changeset: the existing `.changeset/docker-proxmox-lxc-rail.md` already carries `@internal/website": patch` - extend its summary sentence with the node helper; no new file.
- [ ] `git push` to the PR branch; `gh pr checks 273 --watch` until green.
- [ ] PR body: extend the What section with the node rail (script + docs) and the note that node installs stay key-per-instance by design.

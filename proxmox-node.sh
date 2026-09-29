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

msg_ok() { echo -e "\e[32m[OK]\e[0m $*"; }
msg_err() { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }
header() { echo -e "\e[32m ==>\e[0m \e[1m$1\e[0m"; }

# fn_prompt VAR QUESTION DEFAULT  (PVE_NO_PROMPT=1 takes every default, for
# unattended runs, exactly like the community scripts' var_check posture)
fn_prompt() {
  local var="$1" question="$2" def="$3" answer=""
  if [[ "${PVE_NO_PROMPT:-0}" == "1" ]]; then
    eval "$var=\"\$def\""
    return
  fi
  read -rp "${question} [${def}]: " answer < /dev/tty || answer=""
  eval "$var=\"${answer:-$def}\""
}

preflight() {
  [[ $EUID -eq 0 ]] || msg_err "run this on the Proxmox host as root"
  command -v pct >/dev/null 2>&1 || msg_err "pct not found: this is not a Proxmox host"
}

need_ct_id() {
  [[ -n "$CT_ID" ]] || read -rp "Container ID: " CT_ID < /dev/tty
  [[ -n "$CT_ID" ]] || msg_err "no container id given"
  pct status "$CT_ID" >/dev/null 2>&1 || msg_err "no CT $CT_ID on this host"
}

default_storage() {
  local s
  s=$(pvesm status -content images 2>/dev/null | awk 'NR>1 {print $1; exit}')
  echo "${s:-local}"
}

# Newest debian-13 standard template filename for this host's arch.
latest_template() {
  local arch file
  [[ "$(uname -m)" == "x86_64" ]] && arch="amd64" || arch="arm64"
  file=$(curl -fsSL "https://download.proxmox.com/images/system/" |
    grep -oE "debian-13-standard_[0-9.]+-[0-9]+_${arch}\.tar\.zst" | sort -V | tail -1)
  [[ -n "$file" ]] || msg_err "no Debian 13 CT template found on download.proxmox.com"
  echo "$file"
}

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
remove_ct() {
  preflight
  need_ct_id
  if [[ "${PVE_NO_PROMPT:-0}" != "1" ]]; then
    echo "This DESTROYS CT $CT_ID and everything in it."
    local a=""
    read -rp "Type yes to confirm: " a < /dev/tty
    [[ "$a" == "yes" ]] || msg_err "cancelled"
  fi
  pct shutdown "$CT_ID" 2>/dev/null || true
  sleep 3
  pct stop "$CT_ID" 2>/dev/null || true
  pct destroy "$CT_ID"
  msg_ok "CT $CT_ID destroyed"
}

backup_ct() {
  preflight
  need_ct_id
  vzdump "$CT_ID" --mode snapshot --compress zstd --storage "$(default_storage)"
}

restore_help() {
  preflight
  echo "Restore is Proxmox's own flow: Datacenter -> Backup -> select the vzdump -> Restore."
  echo "A ${APP} backup is a full-CT snapshot, so restoring brings back the container and its agent as one."
}

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

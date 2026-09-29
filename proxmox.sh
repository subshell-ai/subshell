#!/usr/bin/env bash
#
# Subshell - Proxmox VE LXC helper (spec 2026-09-28 section 5), the
# community-scripts convention: run on the PROXMOX HOST as root. Creates an
# unprivileged Debian trixie container with Docker inside it, runs the official
# Subshell image from GHCR, and updates it later with: bash /root/proxmox.sh
# update (the install saves itself there; a copy you kept works too). Pin the
# image with SUBSHELL_VERSION=<tag> or by setting IMG yourself.
#
# Data (database, config.env with its minted secret, plugins, backups) lives on
# the CT's /var/lib/subshell, so updates never touch it. Running panes do not
# survive an update: the container owns its tmux server.

set -u

APP="Subshell"
IMG="${IMG:-ghcr.io/subshell-ai/subshell:${SUBSHELL_VERSION:-latest}}"
CT_ID="${CT_ID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-subshell}"
CT_CORES="${CT_CORES:-1}"
CT_RAM_MB="${CT_RAM_MB:-2048}"
CT_DISK_GB="${CT_DISK_GB:-8}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
APP_PORT="${APP_PORT:-3080}"
CT_DATA="/var/lib/subshell"
CT_RUN_ENV="/etc/default/subshell-docker"
CT_NAME="subshell"
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

# Waits for the in-CT web UI; prints nothing.
wait_up() {
  local port="$1" _
  for _ in $(seq 1 60); do
    pct exec "$CT_ID" -- curl -sf "http://127.0.0.1:${port}/api/setup/status" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ---------- install ----------
install_ct() {
  preflight
  header "Create the ${APP} container"
  local last
  last=$(pct list 2>/dev/null | tail -n +2 | awk '{print $1}' | sort -n | tail -1)
  fn_prompt CT_ID "Container ID" "$(( ${last:-100} + 1 ))"
  fn_prompt CT_HOSTNAME "Hostname" "$CT_HOSTNAME"
  fn_prompt CT_CORES "Cores" "$CT_CORES"
  fn_prompt CT_RAM_MB "Memory MB" "$CT_RAM_MB"
  fn_prompt CT_DISK_GB "Disk GB" "$CT_DISK_GB"
  fn_prompt CT_BRIDGE "Bridge" "$CT_BRIDGE"
  fn_prompt APP_PORT "Port the web UI maps on the CT" "$APP_PORT"

  local tmpl st rootpass
  st=$(default_storage)
  tmpl=$(latest_template)
  if [[ ! -f "${TEMPLATE_CACHE}/${tmpl}" ]]; then
    header "Downloading ${tmpl} (this can take a minute)"
    ( cd "$TEMPLATE_CACHE" && wget -q --show-progress "https://download.proxmox.com/images/system/${tmpl}" ) \
      || msg_err "template fetch failed"
  fi
  rootpass=$(openssl rand -base64 12)

  local sshkey="" args
  [[ -f /root/.ssh/id_ed25519.pub ]] && sshkey=$(cat /root/.ssh/id_ed25519.pub)
  [[ -z "$sshkey" && -f /root/.ssh/id_rsa.pub ]] && sshkey=$(cat /root/.ssh/id_rsa.pub)
  args=("$CT_ID" "local:vztmpl/${tmpl}"
    --unprivileged 1 --features nesting=1
    --hostname "$CT_HOSTNAME" --ostype debian
    --memory "$CT_RAM_MB" --swap 512 --cores "$CT_CORES"
    --disk "size=${CT_DISK_GB}G" --storage "$st"
    --net0 "name=eth0,bridge=${CT_BRIDGE},ip=dhcp"
    --password "$rootpass")
  [[ -n "$sshkey" ]] && args+=(--ssh-public-keys "$sshkey")
  pct create "${args[@]}" || msg_err "pct create failed"
  pct start "$CT_ID" || msg_err "pct start failed"
  msg_ok "CT $CT_ID created (CT root password: ${rootpass})"
}

install_docker_in_ct() {
  header "Install Docker inside the CT"
  local _
  for _ in $(seq 1 60); do pct exec "$CT_ID" -- true 2>/dev/null && break; sleep 1; done
  pct exec "$CT_ID" -- bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl >/dev/null
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    systemctl enable --now docker
  ' || msg_err "Docker install inside the CT failed"

  header "Run the ${APP} container"
  pct exec "$CT_ID" -- bash -s -- "$APP_PORT" "$IMG" "$CT_DATA" "$CT_NAME" "$CT_RUN_ENV" <<'REMOTE'
    set -eu
    port="$1"; img="$2"; data="$3"; name="$4"; runenv="$5"
    mkdir -p "$data"
    # The image runs as uid 1000; a fresh host dir must be its to write.
    chown 1000:1000 "$data"
    printf 'APP_PORT=%s\nIMAGE=%s\nDATA=%s\nNAME=%s\n' "$port" "$img" "$data" "$name" > "$runenv"
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --restart unless-stopped \
      -p "$port:3080" -v "$data:/data" "$img" >/dev/null
REMOTE
  [[ $? -eq 0 ]] || msg_err "the ${APP} container failed to start"
  wait_up "$APP_PORT" || msg_err "the container never answered inside the CT (check: pct exec $CT_ID -- docker logs subshell)"
  local ip
  ip=$(pct exec "$CT_ID" -- hostname -I | awk '{print $1}')
  # A `curl | bash` install leaves no file to re-run for the update verb, so
  # save our own copy best-effort (the network this needs is a precondition of
  # the install anyway; a failure only warns). Held as a string so the URL
  # block still prints first.
  local update_hint=""
  if curl -fsSL https://subshell.sh/proxmox.sh -o /root/proxmox.sh && chmod 755 /root/proxmox.sh; then
    update_hint="Update later with: bash /root/proxmox.sh update (a copy you kept works too: bash proxmox.sh update)"
  else
    update_hint="WARN: could not save /root/proxmox.sh - update later with your own copy: bash proxmox.sh update"
  fi
  msg_ok "${APP} is up: http://${ip}:${APP_PORT}"
  echo "Register the first account there - it becomes the admin."
  echo "$update_hint"
}

# ---------- update ----------
update_app() {
  preflight
  need_ct_id
  header "Pull the new image and recreate the container (running panes end; data survives)"
  pct exec "$CT_ID" -- bash -s -- "$CT_RUN_ENV" <<'REMOTE'
    set -eu
    runenv="$1"
    set -a; . "$runenv"; set +a
    rollback() {
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker rename "$NAME-old" "$NAME" >/dev/null 2>&1 || true
      docker start "$NAME" >/dev/null 2>&1 || true
      echo "update failed: the previous container is restored" >&2
      exit 1
    }
    # A failed pull changed NOTHING yet - the rollback below is for the
    # post-rename steps, where it restores correctly. Deleting the running
    # container here would strand the instance on a registry hiccup
    # (review finding, operator ruling 2026-09-29).
    docker pull "$IMAGE" || { echo "pull failed: the running container was left alone" >&2; exit 1; }
    # Clear a stale -old from an interrupted earlier run first: the rollback
    # below rm -f's $NAME to resurrect $NAME-old, so a leftover -old would
    # make it destroy the HEALTHY container to resurrect garbage.
    docker rm -f "$NAME-old" >/dev/null 2>&1 || true
    # With any stale -old cleared above, a failed rename means nothing changed
    # - the rollback would destroy the healthy container to restore nothing.
    docker rename "$NAME" "$NAME-old" || { echo "rename failed: the running container was left alone" >&2; exit 1; }
    docker stop "$NAME-old" >/dev/null || rollback
    docker run -d --name "$NAME" --restart unless-stopped \
      -p "$APP_PORT:3080" -v "$DATA:/data" "$IMAGE" >/dev/null || rollback
    ok=""
    for _ in $(seq 1 60); do
      curl -sf "http://127.0.0.1:$APP_PORT/api/setup/status" >/dev/null && { ok=1; break; }
      sleep 2
    done
    [[ -n "$ok" ]] || rollback
    docker rm -f "$NAME-old" >/dev/null 2>&1 || true
    echo "updated: $(docker exec "$NAME" subshell-server version)"
REMOTE
  [[ $? -eq 0 ]] || msg_err "update failed inside CT $CT_ID"
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
  echo "A ${APP} backup is a full-CT snapshot, so restoring brings back the container, its Docker, and ${CT_DATA} as one."
}

# ---------- menu ----------
case "${1:-}" in
  install) install_ct; install_docker_in_ct ;;
  update) update_app ;;
  remove) remove_ct ;;
  backup) backup_ct ;;
  restore) restore_help ;;
  "")
    header "Menu"
    echo " 1) install   2) update   3) backup   4) restore help   5) remove"
    sel=""
    read -rp "Select: " sel < /dev/tty
    case "$sel" in
      1) install_ct; install_docker_in_ct ;;
      2) update_app ;;
      3) need_ct_id; backup_ct ;;
      4) restore_help ;;
      5) need_ct_id; remove_ct ;;
      *) msg_err "no such option" ;;
    esac
    ;;
  *) msg_err "usage: proxmox.sh [install|update|remove|backup|restore]" ;;
esac

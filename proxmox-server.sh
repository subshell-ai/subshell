#!/usr/bin/env bash
#
# Subshell - Proxmox VE LXC helper (spec 2026-09-28 section 5), the
# community-scripts convention: run on the PROXMOX HOST as root. Creates an
# unprivileged Debian container with Docker inside it, runs the official
# Subshell image from GHCR, and updates it later with: bash /root/proxmox-server.sh
# update (the install saves itself there; a copy you kept works too). Pin at
# install with SUBSHELL_VERSION=<tag> (or set IMG); updates re-pull the tag the
# install recorded in /etc/default/subshell-docker - repin by editing that
# file's IMAGE= line (or reinstalling).
#
# Data (database, config.env with its minted secret, plugins, backups) lives on
# the CT's /var/lib/subshell, so updates never touch it. Running panes do not
# survive an update: the container owns its tmux server.

set -u

HELPER_SOURCE="${BASH_SOURCE[0]:-}"

APP="Subshell"
IMG="${IMG:-ghcr.io/subshell-ai/subshell:${SUBSHELL_VERSION:-latest}}"
CT_ID="${CT_ID:-}"
CT_HOSTNAME="${CT_HOSTNAME:-subshell}"
CT_CORES="${CT_CORES:-1}"
CT_RAM_MB="${CT_RAM_MB:-2048}"
# 40 G, not the 20 a first cut shipped: the measured CT holds ~13 G a couple
# of months in, and a pull needs room for the old and new images at once
# (2026-10-03: a routine update died with ENOSPC at 96.7% thin-volume use).
# lvm-thin and ZFS allocate only what is WRITTEN, so a big number costs the
# pool nothing it has not used; plain lvm reserves it whole, and that operator
# answers this prompt with their free extent.
CT_DISK_GB="${CT_DISK_GB:-40}"
CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
APP_PORT="${APP_PORT:-3080}"
TRUSTED_ORIGINS="${TRUSTED_ORIGINS:-}"
CT_DATA="/var/lib/subshell"
CT_RUN_ENV="/etc/default/subshell-docker"
CT_NAME="subshell"
CT_STORAGE="${CT_STORAGE:-}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-}"
BACKUP_STORAGE="${BACKUP_STORAGE:-}"

msg_ok() { echo -e "\e[32m[OK]\e[0m $*"; }
msg_err() { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }
header() { echo -e "\e[32m ==>\e[0m \e[1m$1\e[0m"; }

# Keep the version that actually performed the install, even before a newer
# website deployment. A piped invocation has no source file, so fetch it.
save_helper() {
  local destination="/root/proxmox-server.sh"
  if [[ -f "$HELPER_SOURCE" ]]; then
    if [[ "$HELPER_SOURCE" -ef "$destination" ]]; then
      chmod 755 "$destination"
    else
      install -m 755 "$HELPER_SOURCE" "$destination"
    fi
  else
    curl -fsSL "https://subshell.sh/proxmox-server.sh" -o "$destination" && chmod 755 "$destination"
  fi
}

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

# Only active storages supporting the requested content are candidates.
default_storage() {
  local content="${1:-rootdir}" stores
  stores=$(pvesm status -content "$content") || return 1
  awk 'NR>1 && $3 == "active" {print $1; exit}' <<< "$stores"
}

select_storage() {
  local var="$1" content="$2" question="$3" stores chosen
  stores=$(pvesm status -content "$content") || msg_err "cannot list $content storage"
  chosen="${!var}"
  [[ -n "$chosen" ]] || chosen=$(default_storage "$content")
  [[ -n "$chosen" ]] || msg_err "no active storage supports $content"
  echo "$stores"
  fn_prompt "$var" "$question" "$chosen"
  chosen="${!var}"
  awk -v name="$chosen" 'NR>1 && $1 == name && $3 == "active" {found=1} END {exit !found}' <<< "$stores" \
    || msg_err "storage $chosen is not active or does not support $content"
}

# Use PVE's catalogue and downloader, including its integrity checks.
# PVE 8 supports Debian 12; PVE 9 adds Debian 13 support.
latest_template() {
  local arch catalogue file version major debian=12
  arch=$(dpkg --print-architecture) || msg_err "cannot determine host architecture"
  version=$(pveversion) || msg_err "cannot determine Proxmox version"
  major="${version#pve-manager/}"; major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 8 ]] || msg_err "Proxmox VE 8 or newer is required"
  [[ "$major" -lt 9 ]] || debian=13
  pveam update >&2 || msg_err "cannot refresh Proxmox template catalogue"
  catalogue=$(pveam available --section system) || msg_err "cannot list Proxmox templates"
  file=$(awk '{print $2}' <<< "$catalogue" |
    grep -E "^debian-${debian}-standard_[0-9.]+-[0-9]+_${arch}\.tar\.(zst|gz|xz)$" | sort -V | tail -1)
  [[ -n "$file" ]] || msg_err "no Debian $debian template for $arch in Proxmox's catalogue"
  echo "$file"
}

# Refuse an unavailable GHCR image before allocating a container. GHCR's
# anonymous token endpoint refuses private packages, even when a tag exists.
check_server_image() {
  [[ "$IMG" == ghcr.io/* ]] || return 0
  local reference="${IMG#ghcr.io/}" repository tag token response
  if [[ "$reference" == *@* ]]; then
    repository="${reference%@*}"; tag="${reference#*@}"
  elif [[ "${reference##*/}" == *:* ]]; then
    repository="${reference%:*}"; tag="${reference##*:}"
  else
    repository="$reference"; tag=latest
  fi
  response=$(curl -fsSL --get --data-urlencode "scope=repository:${repository}:pull" \
    --data-urlencode "service=ghcr.io" https://ghcr.io/token) \
    || msg_err "cannot pull $IMG anonymously; check that the GHCR package is public; nothing was created"
  token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<< "$response")
  [[ -n "$token" ]] || msg_err "GHCR returned no pull token; nothing was created"
  curl -fsSI -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/${repository}/manifests/${tag}" >/dev/null \
    || msg_err "image $IMG is unavailable; check its tag and GHCR visibility; nothing was created"
}

# Bare IPs/domains use HTTP and the selected published port. Explicit URLs
# can name HTTPS proxies or a different port. The server validates the list.
normalize_browser_addresses() {
  local entry origin result=""
  while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ -n "$entry" ]] || continue
    if [[ "$entry" == *://* ]]; then
      origin="$entry"
    elif [[ "$entry" == *:*:* && "$entry" != \[* ]]; then
      origin="http://[$entry]:$APP_PORT"
    elif [[ "$entry" =~ ^\[[^]]+\]:[0-9]+$ || "$entry" != \[* && "$entry" == *:* ]]; then
      origin="http://$entry"
    else
      origin="http://$entry:$APP_PORT"
    fi
    result="${result:+$result,}$origin"
  done <<< "${1//,/$'\n'}"
  printf '%s\n' "$result"
}

# Docker sees its bridge address, not the LXC address browsers use. Discover
# that address from the CT's own interface, never from request headers.
container_base_url() {
  if [[ -n "${APP_BASE_URL:-}" ]]; then
    echo "$APP_BASE_URL"
    return 0
  fi
  local addresses ip
  addresses=$(pct exec "$CT_ID" -- ip -4 -o addr show dev eth0 scope global) || return 1
  ip=$(awk '{split($4, parts, "/"); print parts[1]; exit}' <<< "$addresses")
  if [[ -z "$ip" ]]; then
    addresses=$(pct exec "$CT_ID" -- ip -6 -o addr show dev eth0 scope global) || return 1
    ip=$(awk '{split($4, parts, "/"); print parts[1]; exit}' <<< "$addresses")
    [[ -n "$ip" ]] || return 1
    ip="[$ip]"
  fi
  echo "http://${ip}:${APP_PORT}"
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
  check_server_image
  header "Create the ${APP} container"
  local next_id
  next_id=$(pvesh get /cluster/nextid) || msg_err "cannot get an unused cluster container ID"
  if [[ -n "$CT_ID" ]]; then
    msg_ok "Container ID ${CT_ID} from the environment"
  else
    fn_prompt CT_ID "Container ID" "$next_id"
  fi
  fn_prompt CT_HOSTNAME "Hostname" "$CT_HOSTNAME"
  fn_prompt CT_CORES "Cores" "$CT_CORES"
  fn_prompt CT_RAM_MB "Memory MB" "$CT_RAM_MB"
  fn_prompt CT_DISK_GB "Disk GB" "$CT_DISK_GB"
  [[ "$CT_DISK_GB" =~ ^[0-9]+$ && "$CT_DISK_GB" -ge 16 ]] || msg_err "the server container needs at least 16 GB for its image and updates (40 GB recommended; lvm-thin and ZFS only allocate what is written)"
  fn_prompt CT_BRIDGE "Bridge" "$CT_BRIDGE"
  fn_prompt APP_PORT "Port the web UI maps on the CT" "$APP_PORT"
  echo "The container's address is detected automatically. Add other IPs, domains, or full URLs below."
  echo "Separate addresses with commas. Bare IPs/domains use http://address:$APP_PORT; use full https:// URLs for proxies."
  echo "You can change these later in Server Settings > Networking > Addresses."
  echo "Documentation: https://docs.subshell.sh/networking/addresses"
  fn_prompt TRUSTED_ORIGINS "Additional browser addresses (blank for none)" "$TRUSTED_ORIGINS"
  TRUSTED_ORIGINS=$(normalize_browser_addresses "$TRUSTED_ORIGINS")

  local tmpl rootpass
  select_storage CT_STORAGE rootdir "Container disk storage"
  select_storage TEMPLATE_STORAGE vztmpl "Template storage"
  tmpl=$(latest_template) || msg_err "template discovery failed; nothing was created"
  header "Downloading ${tmpl} (this can take a minute)"
  pveam download "$TEMPLATE_STORAGE" "$tmpl" || msg_err "template download failed; nothing was created"
  rootpass=$(openssl rand -base64 12)

  local sshkey="" args
  [[ -f /root/.ssh/id_ed25519.pub ]] && sshkey=/root/.ssh/id_ed25519.pub
  [[ -z "$sshkey" && -f /root/.ssh/id_rsa.pub ]] && sshkey=/root/.ssh/id_rsa.pub
  args=("$CT_ID" "${TEMPLATE_STORAGE}:vztmpl/${tmpl}"
    --unprivileged 1 --features nesting=1
    --hostname "$CT_HOSTNAME" --ostype debian
    --memory "$CT_RAM_MB" --swap 512 --cores "$CT_CORES"
    --rootfs "${CT_STORAGE}:${CT_DISK_GB}"
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
  pct exec "$CT_ID" -- bash -eoc pipefail '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl >/dev/null
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    systemctl enable --now docker
  ' || msg_err "Docker install inside the CT failed"

  local base_url
  base_url=$(container_base_url) || msg_err "no usable address on CT $CT_ID eth0; check its network or set APP_BASE_URL"
  header "Run the ${APP} container"
  pct exec "$CT_ID" -- bash -s -- "$APP_PORT" "$IMG" "$CT_DATA" "$CT_NAME" "$CT_RUN_ENV" "$base_url" "$TRUSTED_ORIGINS" <<'REMOTE'
    set -eu
    port="$1"; img="$2"; data="$3"; name="$4"; runenv="$5"; base_url="$6"; origins="$7"
    mkdir -p "$data"
    # The image runs as uid 1000; a fresh host dir must be its to write.
    chown 1000:1000 "$data"
    printf 'APP_PORT=%s\nIMAGE=%s\nDATA=%s\nNAME=%s\n' "$port" "$img" "$data" "$name" > "$runenv"
    # Persist the externally reachable address before the server starts.
    # The entrypoint initializes a fresh volume; configure preserves its secret.
    # Updates reuse config.env, including later operator changes.
    docker run --rm -v "$data:/data" "$img" configure --yes --base-url "$base_url" --trusted-origins "$origins"
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --restart unless-stopped -e SUBSHELL_CONTAINER_RESTART=1 \
      -p "$port:3080" -v "$data:/data" "$img" >/dev/null
REMOTE
  [[ $? -eq 0 ]] || msg_err "the ${APP} container failed to start"
  wait_up "$APP_PORT" || msg_err "the container never answered inside the CT (check: pct exec $CT_ID -- docker logs subshell)"
  # A `curl | bash` install leaves no file to re-run for the update verb, so
  # save our own copy best-effort (the network this needs is a precondition of
  # the install anyway; a failure only warns). Held as a string so the URL
  # block still prints first.
  local update_hint=""
  if save_helper; then
    update_hint="Update later with: bash /root/proxmox-server.sh update (a copy you kept works too: bash proxmox-server.sh update)"
  else
    update_hint="WARN: could not save /root/proxmox-server.sh - update later with your own copy: bash proxmox-server.sh update"
  fi
  msg_ok "${APP} is up: ${base_url}"
  echo "Register the first account there - it becomes the admin."
  echo "Change browser addresses later in Server Settings > Networking > Addresses."
  echo "Documentation: https://docs.subshell.sh/networking/addresses"
  echo "$update_hint"
}

# ---------- update ----------
update_app() {
  preflight
  need_ct_id
  header "Pull the new image and recreate the container (running panes end; data survives)"
  # Trim from the HOST: FITRIM is refused "Operation not permitted" inside an
  # unprivileged container (the ioctl needs privilege in the host's namespace
  # - forum-confirmed, and measured on this helper's own CT class 2026-10-03),
  # and pct fstrim is PVE's own privileged implementation of exactly that. It
  # is what hands an lvm-thin pool back the ext4 blocks the guest deleted
  # weeks ago; best effort for filesystems without discard support.
  # (No -v: pct fstrim's only option is --timeout, and a stray flag makes the
  # whole call a usage error.)
  pct fstrim "$CT_ID" 2>/dev/null || true
  pct exec "$CT_ID" -- bash -s -- "$CT_RUN_ENV" "$CT_ID" <<'REMOTE'
    set -eu
    runenv="$1"
    ctid="$2"
    set -a; . "$runenv"; set +a
    rollback() {
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker rename "$NAME-old" "$NAME" >/dev/null 2>&1 || true
      docker start "$NAME" >/dev/null 2>&1 || true
      echo "update failed: the previous container is restored" >&2
      exit 1
    }
    # A pull extracts the whole new image while the image it replaces is still
    # on disk, so the disk must hold BOTH at full unpacked size - and until
    # now every update left its replaced image behind forever, so a
    # month-old install answers a routine update with ENOSPC mid-extraction
    # (operator report 2026-10-03: "no space left on device" at 6 G free).
    # Dangling images go first; the running container's image is in use and
    # prune never touches it. And on an lvm-thin host the guest's free space
    # can be a lie: ext4 frees blocks without TRIM, and the thin volume
    # never hands them back - measured at 96.7% volume use behind a guest df
    # that still claimed 6 G free (2026-10-03). fstrim converts the guest's
    # deleted-and-forgotten into allocatable space. It is a no-op error
    # wherever discard is unsupported, hence the silence.
    docker image prune -f >/dev/null 2>&1 || true
    fstrim -av >/dev/null 2>&1 || true
    avail_kb=$(df -k --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -d ' ')
    if [ -n "$avail_kb" ] && [ "$avail_kb" -lt 4194304 ]; then
      echo "WARN: only $((avail_kb / 1048576)) G free for Docker; a pull wants closer to 4 G of headroom" >&2
    fi
    # A failed pull changed NOTHING yet - the rollback below is for the
    # post-rename steps, where it restores correctly. Deleting the running
    # container here would strand the instance on a registry hiccup
    # (review finding, operator ruling 2026-09-29). A full disk says exactly
    # that word in docker's own error and nothing else, so on failure the
    # script names the filesystem's state and the two ways out.
    if ! docker pull "$IMAGE"; then
      df -h /var/lib/docker >&2 || true
      echo "pull failed: the running container was left alone" >&2
      echo "    if the filesystem above is close to full: 'docker image prune -a -f' inside CT $ctid" >&2
      echo "    frees every image no container uses; on an lvm-thin host also TRIM with" >&2
      echo "    'pct fstrim $ctid' on the HOST (an unprivileged container's own fstrim is" >&2
      echo "    refused, so deleted blocks never reach the pool otherwise), and" >&2
      echo "    'pct resize $ctid --disk <new-total>' grows the container's disk around it." >&2
      exit 1
    fi
    # Clear a stale -old from an interrupted earlier run first: the rollback
    # below rm -f's $NAME to resurrect $NAME-old, so a leftover -old would
    # make it destroy the HEALTHY container to resurrect garbage.
    docker rm -f "$NAME-old" >/dev/null 2>&1 || true
    # With any stale -old cleared above, a failed rename means nothing changed
    # - the rollback would destroy the healthy container to restore nothing.
    docker rename "$NAME" "$NAME-old" || { echo "rename failed: the running container was left alone" >&2; exit 1; }
    docker stop "$NAME-old" >/dev/null || rollback
    docker run -d --name "$NAME" --restart unless-stopped -e SUBSHELL_CONTAINER_RESTART=1 \
      -p "$APP_PORT:3080" -v "$DATA:/data" "$IMAGE" >/dev/null || rollback
    ok=""
    for _ in $(seq 1 60); do
      curl -sf "http://127.0.0.1:$APP_PORT/api/setup/status" >/dev/null && { ok=1; break; }
      sleep 2
    done
    [[ -n "$ok" ]] || rollback
    docker rm -f "$NAME-old" >/dev/null 2>&1 || true
    # The re-pull untagged the image the old container was the last user of;
    # with that container gone it is dangling, and this is the moment the
    # NEXT update's headroom comes back.
    docker image prune -f >/dev/null 2>&1 || true
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
  select_storage BACKUP_STORAGE backup "Backup storage"
  vzdump "$CT_ID" --mode snapshot --compress zstd --storage "$BACKUP_STORAGE"
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
  *) msg_err "usage: proxmox-server.sh [install|update|remove|backup|restore]" ;;
esac

---
"@internal/server": minor
"@internal/docs": patch
---

Docker release image and Proxmox LXC install rail: a signed-release GHCR image (tmux + the five harness CLIs, per-install secret minted at first boot), the proxmox.sh host helper with install/update verbs, and an update rail that names the image as the unit of update inside containers (UPDATE_CONTAINERIZED, the containerized deployment fact, and `update --check` reporting it).

---
"@internal/server": minor
"@internal/docs": patch
"@internal/website": patch
---

Docker release image and Proxmox LXC rails: a signed-release GHCR image (tmux + the five harness CLIs, per-install secret minted at first boot), the proxmox-server.sh host helper with install/update verbs, a proxmox-node.sh helper whose container enrolls as a node through the instance's own setup-keyed rail, and an update rail that names the image as the unit of update inside containers (UPDATE_CONTAINERIZED, the containerized deployment fact, and `update --check` reporting it).

---
"@internal/website": patch
"@internal/docs": patch
---

The Proxmox server helper's update now pulls the newest published image. Installs recorded the image ref they used in `/etc/default/subshell-docker`, and update kept re-pulling that recorded ref forever, so a fresh helper could stay on an old release with no way to see why. Updates follow `latest` now, and `SUBSHELL_VERSION=<tag>` (or `IMG`) names the image for one run; the log prints it before pulling.

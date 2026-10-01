---
"@internal/server": patch
"@internal/node": patch
---

Fix Proxmox installation with Proxmox-managed template downloads, compatible Debian templates, cluster-wide container IDs, and selection of active container, template, and backup storage. Stop before container creation when template discovery or download fails.

Check anonymous access to the server image before creating a container, and require anonymous pulls in image publishing smoke checks.

Detect and persist the Proxmox container browser address before startup so first-run signup succeeds from another device and remains configured across updates.

Prompt for additional comma-separated browser IPs, domains, and URLs, link to the address documentation and dashboard settings, and increase the server container disk default to 20 GB.

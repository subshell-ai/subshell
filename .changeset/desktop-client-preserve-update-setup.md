---
"@internal/desktop-client": patch
---

Preserve saved control plane addresses when upgrading from older clients. Keep existing node registrations out of first run when the node CLI cannot answer, and wait for the registration check before showing setup.

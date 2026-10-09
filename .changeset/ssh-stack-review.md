---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-client": patch
"@internal/desktop-server": patch
---

Fix SSH saved destination ports, jump-host alias resolution, identity paths containing spaces, and multiple known-hosts files. Host-key capture now selects keys for the exact destination port. Enrollment without a confirmed connection identifies the enrolled node instead of offering another installation.

Connections using another machine's keys now explain that ProxyJump and HostKeyAlias are unsupported before launch. Direct connections refuse jump-specific authentication or trust settings that cannot be preserved.

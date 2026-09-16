---
"@subshell-ai/plugin-api": patch
---

Network manifests may declare `publishImplicit: true`

`subshell.network.publishImplicit` is a boolean a network plugin sets when its
publish leaves NOTHING the daemon can later be asked about — NetBird's publish
runs no command, so its status can only ever report `joined`. The flag tells
the host that for that plugin its own publish record IS the published state,
and the server upgrades `joined` to `published` only when the record exists
AND the flag is set. A plugin without it is never upgraded: Tailscale's serve
state is readable, so a serve reset from a terminal must keep showing `joined`
however confidently the host's record disagrees. `parseManifest` refuses a
non-boolean value.

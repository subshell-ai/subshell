---
"@internal/server": patch
---

The plane can fetch from GitHub again. The egress pin's host list carried
GitHub's old release-asset hostname, so the renamed host every release
download now redirects to was refused by name: a fresh server answered
"could not provide a linux-x64 node binary" and refused to verify a
release's signature (the 1.0.0 post-cut proof measured the failing hop and
this patch is its fix). Both spellings are allowed now, the test pins both,
and `docs/security.md` names them.

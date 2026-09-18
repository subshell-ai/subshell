---
"@internal/docs": minor
---

The updating pages now teach the signed-releases trust model instead of the retired one: every release carries a signed `release-manifest.json`, every update path verifies the publisher's minisign signature against a key compiled into the product, and install digests come from the signed manifest's `assets` map — never the release host's `.sha256` sidecar. The desktop apps are no longer the lone stronger case; the accounted exceptions (the install one-liners, `--from`, an empty `SUBSHELL_RELEASE_URL`) stay stated.

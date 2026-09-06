---
"@internal/server": patch
---

Fix the node enroll flow on binary-only server installs. `GET /api/settings/public` now reports `nodeArtifactTargets` — the triples `/api/downloads/node/*` actually serves — so the Add-node dialog warns when the copyable install one-liner would 404 and shows the `subshell enroll` fallback instead; the rendered `install.sh` now prints the same guidance instead of dying with a bare `curl(22)`.

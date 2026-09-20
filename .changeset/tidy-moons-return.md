---
"@internal/server": patch
---

A server that has never had node artifacts published into its data dir can now
actually lazy-fetch one. `fetchArtifact` opened its temp file inside
`<dataDir>/node-artifacts/` and nothing in production code ever CREATED that
directory — every test fixture made it first, so the fetcher passed CI while
any ordinary install answered its nodes' first update-download with a 404 whose
real cause, a `ENOENT` on the plane's own filesystem, appeared only in the
server log. The fetcher now mkdirs recursively before writing; a regression
test removes the fixture's directory first, and reproduces the exact ENOENT
without the fix.

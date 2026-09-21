---
"@internal/server": patch
---

A hidden tab is now also a gated URL. The node Service / Configuration / Logs pages became real top-level routes, which made deep links reach them for exactly the viewers whose tabs are hidden: typing `/nodes/local/service` rendered a card announcing the LIVE control plane was "offline, nothing to report" — the route it calls answers 400 for `local` and 403 for a `view` grantee. Those deep links now redirect to the Overview the nav points at, through the SAME exported rule the nav hides by (`managesNodeSections`), so the two cannot drift. The generated-route-tree test gained teeth: each section's own route object is pinned by id, path and parent (a whole-file substring scan passed even on swapped paths), and the visibility rule is pinned as a full table.

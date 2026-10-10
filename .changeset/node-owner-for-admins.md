---
"@internal/server": patch
---

An admin's node view now names the node's owner. The Nodes list shows an operator every machine on the plane, and until now none of it could say WHOSE machine a row is: `access` says the node is not yours, not whose it is. A node view rendered to an admin carries `ownerLabel` (name, falling back to email, then the raw id for a removed account) and the node page shows it as an "Owner" line; `local` names the `system` service user. Every other viewer's payload lacks the field entirely, same admin-only shape as the setup-key listing's owner label.

---
"@internal/server": patch
---

An admin can now delete and re-register a node they do not own. The list fix (2026-10-09) put every machine on the admin's Nodes page, but Delete and Re-register stayed owner-only, so the page showed a foreign machine an operator could open and update yet not retire. The retire gate (delete and re-register) is now owner or any admin; managing a foreign node's SHARES, rename, maintenance and the allowlist stay owner-only, because ending your own view of a machine is a weaker act than deciding who else may use it. A recovery key an admin mints is stored under the node's owner, so recovery still lands on that person's machine.

Two buttons stopped lying about a node that is not connected. Update is disabled on a node that is offline and NOT held (only a held link, still answering the update command, can be rescued), with the reason on the button; on a held node it stays live and the card says so in one line. Re-check is disabled unless the node is online, because detection needs a live socket that a held link drops. Both mirror the server's own Updates-page rule rather than trading a click for a 409.

In the account menu, the server version and the instance (machine) name now sit on separate lines, so a long hostname no longer truncates the version away.

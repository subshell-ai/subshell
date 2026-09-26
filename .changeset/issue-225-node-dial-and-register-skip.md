---
"@internal/node": patch
"@internal/desktop-client": patch
---

fix(node), fix(client): the #225 invalid state self-heals and can no longer be installed. The node agent now ignores a loopback `nodeWsUrl` persisted beside a remote `serverUrl` (the residue a server whose base URL was never configured leaves behind, surviving a reset that keeps this file) and dials the plane `config.json` actually names; same-machine loopback pins are untouched. The Subshell Client's register chain skips its enroll act only for a same-plane retry, so a machine carrying an old registration to a different server re-enrolls behind the existing confirm rather than silently starting a node bound to the wrong plane.

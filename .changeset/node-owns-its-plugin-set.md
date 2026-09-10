---
"@internal/server": minor
"@internal/node": minor
---

A node now owns which harnesses it offers.

`<dataDir>/plugins/` on the node is the answer: what is installed there is what that machine offers, and the enable table the control plane used to keep is gone. The node reports its set, the server mirrors it, and installing or removing one is a signed command to a running node. An offline node is refused rather than queued, so the Nodes page can never show a plugin a machine is not actually running.

Two consequences you can see. A node can offer a plugin this control plane has never heard of, because the list comes from the node. And a node that has never reported shows nothing rather than a list invented here, which is the honest rendering for a machine running an older agent.

Existing nodes keep working: on first start after upgrading, an agent seeds the built-ins it carries. That happens once, keyed on the plugins directory not existing yet, so uninstalling a plugin is not undone by the next restart.

**This requires upgrading agents and the server together** (node protocol v6).

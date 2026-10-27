---
"@internal/server": patch
"@internal/node": patch
---

A pane's **Enable text copying** toggle now asks the preference what the device actually holds before deciding what the press did. The header menu and the touch bar share one per-device set, and each used to flip its own React copy of it, so a press that followed another window's change could "turn copying off" on a pane that was already off and say so out loud. In a private window, where the device stores nothing at all, the two surfaces disagreed the other way: the one you clicked remembered your click while the other re-read an empty store. Both now take the answer the preference module holds, which is also what a refused write leaves the page with.

`get_node` also reports a display provider's enabled state using the plane's own three configuration checks: the node switch, the provider catalog, and the owner's enabled list, with the protocol's default rather than a copied name. Whether the machine can run it stays in `status`, which is the node's answer. Before, an id outside the catalog sitting in the stored list read as enabled here while a launch refused it, and the absent-list case disagreed with the server about which provider that even is.

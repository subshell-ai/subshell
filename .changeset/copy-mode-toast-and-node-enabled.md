---
"@internal/server": patch
"@internal/node": patch
---

A pane's **Enable text copying** toggle now reports what it actually did. The header menu and the touch bar share one per-device preference, and each decided its own outcome from React's copy of the state: press both in the same batch and the second announced "Text copying enabled" about a mode that had just been switched off. Button, toast and the other surface now all read what the preference module holds, which is the same mechanism that keeps the two agreeing when a private window refuses to write at all.

`get_node` also reports a display provider's enabled state using the server's own three checks: the node switch, the provider catalog, and the owner's enabled list, with the protocol's default rather than a copied name. Before, an id outside the catalog sitting in the stored list read as enabled here while a launch refused it, and the absent-list case disagreed with the server about which provider that even is.

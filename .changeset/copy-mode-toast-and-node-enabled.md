---
"@internal/server": patch
"@internal/node": patch
---

A pane's **Enable text copying** toggle now asks the preference what the device actually holds before deciding what the press did. The header menu and the touch bar share one per-device set, and each used to flip its own React copy of it, so a press that followed another window's change could "turn copying off" on a pane that was already off and say so out loud. In a private window, where the device stores nothing at all, the two surfaces disagreed the other way: the one you clicked remembered your click while the other re-read an empty store. Both now take the answer the preference module holds, which is also what a refused write leaves the page with.

`get_node` also holds its answer about a display provider to the same rule the launch path applies, mirroring all three of the plane's configuration gates: the node switch, the provider catalog, and the owner's enabled list, with the protocol's own default rather than a provider name typed into the tool. Whether the machine can actually run it stays in `status`, which is the node's answer, not the plane's. The API refused an out-of-catalog provider on the way in already, so nothing a user could click read wrong before this; what changes is that a row which arrives by some other route, or one a later release shrinks out of the catalog, can no longer be reported ready here and then refused by the launch it recommended.

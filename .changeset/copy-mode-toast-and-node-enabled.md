---
"@internal/server": patch
"@internal/node": patch
---

A pane's **Enable text copying** toggle now reports what it actually did. The header menu and the touch bar share one per-device preference, and each decided its own outcome from React's copy of the state: press both in the same batch and the second announced "Text copying enabled" about a mode that had just been switched off. Button, toast and the other surface now all read what the preference module holds, which is the same mechanism that keeps the two agreeing when a private window refuses to write at all.

`get_node` also decides whether a display provider is enabled from the protocol's own default rather than a copied provider name, so it no longer tells an agent a provider is ready that the server is about to refuse with `preview-display-provider-disabled`.

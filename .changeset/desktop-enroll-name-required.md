---
"@internal/desktop-client": minor
---

The Enroll step's node name is required. It was optional because `subshell enroll`
defaulted to the machine's hostname, which is how a laptop ended up on the Nodes page
under a name nobody had chosen; the CLI requires the argument now, and so does this
form. The field is also what the control plane will store, character for character —
the name is normalized by the shared rule rather than sent raw — and a retry after a
spent key keeps the name you typed instead of making you enter it again.

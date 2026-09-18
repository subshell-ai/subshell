---
"@internal/docs": minor
---

The node pages follow the revamped setup: adding a node asks for nothing on the
control plane, the machine supplies its own name, and the reveal has two paths — a
terminal one-liner or the two values the Subshell Client app pastes. The setup-key
claims that were true under the old design are corrected where they were true no
longer: a key is not shown once and is not stored as a digest — it is listed in full to
whoever minted it, for as long as it can still enroll a machine, and the docs say why
that trade is bounded rather than skipping it. The scripted spelling of the node's name
(`SUBSHELL_NODE_NAME`, because `curl | bash` has no argv) is documented beside the
knobs that already worked that way.

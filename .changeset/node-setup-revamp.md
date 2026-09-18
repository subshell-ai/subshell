---
"@internal/server": minor
"@internal/node": minor
---

A node now names itself, on the machine. The Add-node dialog's "Node name" field is
gone — its text became only the setup key's label, while the node was named by its own
hostname whatever you typed — so step 1 is one press that mints a key, and the name is
asked where it can be answered: `subshell setup` asks "Name this node" with the
hostname prefilled, `--name` answers for a script, `SUBSHELL_NODE_NAME` answers through
the install pipe, and `subshell enroll` — the primitive that asks nothing — requires
`--name` outright, as does `setup` under `--yes`, `--json` or no terminal.

The reveal has two paths now, on a **Terminal | Desktop App** switch under the address
both of them need: the one-liner, or the two values Subshell Client's Enroll step
actually takes — server address and setup key, each copyable.

And the key is readable again after the dialog closes. The Setup keys card lists each of
your own keys in full until it is used, expires (24 h) or is revoked, which is why the
server stores the key itself rather than its SHA-256 digest: an unused key you cannot
read was a door you could only close. Single-use, owner-scoped, never in the audit log;
`docs/security.md` accounts for it. The migration drops every outstanding key, so mint
again after upgrading.

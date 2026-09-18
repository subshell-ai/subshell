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

And the cap on that name is counted in ONE unit now. `normalizeNodeName` caps
CHARACTERS, while a JSON Schema `maxLength` and a DOM `maxlength` count UTF-16 units, so
enroll's body, rename's body and the rename field each said 64 where the rule says 64
characters — a machine named with 40 emoji was legal at every door and refused at these
three. `NODE_NAME_MAX_UNITS` is the unit spelling of the same limit (twice the cap, which
is the most 64 characters can occupy), and the agent's `--name` preflight and `setup`'s
prompt count code points like the desktop field and Rust already did, so an emoji name
measures the same whether it was typed, pasted, prompted for or piped.

And the card now hands back the COMMAND as well as the key. A `Setup` button on each
usable row opens the same fields the mint dialog shows — address picker, Terminal |
Desktop App, the one-liner or the two values — because closing the dialog mid-copy still
lost the command, and re-reading instructions that had never been lost meant minting a
second single-use key. Rows whose key is spent or expired have no such button; steps for
an inert credential only end in a 401. The reveal itself moved to
`node-key-setup.tsx`, shared by both surfaces, and its two explanatory paragraphs are
gone: the command and the two labelled rows are the instruction. The tabbed group control
now divides its width between its options instead of leaving the rest of the pill empty.

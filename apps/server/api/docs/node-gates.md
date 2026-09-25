# Node refusal gates and their accounting. Moved verbatim from AGENTS.md ("Architecture"); AGENTS.md keeps the summary and routes here.

**A node is refused by TWO gates, in this order** (`node-ws-handler.ts`;
since spec 2026-09-15 §5.3 neither CLOSES any more; a refusal is
`holdRefusedNode` parking the socket in `node-registry.ts`'s `held` map, so
the node is offline for every purpose but `update`, its inbound frames are
dropped unparsed, and the 4406 close carrying the refusal reason the node
RELAYS to its own log comes only when the hold ends: ten idle minutes
(`HELD_IDLE_MS`), a newer socket, or `disconnectNode` on key rotation or
deletion; the held window is exactly what lets the Updates surface send the
one command that fixes it):

1. **The version floor.** `MIN_NODE_VERSION`
   (`@internal/subshell-protocol` `versions.ts`) is the operator-facing
   statement "this server needs subshell >= X". The reason names both the
   required and the found version. This is the gate an operator can act on,
   which is why it runs first. It rides EVERY protocol bump: the same
   commit raises it and `apps/node/agent/package.json` to one value, so the
   refusal always names a version that exists (the rule is stated in full
   in `versions.ts`); a floor-only raise is still possible for a behavior
   the plane needs without a frame change, and every bump since protocol 7
   has carried the floor with it; the earlier reset-week bumps carried it
   unevenly (1–4 held 0.1.0, 5 raised it to 0.3.0, 6 held), which is what
   the rule, now stated in full in `versions.ts`, exists to prevent.
2. **The protocol, matched EXACTLY.** Any `protocolVersion` differing from
   `NODE_PROTOCOL_VERSION`, in either direction, is refused; the reason names
   both numbers. No compatibility window, no per-feature gating; the server
   and the node ship together, so a mismatch is a deployment out of step
   rather than a node to be carried. Bump it whenever a frame changes,
   additive or not, and release both.

The identity is persisted BEFORE either gate, so a refused node still shows
its version on the Nodes page. The node detail page chips "node too old" /
"node too new" for a protocol mismatch and "below minimum" for a floor
refusal; Settings → Status lists every enrolled node under the floor in one
place, since a refused node looks like an ordinary offline node everywhere
else.

The two gates carry distinct meanings and emit distinct refusals (never
infer one from the other), but their SCHEDULES are not independent: the
floor rides every protocol bump (see `versions.ts`), so a node can be
below-floor and protocol-mismatched at once, and the floor refusal, which
runs first, is the one it hears.


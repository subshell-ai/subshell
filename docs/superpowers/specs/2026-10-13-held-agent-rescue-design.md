# Hold pinned wrong-protocol agents at the binding (spec 2026-10-13)

## The problem, measured

Spec 2026-09-15 §5.3 decided that a refused agent is HELD, not closed: the
row goes (or stays) offline, the Updates page renders it held (for this
reason, the line reads `needs update: speaks protocol 15, this server speaks
20` — `apps/server/web/src/components/updates/node-rows.tsx`), and the one
command that fixes the refusal — `update`, whose wire shape is frozen for
exactly this (pinned as a LITERAL in `node-frames.test.ts` on both sides of
the bump: `cli-node-v1.5.5` :860, current :1631) — still reaches the socket.
But that design predates the
encrypted link (protocol 14, spec 2026-09-24), and the link sits ahead of the
hold on the wire. Server 2.0.0 (protocol 20, floor 1.6.0) is the first bump
where a node already speaking the encrypted link fell below the floor, and the
node's journal shows the rescue never gets its chance:

```
disconnected (code 4410: handshake refused: protocol mismatch (node 15, server 20)); reconnecting
```

The refusal lands in `apps/server/api/src/services/nodes/link-session.ts`
(`completeBinding`): the binding carries `protocolVersion`, the three checks
name it exact-match, and a mismatch closes 4410 BEFORE the agent's `ready`
ever reaches the gates that hold it (`node-ws-handler.ts`, the `below-floor`
and `protocol-mismatch` arms). So today's §5.3 hold is reachable only by
agents on the plaintext path — rows with no encryption pin, agents from before
protocol 14. Any pinned agent on an old protocol redials forever and the
Updates page answers "this node is offline". An operator walks to the machine,
which is the exact outcome §5.3 exists to prevent.

Two facts make the fix small, both verified against the agent as it actually
ships (tag `cli-node-v1.5.5`, protocol 15):

- The negotiator refuses any encrypted first frame that is not the sealed
  `{t:"ok"}` ack, and refuses plaintext on an established link. So a held
  pinned socket must COMPLETE the handshake (the agent has to see its ack),
  and the rescue then travels sealed through the session the handshake
  derived.
- Everything downstream of the hold already treats a held connection as a
  first-class target: `sendCommand` routes `update` to `getHeld()` when there
  is no live conn, seals when `conn.link` is set, the update route counts held
  as reachable and reads `held?.agentVersion ?? row.agentVersion` for its
  version column, and the handler's held gate drops every forwarded frame
  except `result`, settling that one through the ordinary correlation.

## Decision: hold from the binding

When `completeBinding` has passed the identity checks — the binding decrypted
under the pinned session, its `nodeId` names the bearer's row, its `nodeKey`
re-proves through the upgrade's own chain — but the protocol does not match,
the plane ESTABLISHES the link (sends the sealed ack) and proposes the hold.
The agent believes it connected, arms its timers, and sends its `ready`; the
plane's held gate drops that and everything else except the `result` of the
`update` it is now free to send, sealed, over the session both ends derived.
The agent's `update` executor does the rest: downloads, verifies against its
compiled-in publisher key, swaps, restarts — and the reboot speaks the
current protocol and comes online normally.

**Why not lift the check into the ready path instead.** The tempting version
deletes the protocol arm from the binding and lets the old agent's `ready`
reach the existing ready-path hold gate. It reuses more code and stamps
fresher held facts (the `ready` carries them). It fails on the frame AFTER
that gate's trust: the held decision would depend on the old build's `ready`
parsing under TODAY's strict grammar. The day it doesn't, the frame is
dropped as unrecognized — the agent's link is established, its heartbeats
keep the socket warm, and the plane sees nothing. That is the "silent
permanent stall" the R10 ruling documents — the failure the binding gate's
no-resync doctrine exists against, and the one its ready-path backstop names
in passing: "parsing frames from an agent that does not speak them is worse
than refusing" (`node-ws-handler.ts`, the protocol-mismatch gate's own
comment). The binding is the LAST frame whose shape the
server proves it can parse — it just decrypted and validated it — so it is
the honest place to decide the hold. The ready-path gates stay as the
backstop they are documented to be.

**The gate-ordering ruling this inverts.** `docs/node-gates.md` (and the
paragraph `apps/server/api/AGENTS.md` mirrors) says a node is refused by TWO
gates IN ORDER — floor first, protocol second — and "a node meeting both
conditions hears the floor's", because "the floor refusal, which runs first,
is the one it hears" and it names the version to install. That ordering is
physically impossible on a pinned dial: the binding carries only
`{nodeId, nodeKey, protocolVersion}`, so the server cannot know the agent
VERSION at the moment it decides the protocol, and the binding decision now
runs before any version gate. The ruling the docs must carry after this
change: **a pinned node meeting both conditions hears the PROTOCOL sentence,
at the binding**; the floor-first ordering survives exactly where it still
physically runs first — on the legacy plaintext path, and for floor-only
raises (an agent matching the protocol but below the floor, which the
shipping rule makes unreachable and the ready-path backstop still holds).
The incident's own node is this case: 1.5.5 is both below-floor (< 1.6.0)
and protocol-mismatched (15 ≠ 20), and it will now hear "protocol v20
required" rather than "subshell 1.6.0 or newer required". The page is
unhelped by the swap — it already renders `needs update: speaks protocol N`
for `protocol-mismatch` — and the remedy is one click either way. The same
doc line's "The identity is persisted BEFORE either gate" needs its
carve-out stated: on the binding path nothing NEW is written; the held facts
are whatever the row's last honest `ready` left, or the fallbacks — which is
the §5.3 posture, since the gate that would write facts (`applyReady`) is
the one this path never reaches.

## The change

### 1. `link-session.ts` — `completeBinding` proposes, never writes

The third check's mismatch arm returns a new `LinkOutcome` variant instead of
`refuse`:

```
{ consumed: true; established: LinkSession; sendBytes: Uint8Array; hold: { protocolVersion: number } }
```

`sendBytes` is the ordinary sealed `{t:"ok"}` ack; `hold` is a PROPOSAL —
the machine keeps its doctrine of deciding without writing or holding
anything, and the handler owns the socket and the DB. Identity refusals
(wrong `nodeId`, dead or foreign `nodeKey`) are unchanged: they stay 4410
close, BEFORE and independently of the hold decision. A matching protocol
returns today's variant untouched, so the live path is byte-identical.

**The mismatch arm must ALSO set `data.linkPhase = "established"` beside the
return, exactly as the match arm does today** (`link-session.ts:346`). Phase
is machine-owned scratch state — the handler cannot set it — and the
consequence of skipping it is the incident recreated one frame later: the
1.5.5 agent sends its `ready` SYNCHRONOUSLY on the ack opening (`onEstablished
→ arm() → send(ready)`, `cli-node-v1.5.5` daemon.ts), that sealed frame
arrives at a phase still sitting at `awaiting-binding`, re-enters
`completeBinding`, decrypts fine, and dies on `parseLinkBinding` as
"handshake refused: binding malformed" — a 4410 close and the same redial
loop, one gate deeper.

### 2. `node-ws-handler.ts` — the handler applies the proposal

The `consumed && established` arm grows a branch for `hold`:

- wire `conn.link = session` (this is what makes `sendCommand` seal — no new
  send-path code), clear the handshake-deadline timer,
- read the row (`deps.nodes.findById`) and call the hold with facts from it:
  agentVersion / os / arch are the last ones its own honest `ready` wrote,
  `protocolVersion` is the one the binding proved. For a row that registered
  but never readied, agentVersion falls back to `""` — the same spelling
  "unversioned" already gets, and `semverLt("", x)` reads 0, so the route's
  UP_TO_DATE/DOWNGRADE gate falls through exactly as it intends — while os
  and arch fall back to `"unknown"`, the spelling the ready grammar itself
  uses. `""` would reach the route's `os && arch` truthiness test as absent,
  but its refusal copy interpolates `${os ?? "unknown"}` without a `""`
  guard, so a blank would render "for /"; `"unknown"` arrives at the existing
  named refusal — "No subshell binary is published for unknown/unknown" —
  and `from: "unknown"` beats `from: ""` in the audit row.
- the ordering is load-bearing and already true in production: frame
  handling is serialized per socket (`handleNodeMessageQueued`), so the hold
  lands BEFORE the agent's synchronously-sent `ready` is processed — by the
  time that frame reaches the switch, the held gate matches on
  `ws.data.nodeConn === heldEntry.conn` and drops it, and the superseded-
  socket probe behind it never sees a live-registry miss.
- `setStatus(nodeId, "offline")` + `announceNodePresence`: the row may still
  say `online` from before the server's own upgrade, and a held socket never
  closes, so the projection owes this line exactly like `holdRefusedNode`
  does,
- reason is the existing `"protocol-mismatch"`; the idle close (10 min → 4406
  "update required" with the reason the agent logs) and the supersede of an
  older held entry are `holdConnection`'s existing behavior.

Extract the body of `holdRefusedNode` into a `holdSocket(conn, nodeId, facts,
reason, message)` helper shared by the two hold sites (ready-path callers
keep running `applyReady` first, exactly as today; this site never runs it —
the whole point is that a build we cannot talk to writes no machine facts).

### 3. What does NOT change

- **The agent.** Zero lines, for any agent at protocol ≥14. 1.5.5's
  negotiator accepts the ack and a sealed command; its `update` executor has
  shipped since the 2026-09-15 update design. Pre-14 agents keep today's
  legacy plaintext hold, untouched.
- **`node-rpc.sendCommand`.** It already finds held conns for `update` and
  already seals when `conn.link` is set. The I-2 plaintext guard keys on
  `!conn.link`, which is false on this path by construction.
- **`update-node.route`.** Held-then-row version reading, artifact selection
  by os/arch, the `nut_` download token — all already written for a held
  node; they were just unreachable in practice.
- **The protocol doctrine.** This is not a compatibility window. An old
  frame that arrives after the hold still runs the envelope parse like any
  other (the parse sits BEFORE the held gate in `handleNodeMessage`), and
  then everything except the `result` of the `update` this plane sent is
  dropped "after the envelope parse and before the dispatch" — the exact
  wording `docs/security.md` §11.12 already uses. Nothing the old build says
  is acted on; only its own `result` settles its own correlation record.

### 4. Boundaries, stated honestly

- An agent whose BINDING the server cannot decrypt or parse (a future protocol
  that changes the handshake itself, or a pre-14 crypto mismatch) is refused
  4410 as today. The rescue holds what it can complete a handshake with, and
  nothing else.
- A held-and-established socket whose agent dies goes through the ordinary
  close path's held release (existing code).
- The idle close (HELD_IDLE_MS, armed once at hold time and reset by NO
  frame — forwarded heartbeats do not touch it) closes 4406 with the
  "update required" sentence, and that close is TERMINAL for EVERY agent
  that can reach a hold: 1.5.5's `onClosed` arm runs `revertAfterRefusal`
  (an in-flight update transaction keeps its `.previous` and rolls back) and
  `stop(1)`, and what brings the node back to redial into the hold again is
  the SERVICE MANAGER's restart, or a human at the machine; an unsupervised
  held agent simply stays offline until one of the two runs, which is also
  when it can self-rescue with `subshell update`. Review-round correction:
  this paragraph first claimed the terminality began with protocol 15 and
  that older agents reconnected through their in-process backoff. Task 5's
  review checked the tag history back to `cli-node-v0.13.0` (v1.0.0 and
  v1.4.0 print `the control plane refused this agent (close 4406): ... ;
  exiting` verbatim) and the backoff claim was wrong, not merely dated: the
  backoff loop serves ordinary network closes, never 4406. The
  `node-registry.ts` HELD_IDLE docstring now carries the corrected
  sentence. The timing interlock already favors us: the
  agent's `UPDATE_ACCEPTED_MS` settle timer is 15 min against the plane's
  10-min hold, so a rescue accepted at the deadline's edge reverts through
  the 4406 path rather than losing its rollback.
- The node stays offline for launches, tails, probes, detect, and every other
  command — the held map is second, `live` never sees it, and the blessed
  liveness predicates answer as they always did.

## Comments and docs that currently state the old reality

- `node-ws-handler.ts` (`handleNodeOpen` docstring): "which is also how every
  HELD socket reaches us" — held sockets now also reach us sealed, from the
  binding.
- `node-rpc.ts` (I-2 comment): "legacy and held sockets (true)" — a held
  socket can carry a link; the sentence must not imply plaintext-only. Same
  file's seal-site comment (line ~222): "the plaintext branch is the
  legacy/held path" — the held half now needs the same qualification.
- `node-registry.ts`, `NodeConnection`: the `link` docstring says
  `undefined` while the connection "speaks the legacy plaintext envelope —
  every held socket..."; the `plaintextAllowed` docstring says "every held
  socket is one" (legitimately plaintext). Both are false for a binding-held
  socket, which is HANDSHAKE-classified, `plaintextAllowed = false`, with a
  link. The frozen rescue rides the sealed arm for it and the plaintext arm
  for the legacy holds — one sentence, both true.
- `node-registry.ts`, HELD_IDLE docstring: "the agent's backoff loop
  reconnects" — wrong for every agent that can reach a hold, not merely
  dated (see the corrected boundary above: terminal 4406 for all of them,
  and the redial is the service manager's restart or a human, verified
  back to `cli-node-v0.13.0`).
- `completeBinding` docstring: the three checks still exist; what changed is
  the third one's failure shape.
- `holdRefusedNode` docstring: add the binding entry point (the shared
  `holdSocket` helper it becomes).
- `docs/node-gates.md` and the `apps/server/api/AGENTS.md` paragraph it
  mirrors: the ordering ruling, the floor-first sentence, and the
  "identity is persisted BEFORE either gate" line all need the amendment
  spelled out in "The gate-ordering ruling this inverts" above. These load
  into every agent's context; leaving them verbatim ships a contradiction.
- `.claude/rules/security-context.md` + `docs/security.md` (§6 / §11.12): the
  held story gains its second half — a pinned wrong-protocol agent is held
  FROM THE BINDING, its link established, its `update` sealed. Same posture,
  now actually reachable.

## Testing (test-first)

1. `link-session` unit: mismatched protocol with passing identity → the
   established+hold variant, ack sealed, AND the machine's `linkPhase`
   proven `"established"` (the one-line failure that recreates the incident
   is this assertion's whole job); wrong `nodeId` / dead `nodeKey` →
   unchanged 4410 refusals that NEVER carry `established`; matching protocol
   → today's variant with no `hold` field.
2. `node-ws-handler` integration: a fake pinned agent dialing protocol 19
   against the real machine — first server send is the sealed ack;
   `getHeld` answers reason `protocol-mismatch` with the row's
   agentVersion/os/arch and the binding's protocol; the row is projected
   `offline` and presence announced; the agent's next sealed `ready` is
   FORWARDED (not refused as "binding malformed") and then dropped by the
   held gate — it writes no row and no facts.
3. The §5.3 contract on the encrypted path: `sendCommand(…, {type:"update"})`
   to the held handshake-mode conn reaches it BINARY (sealed), never
   plaintext, and its `result` settles the correlation through the held gate.
4. Supersede: a redial while held replaces the entry and closes the old
   socket 4409 — the existing promise, pinned again from this new entry
   point.
5. The idle story: HELD_IDLE_MS elapsing on a binding-held socket closes 4406
   carrying the "protocol vN required" message the agent logs, and forwarded
   heartbeats during the window do NOT push the deadline.
6. Route-level, the spec's central claim on the wire that matters: `POST
   /api/nodes/:id/update` against a binding-held conn — the protocol gate
   passes (held `protocolVersion` ≥ `NODE_SIGNED_UPDATES_PROTOCOL_VERSION`,
   12; a held pre-12 row gets the existing `NODE_AGENT_TOO_OLD` by-name
   refusal), the version column reads held-then-row, the triple comes from
   held-then-row, and the `nut_` token is minted for the target the held
   facts select. The cross-version wire-shape proof is NOT reinvented: the
   LITERAL frozen-shape pins at `cli-node-v1.5.5`
   `node-frames.test.ts:860` and current `:1631` are the evidence.
7. The never-ready row: a pinned row with no os/arch/agentVersion → the hold
   still lands with the fallbacks (`""` / `"unknown"`), and the update route
   answers its existing named refusal ("No subshell binary is published for
   unknown/unknown") rather than misbehaving on the blank.

No schema changes anywhere in this spec, so the curated-migration-list trap
`apps/server/api/AGENTS.md` warns about (new columns must join service/
repository tests' hand-curated lists) does not apply here — worth stating
because the implementer's checklist cites it by default.

## Out of scope

- No compat window, no per-version frame handling anywhere.
- No agent-side change; no new close code.
- `MIN_NODE_VERSION` stays 1.6.0. A pinned agent behind the protocol is held
  at the BINDING now; the ready-path protocol gate keeps holding the cases
  it can still physically reach — legacy plaintext dials, and the
  shipping-rule-impossible floor-only raise that passes binding.
- The desktop Updates page needs nothing: it renders `held` today.

## Immediate remedy for the live incident

The fix lives on the plane, so it cannot reach the stuck node until the
server there carries it. The 1.5.5 agent already ships a `subshell update`
verb (signed-manifest download, transactional swap, service restart), which
is the walk-to-the-machine's substitute on one's own machine — it is the
immediate remedy for the node that started this spec. This spec makes that
walk unnecessary for every future bump.

# Hold pinned wrong-protocol agents at the binding (spec 2026-10-13)

## The problem, measured

Spec 2026-09-15 §5.3 decided that a refused agent is HELD, not closed: the
row goes (or stays) offline, the page shows "held (waiting for update)", and
the one command that fixes the refusal — `update`, whose wire shape is frozen
for exactly this — still reaches the socket. But that design predates the
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
permanent stall" the R10 ruling documents, and it is exactly what the binding
gate was written against ("parsing frames from an agent that does not speak
them is worse than refusing"). The binding is the LAST frame whose shape the
server proves it can parse — it just decrypted and validated it — so it is
the honest place to decide the hold. The ready-path gates stay as the
backstop they are documented to be.

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

### 2. `node-ws-handler.ts` — the handler applies the proposal

The `consumed && established` arm grows a branch for `hold`:

- wire `conn.link = session` (this is what makes `sendCommand` seal — no new
  send-path code), clear the handshake-deadline timer,
- read the row (`deps.nodes.findById`) and call the hold with facts from it:
  agentVersion / os / arch are the last ones its own honest `ready` wrote,
  `protocolVersion` is the one the binding proved. An agent that registered
  but never readied falls back to `""` — the same spelling "unversioned"
  already gets — and a row missing os/arch still holds: the update route
  answers those with its existing refusal naming what it lacks,
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
- **The protocol doctrine.** This is not a compatibility window. Nothing
  downstream of the ack parses old frames — the held gate is the parser, and
  it accepts one type.

### 4. Boundaries, stated honestly

- An agent whose BINDING the server cannot decrypt or parse (a future protocol
  that changes the handshake itself, or a pre-14 crypto mismatch) is refused
  4410 as today. The rescue holds what it can complete a handshake with, and
  nothing else.
- A held-and-established socket whose agent dies goes through the ordinary
  close path's held release (existing code).
- The node stays offline for launches, tails, probes, detect, and every other
  command — the held map is second, `live` never sees it, and the blessed
  liveness predicates answer as they always did.

## Comments and docs that currently state the old reality

- `node-ws-handler.ts` (`handleNodeOpen` docstring): "which is also how every
  HELD socket reaches us" — held sockets now also reach us sealed, from the
  binding.
- `node-rpc.ts` (I-2 comment): "legacy and held sockets (true)" — a held
  socket can carry a link; the sentence must not imply plaintext-only.
- `completeBinding` docstring: the three checks still exist; what changed is
  the third one's failure shape.
- `holdRefusedNode` docstring: add the binding entry point.
- `.claude/rules/security-context.md` + `docs/security.md` (§6 / §11.12): the
  held story gains its second half — a pinned wrong-protocol agent is held
  FROM THE BINDING, its link established, its `update` sealed. Same posture,
  now actually reachable.

## Testing (test-first)

1. `link-session` unit: mismatched protocol with passing identity → the
   established+hold variant, ack sealed; wrong `nodeId` / dead `nodeKey` →
   unchanged 4410 refusals that NEVER carry `established`; matching protocol
   → today's variant with no `hold` field.
2. `node-ws-handler` integration: a fake pinned agent dialing protocol 19
   against the real machine — first server send is the sealed ack;
   `getHeld` answers reason `protocol-mismatch` with the row's
   agentVersion/os/arch and the binding's protocol; the row is projected
   `offline` and presence announced; a forwarded `ready` arriving after the
   hold writes no row and no facts.
3. The §5.3 contract on the encrypted path: `sendCommand(…, {type:"update"})`
   to the held handshake-mode conn reaches it BINARY (sealed), never
   plaintext, and its `result` settles the correlation through the held gate.
4. Supersede: a redial while held replaces the entry and closes the old
   socket 4409 — the existing promise, pinned again from this new entry
   point.
5. The idle story: HELD_IDLE_MS elapsing on a binding-held socket closes 4406
   carrying the "protocol vN required" message the agent logs.

## Out of scope

- No compat window, no per-version frame handling anywhere.
- No agent-side change; no new close code.
- `MIN_NODE_VERSION` stays 1.6.0 (an agent at the floor but behind the
  protocol is the ready-path backstop's case, and it still holds).
- The desktop Updates page needs nothing: it renders `held` today.

## Immediate remedy for the live incident

The fix lives on the plane, so it cannot reach the stuck node until the
server there carries it. The 1.5.5 agent already ships a `subshell update`
verb (signed-manifest download, transactional swap, service restart), which
is the walk-to-the-machine's substitute on one's own machine — it is the
immediate remedy for the node that started this spec. This spec makes that
walk unnecessary for every future bump.

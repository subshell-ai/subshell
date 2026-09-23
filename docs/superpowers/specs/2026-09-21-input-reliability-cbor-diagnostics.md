# Input reliability, wire compression, and pane diagnostics

**Status:** approved (operator, 2026-09-21) — three waves, one spec.
**Context:** operator reports typing lag on terminal-plugin panes (remote node
seen worst), plus two protocol asks. Current truth, measured in code:

- **Input is fire-and-forget on every leg.** The browser `/ws` handler does not
  await the launcher; local panes get a `send-keys` spawn; remote panes get a
  signed `input` command. A failed write is logged and the keystroke is gone.
  Nothing retries. Output is the reliable half (replay + overlap join).
- **Remote keystrokes queue behind the node's serialized command chain.** The
  daemon executes every command through ONE chain (`daemon.ts` `execute`), so an
  `input` waits for any `capture`/`tail_start`/inventory probe ahead of it.
  With the dashboard's preview pulls hammering `capture`, typed keys wait.

The waves fix loss, then visibility, then size. Each is separately shippable.

## Wave A — idempotent input queue with retry (protocol-additive)

**Semantics: at-least-once with server-side dedupe.** Terminal input cannot be
"exactly once" over a reconnecting socket; it CAN be idempotent.

### Wire (browser `/ws` contract, additive)

- Client input frames gain an optional `id` (integer, per-subshell monotonic,
  client-generated starting at 1 per attach session, carried across
  reconnects). A frame without `id` behaves exactly as today (old clients).
- After the pane write LANDS (the launcher's `sendInput` promise resolves —
  local: the send-keys spawn; remote: the node's `result` frame), the server
  emits `{ type: "ack", id }`.
- Server keeps a per-subshell rolling window (512) of processed input ids. A
  re-sent id inside the window is dropped without re-writing the pane. This is
  what makes client retry safe against the one fatal ambiguity (write done,
  ack lost in flight).

### Client (`use-subshell-ws.ts` + a small `lib/input-queue.ts`)

**Batching (operator addendum, 2026-09-21).** A paste arrives as one xterm
`onData` (already one frame), but a single oversized body must never ride one
frame: the node's byte guard would drop it whole. The queue therefore
- **chunks** every entry to a frame cap (well under the node's
  `NODE_MAX_FRAME_BYTES`; 32 KiB is the working number), each chunk its own
  id, sent in order, individually acked and retried; and
- **coalesces on backpressure**: while the queue is non-empty, newly enqueued
  input appends to the tail entry instead of opening a new frame, so a burst
  typed during a lag becomes a few large frames rather than one frame per
  keystroke. Order is preserved by construction (append-only, same
  destination).

- Pipelined: every keystroke is sent immediately; acks flow back
  asynchronously. No head-of-line blocking on acks while connected.
- Retry lives on RECONNECT, not on a timer: on a new socket, re-send every
  unacked id in order (the dedupe window absorbs any that were processed
  before the old socket died). No mid-connection resend — while the socket is
  alive, TCP ordering means an unacked frame is "not yet", never "lost".
- On `ack`, record the round-trip time (sent timestamp kept per id) and drop
  it from the queue. Queue depth and per-id RTTs feed the HUD (Wave C).
- Batching (operator addendum, 2026-09-21): every queued entry SERIALIZES to
  at most 32 KiB (the JSON frame's byte length, not the string's, so
  escaping is part of the cost; well under the node's 1 MiB frame cap), so a
  large paste becomes several chunks with sequential ids, acked and retried
  independently; and while the queue holds anything (the pipe is behind), a
  new enqueue JOINS the unsent tail, filled to the chunk cap with the
  remainder spilling into further chunks, shipping when the acks drain, on
  reconnect, or on an explicit resend. Sent bytes are frozen: an id names
  exactly the bytes the server may have written, so coalescing only ever
  targets unsent data.
- Overlay badge on the terminal, always on when the queue is non-empty
  (independent of diagnostics mode): `N ⌨` with animated `>>>`, amber when an
  id has been unacked past 2 s. Two sentences of copy max, no em dashes.

### Node fast path (the actual lag fix)

- `daemon.ts`: `input` commands stop going through the single serialized
  chain. A per-socket INPUT chain runs input commands in arrival order,
  concurrently with the main chain. Input keeps its order relative to input;
  it no longer waits for captures, probes, or launches.
- Not a protocol change: the plane already fires each `input` as its own
  signed command. The node just stops serializing them with everything else.
- `resize` stays on the main chain (rare, and read-your-writes adjacent).

### Tests

- Server: ack after write; dedupe of a re-sent id; no-id frames unchanged.
- Node: input chain ordering (input N before N+1 even under a concurrent
  slow capture) — unit test with a stubbed tmux runner.
- Client: queue re-send on reconnect; RTT capture; badge counts.

## Wave B — CBOR frames on `/ws` (opt-in negotiation, CBOR default when supported)

- Library: `cbor2` (pure TS, bun-safe). Repo-side thin wrapper so no call site
  imports the package directly (`lib/wire-enc.ts` server equivalent).
- Negotiation: attach URL gains `enc=cbor`. The server answers ALL frames as
  CBOR binary and accepts CBOR binary client frames; a client that does not
  send the param gets today's JSON both ways, byte-identical. Older clients
  (cached PWAs, the mobile app until it adopts) simply never negotiate.
- The big win is server→client (output chunks and replay, the text-heavy
  direction). Client→server stays JSON-shaped even under CBOR (keystroke
  frames are tiny) unless profiling says otherwise — v1 keeps both sides on
  CBOR only if the encoder makes it free.
- `e2e` spec 10's contract checks stay green in JSON mode; a new spec
  exercises a negotiated attach end to end.
- Mobile adoption is its own follow-up: same protocol, second client.

## Wave C — pane diagnostics HUD

- Toggle: "Diagnostics" item in the subshell view's actions menu. Overlay
  floats over the terminal, styled like the devices strip (top-right, dense,
  `detail` type role).
- Rows, all derivable client-side except the queue stats (Wave A):
  socket state + reconnect count; server↔node (`nodeOffline`/`held`,
  node last-seen); pane↔tmux (`alive`, exit code); output age (wall clock
  minus `lastOutputAt`); input: sent / acked / unacked, echo RTT p50 and max;
  viewers and current grid.
- No new server surface; the node connection facts come from the live feed
  the page already holds.

## Sequencing

A (server + node + client queue + badge) → B (encoder + negotiation) →
C (HUD, consumes A's RTT stats). A and B both touch `subshell-ws.ts` and
`use-subshell-ws.ts`; sequential waves, reviewed each, avoid the collision.

## Wave D — the plane→node wedge (2026-09-22)

Measured after A shipped: the at-least-once machinery holds on the
browser↔plane leg, but the plane→node leg fails INDEPENDENTLY while the
browser socket lives. A node daemon restart, a mesh blip, or a command
timeout makes the plane's `launcher.sendInput` reject; the old
`.catch(logFailure)` dropped the keystroke, no ack fired, and no dedupe
commit happened. The client never learns: its queue holds a sent-but-unacked
frame, `flushBacklog` early-returns while any sent frame is unacked, so every
later keystroke coalesces into the unsent tail and waits for an ack that will
never come. And the escape hatch is welded shut: the browser socket only
reconnects when IT dies, a reconnect DURING the outage is refused 4004 "node
offline", which the client treated as terminal — typing stays dead until the
page is remounted, and a remount drops the stranded bytes permanently.
Reproduced 100%.

**The plane-side retry (server, the load-bearing half).** A failed
plane→node write for an attached session is held, keyed
(node, subshell, session, id) beside the dedupe window's own keying
(`ws/input-hold.ts`), and re-fired through the SAME `launcher.sendInput` path
when the node's connection is live again — the node-ws-handler's `ready`
moment for that node. Four rules:

1. **Scoped to the attached /ws session.** The browser socket closing drops
   its holds; the client's own reconnect re-send is the safety net for what
   they held (a duplicate at worst, never a loss).
2. **The re-fire is the same write.** The drain reads the session's
   launcher off `ws.data` at write time, so acks and the dedupe window
   behave identically. The dedupe window is committed BEFORE the ack, on the
   write resolving (verified in `handleSubshellMessage`, unchanged) — so a
   resolved write is never re-fired and its re-send is absorbed; only a
   write whose result never came back can double, Wave A's accepted
   residual.
3. **No timer.** The re-fire triggers are the node's `ready` and a new-write
   arrival (which joins the queue and kicks the drain); a re-fire failure
   re-enters the hold. Memory is bounded by the client's own backlog: once a
   write goes unacked the client coalesces and stops shipping, and a
   re-arriving id never duplicates a hold.
4. **Order.** Holds re-fire in id order; an arrival while holds exist joins
   the queue, so nothing newer is written ahead of a held id. The accepted
   residual is the frame already in flight on the node's serial input chain
   when its neighbor failed — it can land before the re-fire, the same
   at-least-once family, with a sub-millisecond window.

**Amendment 2026-09-22 (the typing-lag wave).** The client queue now flushes
the coalesced backlog on a 30 ms window and pipelines up to 8 sent-unacked
frames (measured on the AI PC node: ack-serialized flushing made typing one
burst per ~350 ms round trip). Rule 3's BOUND survives — the client's
512-frame pending queue was always the ceiling — but its stated reason ("the
client coalesces and stops shipping") no longer describes the client. Rule
4's residual is WIDER: the burst siblings of a failed write are already
queued on the node's serial chain, so the held re-fire lands after them —
keystrokes can reorder within one burst on a partial plane→node failure
(never lost; closing it means carrying the client id onto the node's chain,
a protocol change, against the at-least-once posture). The living accounting
for both now reads in `ws/input-hold.ts`.

**The 4004 refusal is retryable (client).** Wave A's client never retries a
4xxx close. The table is now: sub-4000 drops and restarts retry on the fixed
1.5 s cadence; **4004 retries on an escalating backoff (base, doubling,
capped at 15 s, reset by a successful attach)**, because "node offline" can
clear while the terminal is open — the backlog ships on the next successful
attach and the plane-side hold keeps anything already written safe; every
other 4xxx refusal stays terminal, pinned by a table test. (`4004 "subshell
not running"` rides the same code; retrying it is harmless and lets an open
page catch an owner's restart.)

**The page must survive the retry (review, 2026-09-22).** The consumer half
was the wedge's last door: the terminal set `closed` on ANY 4xxx close, which
unmounts the terminal, which cancels the hook — so the 4004 retry never ran
on the page that needed it, and the user stared at "Subshell is not running"
while the node was merely offline. The table now lives in one place
(`statusAfterClose`): a retryable close arrives as connected:false /
closed:false and the page's "reconnecting…" pill covers the gap; the retried
attach's `onOpen` arrives CLEAN (connected:true, closed:false — carrying the
previous close's flag forward was what kept the dead panel up). A refusal a
retry cannot fix still lands on the dead panel.

**"Not found" is not transient (review, 2026-09-22).** With 4004 retryable,
its "subshell not found" spelling — a PERMANENT refusal — would be retried
forever at ≤15 s. It moved to its own close code, **4005**
(`attach-resolve.ts`), wire-ADDITIVE: every client older than this split
treats any non-retryable 4xxx as terminal and never retried 4004 either, so
the move changes nothing for a cached PWA. 4004 keeps the transient family —
node offline, subshell not running, subshell unreachable — and the client
retries exactly 4004.

**The local leg is still open.** Wave D closed the plane→node leg only. A
transient LOCAL write failure (the send-keys spawn fails while the pane and
the browser socket are both fine) wedges the client queue the same way — no
ack, no dedupe commit, later keystrokes coalesce behind the unacked head —
and holds are deliberately not taken for `local`: there is no node-ready
moment to re-fire from. Until a wave covers it, a browser reconnect (the
socket dying, a page reload) is the recovery; the client's reconnect re-send
carries what was stranded.

**Premise amendment.** Wave A's "TCP ordering means an unacked frame is 'not
yet', never 'lost'" holds ONLY for the browser↔plane leg, the one leg TCP
actually spans there. The plane→node leg fails independently — this wave
closes it: the plane holds what the node could not take, and the client
retries the attach the node would not grant.

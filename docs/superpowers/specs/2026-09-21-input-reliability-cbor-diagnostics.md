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

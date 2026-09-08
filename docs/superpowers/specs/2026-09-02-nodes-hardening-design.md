# Nodes Hardening — liveness semantics + open-question closures (Design 2026-09-02)

**Parent:** `docs/superpowers/specs/2026-08-31-nodes-design.md` §12 (Risks & Open
Questions) + the Phase-3 review residuals in `.git/sdd/progress.md`. The product
owner delegated the policy calls ("do what you think is best"); each ruling is
marked **RULING** and reflected in §12's wording via errata.

## 1. The bug: transient probe failure reports live panes dead

The shared exit watcher (`apps/agent/src/commands/report.ts`) learns liveness
from `TmuxRunner.listSessionNames(socket)`, which **swallows every failure
into `[]`** — a pane missing from a *failed* probe is indistinguishable, in
that API, from a pane missing from a *successful* one. One fork failure,
EINTR, or overloaded-server hiccup during a 2 s tick therefore reports a
`exit{code:null}` for a live pane (the backend marks the session crashed/exited).

Reality check (verified on tmux 3.x): under the per-session-socket model, a
dying session takes its server with it ("error connecting" rc=1), so `[]`-via-error
is *usually* genuine death. The false positives are the client-side blips
(spawn error, signal, hang-then-kill), and they are the ones worth absorbing.

**RULING — consecutive-unreachable threshold, not failure-classification.**
Distinguishing "server gone" from "probe blip" from one CLI call is
impossible (both are rc=1, only stderr differs); a threshold is honest about
that. Semantics:

- New probe on `TmuxRunner`: `listSessionsChecked(socket):
  { ok: true; names: string[] } | { ok: false; detail: string }` —
  `ok:false` on spawn failure, signal, or non-zero exit. `listSessionNames`
  stays as-is (census keeps its documented fail-closed posture, §3).
- `WatcherRegistration` gains a mutable `unreachable: number` (fresh
  registration ⇒ fresh counter — a relaunch resets the budget, consistent
  with the token-identity design).
- Tick, per socket:
  - `ok:true` — authoritative. Absent pane ⇒ **confirmed dead, reported
    immediately** (today's path, unchanged), and `unreachable` is moot.
  - `ok:false` — increment `unreachable` for every entry on that socket.
    Below the threshold ⇒ skip silently (leave watched). At/over the
    threshold ⇒ report death exactly like the confirmed path (`paneExitCode`
    will read null — the same shape the old immediate-report produced for a
    dead server).
- Threshold: **2 consecutive** `NODE_EXIT_UNREACHABLE_TICKS = 2` (≈4 s at the
  2 s cadence). Cost of a blip: none. Cost of real death: +2 s. Sustained
  tmux breakage still converges — no zombie rows.
- Once reported, the registration is dropped (stop-first rule preserved), so
  at most one exit event per registration in either path.

## 2. §12 open questions — closures

- **#3 offline > N days → mark crashed: DECLINE (for now).** Re-verified the
  census shape: adopted sessions are probed once at connect; a crashed-marking
  sweep would fight a node that returns with live panes (the census exists
  precisely to re-adopt), and today's `nodeOffline` view copy is already
  honest ("node unreachable" — the row's truth is *unknown*, not *crashed*).
  Recorded as considered-and-declined; revisit only if long-dead rows
  accumulate in practice.
- **#4 refuse launches below a semver floor: NO.** The protocol int is the
  compatibility contract and is already enforced at connection (`4406`); a
  per-launch agentVersion floor would re-gate what the socket gate settled
  and add a failure mode without a safety gain. Warning-only stays.
- **#6 per-event signing: DEFER unchanged.** Blast radius is self-node
  metadata; no demand signal yet.
- **#2 signing-key rotation with grace: DEFER as its own future phase.**
  The rotation bootstrap (delivering the new control public key to enrolled
  agents) needs a dual-key keychain in the agent + a protocol addition — a
  feature, not a hardening, and wrong to rush on a crypto path.
- **Mobile parity (FOLLOWUP-22 ticket): IMPLEMENT.** Gate the waiting-chip /
  border / dot on `nodeOffline` exactly like web already does — a session on
  an unreachable node must not advertise "waiting for you" on the phone.
  Small, testable, pure consistency.

## 3. Explicit non-goals

- Census (`sessions_report`) semantics: unchanged fail-closed one-shot at
  connect (its false-positive window is one probe wide, it converges via the
  watcher thereafter, and fail-open there invites zombies for adopted panes).
- Backend session-state machine, offline sweep, mobile UI beyond the chip
  gating above, MCP-in-pane live verification (needs a human harness login).

## 4. Testing & verification

- T1 (threshold): unit tests in the watcher suite — blip-then-alive ⇒ zero
  exit events; 2×-unreachable ⇒ exactly one exit(null); confirmed-absent ⇒
  immediate exit as today; counter reset across a success between blips;
  relaunch resets the budget (token shape already pins identity).
  Plus `listSessionsChecked` unit tests in the harnesses suite (ok/error shapes).
- T2 (mobile): pin the nodeOffline gating in the existing mobile test pattern.
- Root trio per task; the full e2e suite is the phase gate (12-nodes covers
  the remote exit-report path end-to-end: terminate still flips `ended`
  through the RPC result, not the watcher, so the threshold cannot mask it).

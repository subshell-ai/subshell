# Dashboard live updates: one socket, and events instead of a timer

**Date:** 2026-09-19
**Status:** design
**Supersedes:** the `/api/events` SSE feed (spec 2026-09-03 sidebar-quickadd §6)

## 1. What this is for

The dashboard learns about change by asking, on timers. The subshell list
arrives over an SSE stream whose server end re-lists and re-captures every
1.5 s; six other surfaces poll on their own intervals. This replaces the
asking with telling: one WebSocket per tab, carrying a snapshot at connect
and domain events after it.

Three measured problems motivate it. They are stated here because two of them
are already fixed and the third is the reason the rest of the work is worth
doing.

**The HTTP/1.1 socket.** A browser allows six connections per origin over
HTTP/1.1, shared across every tab of that origin in the profile. The instance
is served over plain http, so there is no HTTP/2 and the cap applies.
`EventSource` holds one of those six **permanently, per tab**. Three dashboard
tabs and half the pool is gone before any fetch; six tabs and every request
queues behind streams that never end. This is a hard ceiling, and nothing
short of removing the SSE stream moves it.

**Duplicate work per tab.** Fixed in the triage wave that precedes this spec
(`perf/feed-triage`): the subshell page's 5 s liveness poll no longer
invalidates the list while the feed is delivering, quiet frames keep their row
references so a pane re-renders zero times between real changes, and local
previews are deduped through a short-TTL cache.

**A cadence that buys almost nothing.** Measured on the development host:
`alive`, `startedAt`, the auto-title `name` and local `lastOutputAt` are
written by exactly one thing — the **60 s** reconcile sweep
(`apps/server/api/src/index.ts:306`,
`services/subshell-manager.service.ts:1188-1225`). Everything else on a
subshell row changes only on an explicit user action. The 1.5 s feed therefore
pushes 40 frames a minute to deliver facts that move at most once a minute,
plus one thing that genuinely moves: the tmux screen preview. Previews are
rendered on exactly one surface, the home page's cards.

### Non-goals

**Terminal multiplexing is out of scope**, and is rejected rather than
deferred. The argument for putting pane attaches on the shared socket was
connection count, and the numbers do not support it: Chrome allows ~255
WebSockets per host and Firefox ~200, while the binding limit is the six
HTTP/1.1 connections that terminals do not occupy. The cost would be viewer
identity in `ws/viewers.ts`, the shared-grid sizing policy, `pane-geometry`,
`pane-repaint`, the remote relay, attach forensics, and the mobile app's
second implementation of the attach protocol — in exchange for head-of-line
blocking between panes, which is a new input-lag mechanism replacing one that
does not exist.

**Admin polls stay polls.** `useServerDeployment` spawns `netstat` and the
service manager; `useServerLogs` tails a file at 1 s. Both are admin-only,
page-scoped, and ask the operating system rather than the domain. An event bus
has nothing to say about either. They are named here so they do not read as
forgotten.

## 2. Shape

```
                    ┌─────────────────────────────────────────┐
  mutation routes ──┤                                         │
  reconcile sweep ──┤   live-bus  (in-process EventEmitter)    │
  death reporter  ──┤   subshell.* / node.*  — ids + change    │
  node ws handler ──┤                                         │
                    └───────────────────┬─────────────────────┘
                                        │  (id, change)
                    ┌───────────────────▼─────────────────────┐
                    │  /ws/live  — one socket per browser tab  │
                    │  · snapshot at connect                   │
                    │  · per-subscriber visibility resolution  │
                    │  · event frames after                    │
                    └───────────────────┬─────────────────────┘
                                        │
                    ┌───────────────────▼─────────────────────┐
                    │  LiveFeedProvider (__root.tsx)           │
                    │  writes SUBSHELLS_QUERY_KEY + node keys  │
                    └─────────────────────────────────────────┘
```

Four units, each testable alone:

| unit | does | depends on |
|---|---|---|
| `services/live-bus.ts` | typed in-process emitter; publish + subscribe | nothing |
| `ws/live-ws.ts` | one socket: auth, snapshot, visibility, frames | live-bus, subshells service |
| pane death reporting | `remain-on-exit` + hook + `report-exit` verb | ReporterSpec, tmux-runner |
| `hooks/use-live-feed.tsx` | client transport + cache writes | query client |

## 3. B1 — the transport

### 3.1 The endpoint

`/ws/live`, registered in `ws/ws.plugin.ts` beside `/ws` and `/ws/node`.

Auth is unchanged from the SSE path: the browser cannot send the HttpOnly
cookie on a WS upgrade through the Vite dev proxy, so the client first calls
`POST /api/auth/ws-token` and passes the single-use, 30 s token as a query
param. `consumeWsToken` checks the TTL once at connect and deletes the token;
nothing expires a live stream afterwards (verified — the SSE route's comment
claiming a ~30 s reconnect is wrong, and that comment dies with the route).

### 3.2 Frames

Server → client:

```ts
type LiveFrame =
  | { type: "snapshot"; subshells: SubshellView[]; nodes: NodeView[] }
  | { type: "subshell"; id: string; row: SubshellView }   // created or changed
  | { type: "subshell-gone"; id: string }                 // deleted, or no longer visible
  | { type: "node"; id: string; row: NodeView }
  | { type: "preview"; id: string; lines: string[] };
```

**Step 1 ships `subshells` only.** The `nodes` half arrives with the events
that make it worth carrying — a transport swap that also widened the payload
would have made the parity claim below untestable. It is a staging decision,
not a trimmed requirement.

Client → server:

```ts
type LiveClientFrame =
  | { type: "watch-previews"; ids: string[] }   // the home page, on mount/unmount
  | { type: "refresh-preview"; id: string };    // manual refresh
```

**The snapshot is the resync primitive.** On connect, and on every reconnect,
the server sends one snapshot and the client replaces the cache wholesale.
There is no event replay, no sequence number and no gap to reason about: a
dropped socket costs one snapshot. This is affordable only because snapshots
no longer carry previews — which is what makes §4.4 a precondition for this
section rather than an independent choice.

The frame union above is declared on the server today and mirrored loosely on
the client, which is honest while `snapshot` is the only kind. **Step 2 should
lift `LiveFrame` into a shared type** the way the attach path shares
`ServerFrame` through `@internal/subshell-protocol` — four kinds mirrored by
hand is how the two ends come to disagree about an optional field.

`subshell-gone` covers deletion **and** revocation of a share. A viewer who
loses access must see the row disappear, and must not be able to tell those
two cases apart — the same reason per-subshell routes answer 404 rather than
403 for an invisible id.

### 3.3 What is deleted

`api/live.route.ts` and its registration. Not kept alongside: two live paths
writing one query key is how the admin-vs-owner list divergence of 2026-09-03
happened.

## 4. B2 — events instead of a timer

### 4.1 The bus

`services/live-bus.ts`, a typed `EventEmitter` in the shape of the existing
`services/channels/post-bus.ts` — the only other one in the API.

It carries **identity and the kind of change, never a rendered view**:

```ts
type LiveEvent =
  | { kind: "subshell.changed"; id: string }
  | { kind: "subshell.deleted"; id: string; ownerId: string }
  | { kind: "node.changed"; id: string };
```

A publisher says "this id changed"; the socket decides what that means for
each viewer. Publishing a rendered row instead would force every publisher to
know the viewer set, which is the mistake that makes an authorization bug
possible.

Publishers: the subshell mutation paths (create, terminate, restart, rename,
share, maintenance), the reconcile sweep for what it still discovers, the node
WS handler for online/offline, and the death reporter in §4.3.

### 4.2 Visibility is resolved per subscriber, and never re-implemented

**This is the rule the review should check hardest.** On each event, a
subscriber resolves the row through the *same* path
`GET /api/subshells` uses — `SubshellsService.listSubshells` /
`loadSubshellAccess` — never a second predicate written for the socket.

The 2026-09-03 live report is the precedent: the SSE feed was backed by the
owner-only `SubshellManagerService.listSubshells` while REST answered
sharing-aware, and an admin's rows flickered in and out. A second policy path
here does not merely flicker; it discloses a private subshell.

Concretely: an event carrying id `X` causes the socket to load `X` for that
viewer with the ordinary gate. Visible → `subshell` frame. Not visible →
`subshell-gone`, unconditionally.

Sending `subshell-gone` for an id the client never held is deliberate: the
alternative is per-connection bookkeeping of which ids each socket has been
told about, which is state to keep correct across reconnects for no benefit.
The client drops a `gone` for an id it does not have. That also keeps the
frame free of information — it says "you cannot see this", which is true
whether the row was deleted, unshared, or never visible.

**Who may open the socket at all** is inherited rather than newly decided:
`POST /api/auth/ws-token` is cookie-only (`actor !== "cookie"` → 403), so a
bearer credential — a subshell's own key included — cannot mint a token and
therefore cannot reach `/ws/live`. The socket adds no gate of its own here;
it must simply not grow one that is weaker.

### 4.3 Death becomes an event

Today death is discovered by the 60 s sweep noticing the tmux session is gone.
With previews no longer animating, that staleness is the most visible thing on
the page.

**Measured on this host, with real tmux:**

- A subshell session is created as `new-session -d -s <name> -c <cwd> <cmd>`
  with no `remain-on-exit` and no `set-option` anywhere in the tree. When the
  harness exits, tmux destroys the window, the session, and — since there is
  one tmux server per subshell — the server itself.
- Consequently `paneExitCode`'s read of `#{pane_dead}:#{pane_dead_status}`
  answers `no server running` and returns null. **`exitCode` is structurally
  always null in production**, and the "preserve a clean exit (code 0)" branch
  is dead code.
- With `remain-on-exit on`, the pane survives as dead: `pane_dead:pane_dead_status`
  reads `1:3` for a command exiting 3, and a `pane-died` hook fires with the
  tmux server still alive to run it.

The mechanism is therefore: set `remain-on-exit on` at session creation, and
register a `pane-died` hook that invokes the **existing `ReporterSpec`
prefix** — the blessed way a pane re-enters the subshell binary on its own
machine, already used for harness hooks, and the reason this works identically
on a node (the reporter re-enters the *node's* binary, which forwards over
`/ws/node`; node protocol bump).

```
subshell report-exit <subshell-id> <status>
```

Two consequences that must land in the same change, because each fails quietly
on its own:

1. **The sweep's death test must change.** "Session gone ⇒ dead" becomes
   "`pane_dead` ⇒ dead". Left alone, a dead-but-lingering pane reads as alive
   forever and the sweep never records the death it exists to catch.
2. **`#applyDeath` must kill the tmux server.** Without it, one idle tmux
   server accumulates per dead subshell for as long as the row is kept.

The sweep remains as the backstop — a hook can be missed (a `SIGKILL` of the
tmux server, a machine that lost power). It is no longer the primary path.

**The bug this fixes for free:** `exitCode` starts carrying real values, so
the dead-pane UI can say *how* a harness exited rather than only that it did.

### 4.4 Previews on demand

No cadence anywhere. The home page sends `watch-previews` with the ids of the
cards it is showing; the server captures those once and answers with `preview`
frames, then refreshes a preview only when that subshell emits a
`subshell.changed` event, or on an explicit `refresh-preview`. Unmounting the
page clears the watch.

The preview cache from the triage wave stays as the dedup for the load burst
(N cards asking at once, N tabs asking at once).

Accepted cost, chosen deliberately: a card's screen can be stale on a busy
agent. Cards become a picture of the subshell as of the last thing that
happened to it, not a live window. The live window is the terminal.

### 4.5 Activity moves to the client

`computeActivity` is `now - lastOutputAt <= 60_000`, evaluated server-side at
read time. With nothing pushing on a timer, a subshell that goes quiet would
stay "active" until something else happened to it.

The client derives activity from `lastOutputAt` against a ticking clock —
`hooks/use-clock-tick.ts`, a hook whose only job is to re-render its caller on
an interval and stop on unmount. One tick per surface that renders activity,
not one per row.

The server keeps `computeActivity` for the REST payload: API consumers are not
all browsers, and a field that only means something after client-side
arithmetic is a worse contract.

### 4.6 Polls that fold in

- `useWorkspace`'s 5 s — panes notice their subshells exiting via
  `subshell.changed` instead.
- `useSubshellData`'s per-id 5 s interval and its list invalidation — both go;
  the row arrives as an event.

## 5. Error handling

| failure | behavior |
|---|---|
| socket drops | client reconnects with bounded backoff, gets a fresh snapshot; cache replaced wholesale |
| ws-token fetch fails | retry on the same backoff; the REST list stays the fallback, exactly as today |
| bus publisher throws | never propagates to the mutation that published; logged and dropped |
| a subscriber's visibility resolve throws | that subscriber misses that event; the next snapshot corrects it |
| `report-exit` never arrives | the 60 s sweep still finds it — the backstop is why the sweep stays |
| `report-exit` for an unknown/foreign id | rejected; the verb authenticates as the subshell's own token, the same rule as the other harness self-report surfaces |
| node below the new protocol | no hook is installed there; that node's deaths are sweep-discovered, as today |

### 5.1 The idle timeout is a step-4 problem, and it is load-bearing there

Bun closes a WebSocket after **120 s** with no messages or pings
(`bun-types/serve.d.ts:452`). Measured: server-initiated sends reset it, so
step 1 is safe — the 1.5 s snapshot cadence keeps every socket alive without
anything being added.

**Step 4 removes that cadence**, and `/ws/live` receives nothing from the
client, so on a quiet instance every socket would close at 120 s and every
client would resync on a two-minute sawtooth forever — which reads as a
flapping connection rather than as a timeout. Whichever step removes the last
unconditional send must add the keepalive in the same change: either an
application-level ping or an explicit `idleTimeout`. Decide it there, not by
discovering it.

## 6. Testing

- **live-bus:** publish/subscribe, unsubscribe on close, a throwing subscriber
  not taking down the publisher.
- **visibility (the load-bearing one):** an event for a subshell the viewer
  cannot see produces `subshell-gone` and never a row; a revoked share
  produces `subshell-gone`; an admin sees instance-wide; the token mint stays
  cookie-only, so a bearer credential cannot open the socket.
- **snapshot/reconnect:** a reconnect replaces the cache; a row deleted while
  the socket was down is absent after resync.
- **death:** `remain-on-exit` set at creation; the sweep reads `pane_dead`
  rather than session presence; `#applyDeath` kills the server; `exitCode`
  carries the real status. The compiled hook path belongs in `test:cli`, which
  is the only thing that exercises the reporter as an operator's machine runs
  it.
- **client:** `use-clock-tick` re-renders and stops on unmount; activity flips
  active→idle with no server frame; panes do not re-render on an unrelated
  event.

## 7. Order of work

1. `live-bus` + `/ws/live` carrying snapshot only; client switched over; SSE
   route deleted. *(B1 — the socket win lands here, standalone.)*
2. Events published from the existing mutation paths and the sweep;
   `useWorkspace` and `useSubshellData` polls removed.
3. Previews on demand (`watch-previews`), activity client-side +
   `use-clock-tick`.
4. `remain-on-exit`, the `pane-died` hook, `report-exit`, the sweep's death
   test, `#applyDeath` server kill. *(The riskiest step, deliberately last and
   alone.)*
5. Node half: protocol bump, agent-side hook and forwarding.

Step 1 is shippable on its own and delivers the measured HTTP/1.1 win. Step 4
is the one that can break quietly and should be reviewed as its own change.

# Design: in-place session restart + server-offline state

Date: 2026-08-31
Status: approved by operator in brainstorm (A1 + C1, resume-always, clone semantics replaced entirely)

## Problem

1. **Restart clones instead of reviving.** `POST /api/sessions/:id/restart` creates a
   *new* row (`"name (2)"`, new id, new tmux socket) and leaves the old row terminated.
   The id change leaks everywhere: the frontend navigates to the fresh id, the mobile
   transport documents "id changes on restart" and converges stale ids on 404/410, and
   the session's E2EE channel identity (`sess:<id>`, whose keypair file is keyed by
   principal) does not survive — the clone silently loses channel roster membership and
   access to its own sealed history. Meanwhile the *auto*-restart path
   (`maybeAutoRestart`, `session-manager.service.ts:532`) already revives the same row
   with full race protection, so two restart semantics exist for one concept.

2. **A temporarily-down mote server looks like deleted data.** When `fetch` rejects
   (server/proxy down), TanStack Query retries once (`query-client.ts`, `retry: 1`,
   `refetchOnWindowFocus: false`) and parks in an error state. Concretely: the
   workspace page renders **"Workspace not found — the workspace may have been
   deleted"** on a first load during an outage (`workspaces_.$id.tsx:46`), and the
   sessions list shows a dead "Couldn't load sessions. / Try again" banner that never
   clears itself even after the server is back (`index.tsx:104`). Only the session-WS
   pill and the SSE `LiveStatus` know how to reconnect; every REST surface does not.

## Goals

- One restart semantic: same row, same id, same name — everywhere (web, MCP tool,
  mobile), for live and dead sessions alike.
- Restart always continues the harness conversation (`--resume`) when its transcript
  survived; the new process is the only thing that changes.
- Transient server downtime reads as *reconnecting*, never as *not found*, and heals
  itself without user action when the server returns.

## Non-goals

- A "duplicate / start a second session from this one" action (operator chose to
  replace clone semantics entirely; "New session" with the same profile + dir covers it).
- A central health-probe / polling endpoint for reachability.
- Protecting the restart record against in-place mutation beyond what the audit log
  already keeps (`session.restart` events remain).
- Changes to the SSE/WS reconnect logic — they already behave.

## Backend design

### `reviveRow` — shared revival core (new private method, `SessionManagerService`)

Extracted from `maybeAutoRestart`'s body (the token/MCP/spawn/revive sequence, today
lines ~565–635). It owns, in order:

1. `#revokeTokenOrUnlink(row.id)` → `#tokens.issue(row.id, row.userId)` →
   `registerSessionMcp(harness, row.id)` — the key rotates on the same row; the
   guard's link check 401s the orphaned old key even if revoke fails.
2. `#planHarnessSession(harness, row.harnessSessionId, realPath)` — `"resume"` when
   the stored transcript survives, else re-allocate (`"start"`).
3. `buildHarnessCommand(...)` with the same curated env as every launch.
4. Pre-spawn fresh `findById` re-read (terminate-in-flight must not bake a pane).
5. `tmux.newSession(socket, row.id, cwd, cmd)`, socket = `row.tmuxSocket ?? tmuxSocketFor(row.id)`.
6. **Conditional revival** via `updateIfRunning` (WHERE `status = 'running'`):
   `alive: 1`, `exitCode: null`, `endedAt: null`, `startedAt: now`,
   `nextRestartAt: null`, `harnessSessionId` when re-pinned, and `backoffCount` from
   the caller. On 0 affected rows: kill the orphan pane, revoke the just-issued
   token, return false.
7. Best-effort `pipe-pane` re-arm onto `sessionLogPath(row.id)`.

What stays at the **auto** call site (`maybeAutoRestart`): the `restartOnExit`/
backoff-due/limit gates, the `harnessUsable` defer-check (a disabled harness parks
the row for the next tick), the up-front `nextRestartAt` scheduling, `backoffCount +
1`, and the crash-branch logging. Auto-restart behavior must be bit-identical after
extraction; its existing tests are the regression proof.

### `restartSession(userId, sourceId)` — rewritten

1. `findById` + owner check → `null` ⇒ route 404 (unchanged shape and code).
2. **In-flight dedupe**: a `Map<id, Promise>` in the manager; a concurrent second
   restart for the same row *joins* the first promise instead of double-killing and
   double-spawning. Entry removed when settled.
3. If `row.alive === 1` and tmux has the session: `killSession` (no revoke here —
   step 4's core rotates).
4. Flip the row: `status: "running"`, `alive: 0`, `exitCode: null`, `endedAt: null`.
   The row now sits in exactly the parked state `maybeAutoRestart` revives from, so
   every guard above applies verbatim. A WS attach during the gap hits the existing
   `4004 "session not running"` rejection (`ws/session-ws.ts:59`) — the frontend
   handles that in §Frontend.
5. `reviveRow` with `backoffCount: 0` (operator intent resets the auto-restart
   ladder). Spawn failure surfaces as an error response (as `createSession` does
   today for a missing binary); the row stays parked, visible, and restartable.
6. Audit `session.restart`, `targetId` = same id, metadata `{ name }`.
7. Return `{ id, tmuxSocket, promptDelivered: false }` — response schema unchanged
   (`CreateSessionResponseSchema`); no prompt is typed on restart (matches auto).

The harness-disabled quirk is preserved as documented today
(`sessions.service.ts:208-213`): the manual path does **not** run the `harnessUsable`
gate (that lives on the auto call site only); a missing *binary* still fails like
`createSession` does.

Name is never rewritten — the `" (2)"` suffix logic is deleted with the clone path.

### Accepted race (documented, not solved)

Between steps 3–5 the row is `running/alive:0` with no pane for a sub-second window.
The reconcile sweep (interval ≫ window) could observe it and fire a spurious death
push for a notify-opted row, or — for a `restartOnExit` row — race `maybeAutoRestart`
against the in-flight revival. Both already exist today for the auto path's own
parked window; the guards (`nextRestartAt` pre-arm on auto, conditional revival on
both, pre-spawn re-read) bound the outcome to at most one surviving pane. Comment
this at the flip site.

## Contract & doc updates

- Route description + JSDoc for `POST /:id/restart`: "revive this session in place
  (same id): new process, same row, conversation resumed when its transcript
  survived". Rebuild `turbo build` after the route edit so `@internal/backend-client`
  re-infers (types are unchanged; the rule still applies).
- `.claude/rules/security-context.md`: "auto-restart rotates the key" → "restart
  rotates the key — auto and manual alike, same row".
- Mobile `src/types/session.ts:25` and `src/lib/api-error.ts:72-73`: drop the "id
  changes on restart" claims. `isAlreadyGone` convergence stays valid (sessions still
  die by terminate/delete) but restart is no longer one of the ways.
- e2e suite: `grep` shows no restart assertions today — confirm during implementation.
- Backend `AGENTS.md` needs no change (it does not describe restart semantics).

## Frontend design — restart UX

- `useSessionMutations`: delete the `onRestarted` callback (interface + JSDoc + both
  call sites). `SessionActionsMenu` drops its `onRestarted` forwarding; the detail
  page stops navigating to a new id. `refresh()` (invalidate SESSIONS + SESSION
  queries) stays as the whole sync story.
- `sessions_.$id.tsx`: `restartNonce` state bumped on restart success (the mutation's
  `onSuccess` hook point); `SessionTerminal` keyed `` `${id}:${restartNonce}` ``.
  Rationale: with the id unchanged, an un-keyed component keeps its
  attach-rejection (`closed`) state and the exited panel never gives way to the live
  terminal; the remount resets both. The restart request returns *after* the pane
  spawns, so the fresh hook attaches to a live pane, and the 4004 mid-gap race can no
  longer strand the UI because the remount clears `closed`.
- Update the stale comments at the `key={id}` site and in `use-session-mutations`
  ("Restarts as a new row…", "restart follows the user to the fresh session").

## Frontend design — offline/reconnecting layer

1. **`NetworkError`** in `src/lib/api.ts`: wrap only the `fetch()` rejection —
   `try { res = await fetch(...) } catch (err) { throw new NetworkError(...) }`;
   anything with an HTTP response keeps throwing `ApiError`. Export
   `isNetworkError(err): boolean`. A rejected `fetch` means exactly "no HTTP answer":
   DNS failure, refused connection, dropped socket — server or proxy down.
2. **Retry policy** in `src/lib/query-client.ts`:
   `retry: (failureCount, err) => (isNetworkError(err) ? failureCount < 60 : failureCount < 1)`
   (booleans — v5's callback contract), with
   `retryDelay: (attempt, err) => isNetworkError(err) ? Math.min(1000 * 2 ** attempt, 15_000) : 0`
   — HTTP errors keep today's fast failure. ~60 attempts ≈ a 15-minute outage
   self-heals on recovery.
   Mutations keep default (no retry): a lifecycle click into the void errors visibly
   and the user re-clicks once the banner clears.
3. **`src/lib/server-status.ts`** (~40 lines, framework-free): subscribes to the
   shared `QueryCache` (`onUpdate`) and computes
   `offline = any ACTIVE query in error state with isNetworkError(state.error)`.
   Exposes `subscribe`/`getSnapshot` for `useSyncExternalStore`. It derives — never
   polls: the retry loop from (2) is the probe; when one succeeds the query leaves
   error state, the cache event fires, the banner clears. Scoping to active queries
   keeps unmounted stale errors from pinning the banner.
4. **Banner**: `__root.tsx`, inside `QueryClientProvider`, hidden on the `/login`
   and `/setup` paths (match the router's current path — those screens own their
   own error UX and a down server there is not a transient blip): fixed-top
   `<StatusPill tone="warning">Can't reach the mote server — retrying…</StatusPill>`.
   No new primitives; same vocabulary as `LiveStatus`' "Reconnecting…".
5. **Truth fixes** where downtime currently lies:
   - `workspaces_.$id.tsx`: "Workspace not found" renders **only** when the query
     error is `ApiError && status === 404`. Network errors (and 401/5xx first-load
     failures) keep the neutral loading state — the retries in (2) heal it.
   - `index.tsx`: list error copy → "Couldn't load sessions — retrying…"; the manual
     "Try again" button stays but is no longer the only exit.
   - Session detail: no change — during downtime `session` stays `undefined`, so
     `dead` is false, the existing pill shows, and the global banner tells the rest.

## Testing

- **Backend `bun test`** (`session-manager.service.test.ts` + route tests):
  - reworked `restartSession` suite: same id + unchanged name; row flips
    terminated→running with `exitCode/endedAt` cleared; `backoffCount` reset to 0;
    live source is killed before respawn; token revoked then re-issued and re-linked
    to the same row; resume planning inherited (resume when transcript survives,
    re-pin otherwise); foreign userId → null, missing → null; concurrent double
    restart → one revival, joined promise.
  - **`maybeAutoRestart` tests pass unchanged** — the extraction's regression proof.
- **Frontend `bun test`**:
  - `isNetworkError` classification (fetch reject vs `ApiError` of any status);
  - the retry policy as a pure function (network → >1 attempts, HTTP → exactly 1);
  - `server-status` transitions via a real `QueryClient` + fake fetch: offline on
    active-query network error, online on recovery, unmounted errors ignored;
  - workspace not-found gating: 404 ⇒ card, NetworkError ⇒ neutral (component test
    or extracted predicate, whichever the file's shape allows).
- **Verification**: `bun run verify-types && bun run lint:check && bun run test`
  (repo rule), plus `turbo build` after the route edit.
- **Manual probe** (in the implementation plan, not automated): with a session page
  open, stop the backend → banner + "reconnecting…" pill appear and the workspace
  page never claims "not found"; bring it back → terminal reattaches, banner clears;
  click Restart on a live session → same URL/id before and after, pane reattaches,
  harness conversation continues.

## Risks / trade-offs

- **History mutates in place.** The row's `startedAt` moves, `exitCode/endedAt` clear;
  the only surviving record of the previous run is the `session.terminate`/
  `session.restart` audit trail. Accepted deliberately (operator's call: restart
  should be the existing session).
- **Revoked-key window.** Between revoke and issue the row has no live key — same
  window the auto path already runs; the guard's link check makes it fail-closed.
- **`retry: ~60` masks nothing that the banner doesn't show** — network errors are
  now visible globally instead of per-page, which is the point.

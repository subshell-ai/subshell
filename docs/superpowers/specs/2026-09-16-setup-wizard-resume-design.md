# Resuming the first-run wizard

**Date:** 2026-09-16
**Status:** approved, ready to build
**Amends:** `2026-09-15-headless-setup-design.md` (the wizard's steps)

## 1. The defect

An operator closed Subshell Server while the wizard was on its Network step
and reopened it. The app put them on the dashboard. They expected to be
back where they left off.

The wizard's current step lives only in React state. The one persisted fact
is "does any account exist" (`GET /api/setup/status` → `needsSetup`), and
the account is created on the FIRST step, so from that moment the server
reports setup as done. Every later step — Network, Agent, Launch — has no
record anywhere, and the wizard's own effect bounces a visitor to `/` the
moment `needsSetup` reads false. Reopening the app is exactly that visitor.

## 2. The design

### 2.1 A per-user bookmark

`user_meta` gains a nullable text column `setup_step`, holding one of
`network`, `agent`, `launch`, or NULL. It is a bookmark, not a gate: nothing
about what a person may do depends on it, and the security posture is
unchanged.

It is per-user because the wizard is the first admin's and nobody else's:
users created later, by an admin or by sign-up while registrations are open,
land on the dashboard as they do today.

### 2.2 Written first by the sign-up hook

`promoteFirstUserAtomically` (`apps/server/api/src/auth.ts`) already decides
"is this the first user" inside one INSERT. The same statement now sets
`setup_step` to `'network'` for that first user and NULL for every other:

```sql
INSERT INTO user_meta (user_id, role, setup_step)
SELECT ?,
       CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta) THEN 'admin' ELSE 'user' END,
       CASE WHEN NOT EXISTS (SELECT 1 FROM user_meta) THEN 'network' ELSE NULL END
ON CONFLICT (user_id) DO NOTHING
```

So closing the app the instant the account exists still resumes on Network.
The wizard never has to race the hook to write the first bookmark.

### 2.3 Advanced and cleared by the wizard

Two routes in `apps/server/api/src/api/setup.route.ts`, both cookie-only:

- `GET /api/setup/progress` → `{ step: SetupStep | null }` — the caller's
  own bookmark.
- `PATCH /api/setup/progress` body `{ step: SetupStep | null }` → the same
  shape — writes the caller's own row. NULL clears.

Gate: `resolveSetupActor(request)` must answer `cookie` or `admin`;
`machine` is 403. There is no no-users carve-out — a bookmark presupposes a
user. A `step` outside the enum is a 400 from the schema, and a row whose
stored value is not in the enum reads as NULL (fail safe; nothing acts on it
but a redirect).

The wizard writes through as it moves:

| act | writes |
|---|---|
| Network → Continue or Skip | `agent` |
| Agent → Continue | `launch` |
| Back (Agent → Network) | `network` |
| Back (Launch → Agent) | `agent` |
| Launch, or Skip on the last step (`finish`) | `null` |

Fire-and-forget with an optimistic cache update: a failed write costs a
resume at the previous step, which is the harmless direction.

### 2.4 Read by the shell, honoured by the wizard

**Root shell** (`routes/__root.tsx`): a signed-in user's bookmark is fetched
once (`staleTime: Infinity`, key `["setup-progress"]`, enabled when a user
exists). `shellGate` gains two inputs, `progressLoading` and `resumeSetup`,
and two rules, in this order after the existing `isLoading` rule:

- `hasUser && progressLoading` → `"blank"` (hold first paint, as the
  no-users check already does for signed-out visitors).
- `hasUser && resumeSetup && pathname !== "/setup"` → `"toSetup"`.

The redirect element already exists (`NAVIGATE_TO_SETUP`). No sidebar
mounts on `/setup`, so a person mid-wizard cannot wander off it by clicking;
a typed URL bounces back, which is the point.

**Wizard** (`routes/setup.tsx`):

- Initial step comes from the bookmark: `network` → 1, `agent` → 2,
  `launch` → 3, absent → 0. Read from the same query (cached by the root
  hold), with an effect that applies a bookmark arriving later only while
  `step === 0` and nothing has been typed — belt and braces for a direct
  load of `/setup`.
- The bounce effect becomes: `needsSetup === false && step === 0 &&
  !resumeSetup && !launchedRef.current` → `/`. A visitor, and only a
  visitor. Today it relies on `setup-status` being stale for ten seconds
  after registration; the `step === 0` guard makes that timing irrelevant.
- `completeSetup()` also writes `null` through the mutation.
- The dot row (`NATIVE_STEPS` + `STEPS`) is unchanged: it renders the
  current step, wherever the wizard opened.

### 2.5 Types

`apps/server/api/src/db/types/setup-step.ts`: `SetupStep` union and
`SETUP_STEPS` runtime array, per code-style. `UserMetaTable.setupStep:
Generated<string | null>`; `NewUserMeta` omits it. The web's `types/` gets
the same union (restated, as `NetworkState` is).

## 3. Files

- `apps/server/api/src/db/migrations/0032-setup-step.ts` + the map entry in
  `db/migrate.ts` (both, or boot never runs it).
- `db/types/user-meta.db-types.ts`, `db/types/setup-step.ts`.
- `db/repositories/user-meta.repository.ts`: `getSetupStep(userId)`,
  `setSetupStep(userId, step | null)`.
- `auth.ts`: `promoteFirstUserAtomically` (§ 2.2).
- `api/setup.route.ts`: the two routes, `SetupProgressSchema` named per
  code-style, `operationId`s `getSetupProgress` / `setSetupProgress`.
- `apps/server/web/src/hooks/use-setup-progress.ts`: `useSetupProgress(enabled)`
  and `useSetSetupProgress()`.
- `lib/shell-gate.ts`, `routes/__root.tsx`, `routes/setup.tsx`,
  `types/setup.ts` (or wherever the web keeps setup types today).
- `bunx turbo build` after the route lands, so Eden's inferred client sees
  it.

## 4. Testing

TDD; each test seen failing first.

- **`auth.test.ts` (or wherever `promoteFirstUserAtomically` is pinned)**:
  the first user's row has `setup_step = 'network'`; a second user's is
  NULL.
- **`user-meta.repository.test.ts`**: get/set round-trip; an unknown stored
  string reads as null.
- **`setup-route.test.ts`**: GET returns the caller's own bookmark and not
  another user's; PATCH writes it and returns it; PATCH `null` clears; a
  bearer key gets 403 on both; an unknown step is 400; unauthenticated is
  401.
- **`shell-gate.test.ts`**: signed-in with a bookmark on `/` → `toSetup`;
  on `/setup` → `render`; signed-in while the bookmark loads → `blank`;
  signed-in with no bookmark → unchanged results for every existing case.
- **`setup.test.tsx`**: mounts with bookmark `agent` → "Add an Agent" is on
  screen and no bounce fires; Skip on Network PATCHes `agent`; `finish`
  PATCHes `null`; a signed-in visitor with no bookmark is bounced to `/`.
- **`__root` test**, if one drives the gate through the component: a
  signed-in user with a bookmark lands on `/setup`.

Verification: `bunx turbo build`, `bun run verify-types`, `bun run
lint:check`, `bun run test`.

## 5. Out of scope

- Restoring typed-but-unsaved form state (an auth key half-entered on the
  Network step). The bookmark restores the STEP; the step's own controls
  reload from the server as they do on any mount.
- The native assistant's screens in `apps/server/desktop`. Those run before
  a server exists and already persist their own progress; this spec starts
  where the served page does.

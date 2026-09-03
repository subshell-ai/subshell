# "Not found" experience: generic 404 screen, legacy /sessions redirects, deleted-subshell card

**Date:** 2026-09-03
**Status:** Approved design, pre-implementation

## Summary

Opening an old `/sessions/<id>` bookmark on a post-rename deployment renders TanStack
Router's built-in bare `Not Found` heading inside the app shell — no styling, no way
back except the browser button (observed live on the host, 2026-09-03). Three layers,
one spec:

1. A styled, actionable **generic not-found screen** for every unmatched URL.
2. **Legacy redirects** so old `/sessions/*` URLs resolve instead of dead-ending.
3. A **"Subshell not found" card** for `/subshells/:id` when the record itself is
   gone (deleted or never shared with the viewer), replacing the current flow where
   the terminal mounts, its WS attach is refused (4xxx), and the user is offered
   Restart/Delete buttons that cannot work on a missing record.

## 1. Generic not-found screen (unmatched URLs)

New `src/components/not-found-page.tsx` exporting `NotFoundPage`:

- The same card shape the workspace/profile detail routes already use for their
  not-found states: `main` with `mx-auto w-full max-w-2xl p-6` wrapping a `Card`
  (`CardHeader` → `CardTitle` + `CardDescription`, `CardContent` → action).
- Copy:
  - Title: **Page not found**
  - Body: *This page doesn't exist — the link may be old or mistyped.*
  - Action: primary `Button render={<Link to="/" />}` labeled **Go to subshells**
    (`/` IS the subshell list).
- Wired once in `src/main.tsx`: `createRouter({ routeTree, defaultNotFoundComponent:
  NotFoundPage })` (supported by the pinned `@tanstack/react-router` 1.170.30). It
  renders inside the root shell, so the sidebar and banners stay intact — the user
  is never ejected from the frame.

## 2. Legacy `/sessions/*` redirects

The sessions→subshells rename (commit 148aa9d, spec 2026-09-02 §1.2) changed the
frontend route `/sessions/$id` → `/subshells/$id` with **no** compat layer — that
waiver assumed a clean cut, but real browser histories/bookmarks/notifications kept
the old URLs. This spec adds the minimal compat the screenshot proves necessary:

- `src/routes/sessions_.$id.tsx` — route `/sessions/$id` whose `beforeLoad` does
  `throw redirect({ to: "/subshells/$id", params: { id: params.id } })`. The UUID is
  unchanged by the rename, so the deep link lands on the same subshell.
- `src/routes/sessions.tsx` — route `/sessions` whose `beforeLoad` does
  `throw redirect({ to: "/" })`.

Both are component-less (redirect only); the TanStack router vite plugin picks them
into `routeTree.gen` automatically. No redirect loop is possible: the targets are
final routes; a gone id falls through to layer 3's card, an unknown id under
`/subshells/$id` is a real route match, not a 404.

## 3. Deleted/unshared subshell card

Backend behavior (spec 2026-08-31 sharing): a subshell that is deleted **or not
shared with the viewer** answers `GET /api/subshells/:id` with **404 — never 403**.
So one client flag covers both honestly.

- `src/hooks/use-subshell-data.ts`: capture the query `error` and expose
  `isNotFound: boolean` on `SubshellData`, derived by a **pure exported predicate**
  `isNotFoundSubshellError(error: unknown): boolean`
  (`error instanceof ApiError && error.status === 404`) placed in
  `src/lib/subshell-not-found.ts` so `bun test` covers it without a DOM
  (the `lib/shell-gate.ts` precedent).
- `src/routes/subshells_.$id.tsx`: when `isNotFound` and the record is absent,
  render a card (same shape as §1; a sibling export in `not-found-page.tsx` or an
  inline composition — implementer's choice, favor the shared card shell) instead of
  the header/terminal:
  - Title: **Subshell not found**
  - Body: *It may have been deleted, or its owner hasn't shared it with you.*
  - Action: outline **Back to subshells** → `/`.
- The transient-failure path (server offline, 5xx, network error) keeps the CURRENT
  behavior — mount the terminal and let its reconnect/closed logic handle the gap.
  A 404 is the only case where the record can never arrive, so it is the only case
  diverted to the card.
- While `isNotFound` is true the page must not mount `SubshellTerminal` (no doomed
  WS attach + token POST) and the header's Restart/Delete affordances must not show.

## 4. Testing

- **Pure** (`src/lib/__tests__/subshell-not-found.test.ts`): `ApiError(404)` → true;
  `ApiError(500)`, network `TypeError`, `undefined` → false.
- **Component** (`src/components/__tests__/not-found-page.test.tsx`, happy-dom via
  `bunfig.toml` preload, existing pattern): `NotFoundPage` renders its title and the
  "Go to subshells" link with `href="/"`.
- **Manual on dev server**: `/sessions/<live-id>` lands on the subshell page;
  `/nope` shows the card inside the shell; `/subshells/<deleted-id>` shows the
  subshell card.

## 5. Verification (per `.claude/rules/verification.md`)

```bash
bun run verify-types
bun run lint:check
bun run test
```

## 6. Out of scope

- Server-side changes of any kind (the 404s it returns are already correct).
- The "Subshell is not running." WS-refusal panel — still the right handler for
  dead-but-existing records and transient refusals.
- Redirecting other pre-rename URLs: the only route the 2026-09-02 rename changed
  was `sessions_.$id` (`/` was always the list).

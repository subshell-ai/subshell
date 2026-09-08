# Auth Experience: Chrome-Free Sign-In + Instance-Wide Read-Only Roster

**Date:** 2026-08-30
**Status:** Approved design (brainstorming complete, pending implementation plan)
**Author:** Theo + Claude (brainstorming session)

## 1. Problem

Two rough edges in the signed-out / non-admin experience:

- `/login` renders inside the app shell: `__root.tsx` paints the persistent
  `AppSidebar` (desktop) or the drawer top bar (mobile) on every route, so the
  sign-in page shows full navigation — including **Logout** — before anyone is
  signed in. `/setup` has the same chrome. Related: there is no auth guard at
  all — an unauthenticated visitor to `/` or `/workspaces` stays there and
  watches each page's API calls 401.
- The user roster is admin-only (`users.route.ts` mounts `requireAdmin` on the
  whole `/api/users` prefix), while the sidebar shows "Users" to everyone.
  Non-admins click it and get an "Admin-only — you don't have permission"
  dead end. The roster should be instance-wide and read-only; management
  (create, and any future disable/delete) stays admin-only.

## 2. Decisions ratified during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | What the roster shows non-admins | **Same rows admins see** (`id`, `email`, `role`, `createdAt`) — one payload shape for everyone; Theo: instance users are trusted teammates |
| 2 | Auth guard | **Yes** — signed-out visitors on app routes redirect to `/login` with a `?redirect=` return path |
| 3 | Architecture | **Approach A — envelope + per-route gating** (below). Rejected: B (duplicate `GET /api/users/members` endpoint + a second request just to discover admin-ness), C (put `role` on the session via better-auth `customSession` — touches the security-critical auth wiring for one boolean; kept as the later generalization if a second role-aware surface appears) |

## 3. Shell: guard + chrome suppression (`__root.tsx`)

- While `useCurrentUser` is loading, render nothing (no chrome flash).
- Signed out:
  - first-run precedence (added during planning: without it a fresh instance's
    signed-out deep-link would hit a sign-in form that cannot work): if
    `GET /api/setup/status` reports `needsSetup`, anything that is not
    `/setup` — including `/login` — goes to `/setup`. The status query is
    cached `staleTime: Infinity` (true exactly once per instance); if it
    fails, `needsSetup` stays undefined and the page renders as today —
    the old no-guard behavior as the honest error fallback.
  - `/setup` and `/login` render bare (`/setup` is the pre-auth bootstrap;
    its existing redirect to `/` once a user exists stays).
  - any other route → `<Navigate to="/login" search={{ redirect: pathname }}/>`.
- The guard hooks live in a `Shell` component INSIDE `QueryClientProvider`
  (`useCurrentUser`/`useQuery` cannot run in the component that renders the
  provider).
- Signed in: chrome renders exactly as today; visiting `/login` keeps its
  existing "already signed in → go home" behavior, now honoring `redirect` (§5).
- Chrome suppression means only the nav: `/login` and `/setup` still render
  inside the `dvh`/inset shell wrapper (harmless, keeps viewport handling
  uniform and the safe-area padding where it lives), but neither
  `AppSidebar` nor `MobileTopBar` is mounted — the page owns the whole frame.
- The sidebar's "Users" nav item stays visible to everyone — it now leads
  somewhere real.

## 4. Backend: `users.route.ts`

- Prefix guard becomes `authGuard` (cookie session **or** bearer key — the
  standard `/api` contract; a bearer system key listing users is fine, they
  are operator-privileged anyway, and `viewerIsAdmin` stays false for bearers,
  see below).
- `GET /` returns `t.Object({ viewerIsAdmin: t.Boolean, users: t.Array(UserRow) })`.
  `viewerIsAdmin` mirrors `requireAdmin`'s exact semantics —
  `actor === "cookie" && (await UserMetaRepository.getRole(user.id)) === "admin"`
  — so "can manage" is computed once, identically to the POST gate, and
  machine credentials never see the admin UI.
- `POST /` keeps admin enforcement (403 otherwise). `requireAdmin`'s derive is
  prefix-scoped, so the implementer either mounts POST through a
  `requireAdmin` sub-instance or does an in-handler check with the identical
  semantics (cookie + admin role). The semantics are the contract; the
  composition is implementer's choice.
- `UserRowSchema`, the create flow, audit writes, and everything in
  `users.repository.ts` are unchanged.

## 5. Frontend: `/login` and `/users`

- `/login`: gains `validateSearch` for an optional `redirect` string. After
  successful sign-in, `window.location.href = safeRedirect(redirect) ?? "/"`.
  `safeRedirect` accepts only paths starting with a single `/` — rejects
  `//host` (protocol-relative), `/\`, absolute URLs, and empty — closing the
  open-redirect hole. Planning review added a second class: C0 control
  characters and space (`/[\x00-\x20]/`) are vetoed too, because WHATWG URL
  parsing strips tab/LF/CR *before* resolving — `/%09/evil.com` would
  otherwise arrive at `//evil.com`. The guard redirect (§3) supplies the param.
- `/users`: consumes the envelope.
  - Everyone: header ("Users" / "The people on this instance" for non-admins,
    today's copy for admins) + the roster table, columns unchanged,
    read-only.
  - Admins (`viewerIsAdmin`): exactly today's page — Add-user card and
    Audit-trail card included (audit fetch gated on the flag so members never
    fire a doomed `/api/audit` call).
  - The current "403 → Admin-only card" branch goes away (GET never 403s now);
    a failed fetch shows the honest degraded card ("Couldn't load users"),
    not a permission claim.

## 6. Testing

- **Backend (`bun test`)** — extend the existing users-route suite: member
  (cookie, non-admin) gets 200 + `viewerIsAdmin:false`; admin gets
  `viewerIsAdmin:true`; member POST → 403; bearer key GET → 200 with
  `viewerIsAdmin:false`. (Boot-real-DB recipe per `tests-backend-boot-db`.)
- **Unit (frontend)** — `safeRedirect` is a pure export: `/x` ok; `//evil`,
  `/\evil`, `https://evil`, `""`, missing → `null`/fallback.
- **E2E (Playwright)** — new `10-auth-experience.spec.ts`:
  - signed-out context: `/workspaces` → `/login` carrying a `redirect`
    param (exact encoding left to TanStack — the landing below proves the
    round trip);
    sign in → lands on `/workspaces`; login page has no `aside`/nav and no
    "Logout" control.
  - member context (member created via admin API, second browser context with
    its own storage state): `/users` shows the roster with their own email
    row; no "Add user" heading; audit card absent; member `POST /api/users`
    via request context → 403.
  - existing desktop specs keep passing — `users.tsx`'s admin view is
    unchanged once settled; only the response shape changed. (Post-review
    errata: a first review found the cold-load member-view flash, so the
    admin view now additionally paints a "Loading the roster…" card on
    cold loads before the envelope settles — a deliberate improvement over
    the original "pixel-identical" claim.)
- **Docs** — `docs/overview.md`: the users/roster line (and the auth bullet if
  it mentions admin-only listing) updated to "instance-wide read-only roster,
  admin-managed".

## 7. Invariants this design must not break

1. Admin cookie-only management: bearer keys can never create users or reach
   any admin surface (unchanged; `viewerIsAdmin` keeps bearers false).
2. The `requireAdmin` semantics (401 unauthenticated / 403 non-admin / 403
   bearer) still hold for POST.
3. WS token lifecycle, `env -i` curation, channel E2EE: untouched. This
   feature touches no auth *mechanics* — only the auth *surface* (guard,
   chrome, one route's gating granularity).
4. `/api/users` POST request shape, audit events, and repository code:
   unchanged.

## 8. Out of scope

Session `role` on `get-session` (approach C) until a second consumer needs it;
self-service profile editing; better-auth admin features (ban/disable — the
"disable" in Theo's ask was illustrative; nothing exists today); rate-limiting
the guard; dark/light anything (already dark-only).

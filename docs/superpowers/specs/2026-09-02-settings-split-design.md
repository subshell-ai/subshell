# Settings split — Account vs Server (Design 2026-09-02)

**Problem.** `/settings` mixes two audiences in one flat stack: per-user device
settings (terminal text size, notifications, passkeys, password) sit between
instance-admin controls (registration, system API keys, local launching) — and
the page's own subtitle even claims "Admin-only configuration" while most of
its cards are anything but. The user asked to split user/account settings from
server settings, and (their words) to "replace the logout link with the shadcn
/ better-auth component that shows a menu with the signed in user info / sign
out link and add an account settings link".

**Decisions from the owner (Q&A + "just get it done"):**
- Shape: **new `/account` page**; `/settings` becomes **server-only**.
- Placement: Account = terminal text size, notifications (master + this
  device), passkeys, change password. Server = registration, system API keys,
  "Launch on this host".
- Sidebar: the entry renames to **"Server" and renders only for admins**;
  account settings are reached from the user menu, not the nav.
- Admin plumbing: **`GET /api/settings/public` gains `viewerIsAdmin`** (the
  app already fetches it via `usePublicSettings`; the backend derives the same
  flag for the `/api/users` envelope). Rejected: a new `/api/me` route (second
  identity query + the App-type-depth hazard); no-gate (owner chose admin-only).

## 1. `/account` — the user page

New route `apps/frontend/src/routes/account.tsx`, `PageHeader
title="Account" subtitle="Your profile, devices and credentials"`. Cards in
order (all moved, none rewritten):

1. **Profile** (NEW card, small): displays name + email (read-only) from
   `useCurrentUser`; edit-in-place for display **name** via
   `authClient.updateUser({ name })` (better-auth), success/error line in the
   file's idiom. Email stays read-only (changing credentials is the password
   card's neighbourhood; better-auth change-email needs a verification flow —
   deliberately not built).
2. `NotificationsMasterCard` (account-wide switch — per-user state, moves).
3. `TerminalFontCard` (localStorage per device — moves).
4. `NotificationsCard` (this browser's web-push — moves).
5. `PasskeysCard` (self-service — moves).
6. **Change password** card — the inline block from `settings.tsx` (state +
   handler + JSX) moves into a new
   `apps/frontend/src/components/change-password-card.tsx` (RULING: extracted,
   not inlined — the route plus the Profile card would push `account.tsx`
   past the 200-line route rule, and the card becomes unit-testable like its
   siblings).

No sidebar nav entry for `/account` — it is reachable from the user menu (§3)
and by URL. No route guard needed beyond the existing signed-in shell (every
card is self-scoped).

## 2. `/settings` — server-only

Keeps, in order: **Registration** (inline card), `SystemApiKeysCard`,
`LocalLaunchCard`. Header becomes `title="Server"
subtitle="Instance-wide configuration (admins)"`.

- The account cards' imports/JSX leave; nothing else moves.
- **Non-admin honesty**: the page still renders for a direct URL — when
  `viewerIsAdmin === false` show the header plus a muted line "Server settings
  are for instance admins — your settings live under **Account settings**"
  (`Link to="/account"`), and render none of the admin cards (they would only
  error: registration/system-keys are cookie-admin server-side, LocalLaunchCard
  renders nothing below `canManage`). No new server enforcement — gates
  unchanged.

## 3. Sidebar: user menu replaces the Logout button

`apps/frontend/src/components/app-sidebar.tsx` bottom block:

- Build on the existing `components/ui/dropdown-menu.tsx` (Base UI Menu, the
  shadcn-style wrapper) — a `Popover`-free, keyboard-accessible menu.
- **Trigger** (replaces the Logout `Button`): an initials avatar (rounded
  `div`, first letter of name → email, uppercase; no avatar storage exists)
  + (expanded rail only) truncated name and email, chevron. Collapsed rail:
  icon-size button, `title="Account — <name>"`.
- **Menu content**: header = name + email (from `useCurrentUser`; disabled
  "Signed in" fallback while loading); items: **Account settings** (navigates
  `/account`), separator, **Sign out** (destructive-styled, calls the existing
  `signOut()` unchanged).
- The mobile drawer renders the same `AppSidebar`, so it gets this for free.

## 4. Navigation visibility

`NAV_ITEMS` becomes data + a `requiresAdmin?: boolean` flag on the `/settings`
entry (renamed `label: "Server"`, keeps the gear icon — `Server` icon belongs
to Nodes). The sidebar already has `usePublicSettings` available; filter admin
items when `viewerIsAdmin !== true` (undefined = still loading = hidden, same
"unknown ≠ open" posture as the registration switch). `/account` is NOT a nav
item. `/users` stays unconditional (it already degrades for non-admins).

RULING (e2e): with the entry admin-only, non-admin shells lose the Settings
link. `08-mobile-shell` runs as admin storage state; its drawer click names
"Settings" and MUST be updated to "Server" (§7) — the rename is a breaking
test change, not a silent pass.

## 5. Backend (one additive field)

`apps/backend/src/api/settings.route.ts` — `GET /public` response schema gains
`viewerIsAdmin: t.Boolean({ description: ... })`, computed exactly like the
`/api/users` envelope does (UserMetaRepository role === "admin" for the
session user; the route already resolves the signed-in user for its 401 gate).
Anonymous callers are unaffected (still 401). `usePublicSettings`'
`PublicSettings` interface gains the field with a JSDoc line.

## 6. Copy & link retargeting

- `components/emergency-login-banner.tsx`: "…(Settings → Change password)" →
  "…(Account → Change password)".
- `settings.tsx` header comment/mentions of the old mixed page;
  `notifications-master-card` / `notifications-card` / `terminal-font-card`
  doc-comments that say "the Settings page" → "the Account page".
- No other in-app links to `/settings` exist (verified by grep).

## 7. Tests

- Unit (frontend): user-menu renders name/email + both items and calls
  signOut (mock authClient pattern from existing tests); `/settings` nav entry
  hidden for `viewerIsAdmin: false` and shown for `true` (sidebar render test
  with the public-settings mock); account route smoke test (cards present).
- Backend: `GET /api/settings/public` carries `viewerIsAdmin: true` for an
  admin cookie, `false` for a normal user cookie (extend `settings-route.test.ts`).
- E2E: `08-mobile-shell` — the drawer click becomes the "Server" link (admin
  state); add the user-menu open → Account settings navigation to the phone
  flow; the overflow-list `/settings` entry stays (admin reaches it).

## 8. Out of scope (explicit)

- The Expo app's own settings tab (per-device instance registry — unrelated
  surface, same posture as last time's mobile ruling).
- Email change / verification flow, avatar upload, per-role page system.
- Any auth endpoint changes beyond the one public-settings field.

## 9. Verification

Trio + `bunx turbo build` (backend response schema changed → treaty types);
e2e 08 (+01 for the public-settings field consumption in 12, which asserts
specific keys — additive, should pass unchanged).

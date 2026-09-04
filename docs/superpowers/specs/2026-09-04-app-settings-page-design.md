# Preferences page (app settings split from Account)

Date: 2026-09-04 · Status: approved by Theo · Surface: `apps/frontend` only

## Problem

`/account` mixes three tiers: identity/credentials, account-wide preferences, and
per-device browser controls. On a phone the per-device push card sat at the very
bottom of a long stack, far from the master switch it belongs to (2026-09-04
notification debugging: the layout itself confused the user mid-debug).

## Decision

A third surface, **Preferences** (`/preferences`), holding the preference-tier
cards in two labeled groups:

- **"Synced with your account"** (server-stored, follow the user everywhere):
  `NotificationsMasterCard`, `TerminalHistoryCard`
- **"This device"** (browser state — gone if site data is cleared):
  `NotificationsCard` (per-device push enable), `TerminalFontCard` (localStorage font size)

`/account` keeps identity only: `ProfileCard`, `PasskeysCard`, `ChangePasswordCard`.
`/settings` ("Server", instance-wide, admin) is unchanged except the non-admin hint,
which now points at **Preferences**.

Rejected: tabs within one page (UI machinery for 2 cards/tab); two separate pages
(third menu entry, four cards across three destinations).

## Design

- `src/routes/preferences.tsx`: `PageHeader title="Preferences"` + two sections.
  Section labels are plain headings one tier below the page header — muted,
  `text-xs font-medium uppercase tracking-wider`, `id` + `aria-labelledby` on the
  grouped stacks. No new primitives, no backend changes (every card owns its data).
- `UserMenu`: new `onPreferences` prop; **Preferences** item (lucide
  `SlidersHorizontal`) above "Account settings". `app-sidebar.tsx` wires it to
  `navigate({ to: "/preferences" })`. The mobile drawer reuses `AppSidebar`, so
  navigation arrives for free.
- `account.tsx`: drop the four moved cards and the now-stale grouping comments;
  subtitle → "Your profile and credentials". The master↔device adjacency warning
  moves to `preferences.tsx` (the pair is split across sections by intent — the
  comment must say why, so nobody "restores" the adjacency).
- `settings.tsx` non-admin paragraph: links to Preferences (primary) and Account
  settings.

## Error handling / testing

Cards are self-contained and unchanged — their existing tests carry over.
`user-menu.test.tsx` gains: the Preferences item renders and invokes the callback.
Route needs the generated route tree (vite plugin regenerates at build; run the
frontend build before `tsc`).

## Rollout

Frontend-only: `bunx turbo build` + restart the live server; the PWA picks it up
on the next full relaunch (kill + reopen).

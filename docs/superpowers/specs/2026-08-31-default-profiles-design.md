# Auto-Defaulted Profiles + Two-Step Wizard

**Date:** 2026-08-31
**Status:** Approved design (Theo: "execute and implement") — **superseded 2026-09-13**
**Author:** Theo + Claude (brainstorming)

> **Superseded 2026-09-13 in whole by
> [2026-09-13-presets-design.md](2026-09-13-presets-design.md).** Profiles
> became presets, and every piece of machinery this spec existed to build —
> the profile required at launch, the auto-seeded blank **Default**, its
> `is_default` undeletable guard — is deleted: launching needs only an agent
> and a folder, a fresh instance has zero presets, and every preset is
> deletable. The body below is kept as the history of what was built and why.

## 1. Problem

Most users never configure anything on a harness CLI — they just want to open a
session. Yet the product forces profile creation into the critical path: the
first-run wizard ends with a bespoke "Profile" step, and `POST /api/sessions`
requires a `profileId`, so a brand-new instance cannot produce a session until
a form is filled.

## 2. Decisions ratified

| # | Decision | Choice |
|---|----------|--------|
| 1 | Deletion semantics | **Self-healing** (Theo's pick): every user must have ≥1 profile per enabled harness; missing → seed. (Later superseded for the Default itself — see §7: it became unremovable, so the self-heal path is the fallback, not the norm.) |
| 2 | Wizard shape | **Account → Harness → done** (Theo's pick): the Profile step is removed entirely; harness selection (the clickable-card ring) goes with it — the step becomes install/enable management only. |

## 3. The seeding rule

`ensureDefaultProfiles` — for each (user, enabled-harness) pair with **zero**
profiles, insert one ordinary profile: `name: "Default"` (name uniqueness is
already per user+harness, so no collisions), blank env/flags/settings,
`restartOnExit: false`, `configIsolation: 0`, and `isDefault: 1` (§7 — the
flag that makes it unremovable). It is an ordinary profile from then on —
editable and renamable; adding your own for that harness lifts the count
above zero, so nothing re-appears.

**Seed points (and one deliberate non-point):**

1. **User registration** — the existing better-auth `databaseHooks.user.create.after`
   hook, alongside the first-admin promotion.
2. **Harness enablement** — `PATCH /api/setup/harnesses/:id` with `enabled: true`
   seeds every existing user for that harness (the per-harness upgrade moment).
3. **Admin user creation** (`POST /api/users`) — an admin-minted account
   bypasses the better-auth `after` hook, so it seeds here too (best-effort,
   like the audit write alongside it: a seed failure must not 500 a good
   create; the boot sweep catches it later).
4. **Server boot** — after migrations + `ensureSystemUser`, a one-time sweep
   covers existing installs upgrading to this version.
5. **NOT on `GET /api/profiles`** — self-healing on read would resurrect a
   just-deleted Default on the very next refetch and make Delete look broken.
   A deletion therefore stands until the next boot or harness re-enable.

Disabled harnesses get nothing (their profiles are hidden from every picker
anyway — `usableHarnessIds`); re-enabling routes through seed point 2.

## 4. Shape by layer

**Backend** — new `services/default-profiles.ts` exporting
`ensureDefaultProfilesForUser(db, userId)` (used by 1),
`ensureDefaultProfilesForHarness(db, harnessId)` (used by 2), and
`ensureDefaultProfilesEverywhere(db)` (used by 3; the shared inner loop over
users × enabled harnesses reads enablement from `HarnessPluginsRepository`
with the plugins' `enabledByDefault` fallback). Boot logs a one-line summary
only when it created something. (Schema: `profiles.is_default` added by
migration `0010-profile-default-flag` — see §7.)

**Frontend wizard** (`routes/setup.tsx`) — `STEPS = ["Account", "Harness"]`.
Step 2 keeps the harness cards, install help, Enable/switch, and the
ErrorBanner+Retry honesty added this month, but drops the selection state and
the card's selectable affordance; the bottom button becomes **Finish setup**
(always enabled — a user with nothing installed yet can still finish and use
the settings page later). Finishing retires the `["setup-status"]` cache and
navigates home exactly as the old step 3 did. All profile-form state,
`ProfileFields` usage, and the widened-card branch are removed.

**Tests** — backend: new `default-profiles` service suite (empty → one Default
per enabled harness per user; existing own profile → no extra; disabled
harness → none; enable-path seeds via the route with `CLAUDE_PATH=/bin/true`;
registration seeds through the real `signUpEmail` path; list-reads never
seed); e2e spec 01 rewritten for two steps, asserting the wizard profile round
trip is replaced by "the stub `pi` harness already has a Default profile" via
the API. The env-persistence block moves out (the wizard has no fields any
more; `existing-session-list`/profile-editor coverage stays where it lives).

**Docs** — `docs/overview.md`: setup-wizard flow line and any "define first
profile" phrasing.

## 5. Invariants

- `POST /api/profiles` and the editor stay as-is — custom profiles are still
  the product's whole point; defaults just remove the cold-start friction.
- The `/api/sessions` contract is unchanged (`profileId` still required).
- Seeding must never overwrite or mutate existing profiles; it only ever
  inserts when the count is zero.
- Self-healing runs at seed points only (3.5) — reads never write.

## 6. Out of scope

Per-harness default names ("Claude Default" — "Default" is unique where it
matters); seeding profiles for disabled harnesses; migrating/renaming
pre-existing first profiles; changing the add-session picker UX. (Marking
defaults as special — undeletable flags — was out of scope here and is now
in scope, see §7.)

## 7. Amendment (same day): unremovable Defaults

Theo: "make default profiles unremovable. if someone disables the related
harness, then all profiles associated with that harness are simply hidden and
new sessions cannot start that use them."

- **Flag, not name.** `profiles.is_default` (migration 0010, NOT NULL default
  0). The seeder sets it on every insert; `DELETE /api/profiles/:id` refuses
  flagged rows with **409** and the message "Default profiles can't be deleted
  — edit it instead, or disable the harness to hide it". (The route's internal
  `default_profile` tag is not a wire code: the error handler derives the
  structured body's `code` from the status, so clients see the generic
  `EXISTS_ERROR` + 409 and should branch on the status.) Renaming a Default
  keeps it protected; a hand-made profile called "Default" is not. PUT stays
  allowed — unremovable, not read-only.
- **Backfill** marks existing rows that are exactly the seeder's shape (name
  `Default`, env/flags/settings all NULL). A Default the user had already
  edited before the flag existed stays deletable until the next boot, where
  the zero-profiles rule covers any gap.
- **Disable = hide + block**: `GET /api/profiles` filters to `usableHarnessIds`
  (enabled AND installed) and `sessions.service` rejects a profile whose harness
  is not usable — both already in place. The amendment closed the one hole in
  the promise: `maybeAutoRestart` now defers (on the normal backoff schedule)
  when the harness is disabled or uninstalled, because an auto-restart *is* a
  new session. Disabling hides every profile of that harness, stops new
  sessions and pauses restarts; re-enabling brings everything back. Nothing
  deletes on disable.
- **Seeding is best-effort at every seam** (logged, never fatal): a failed
  insert must not 500 a committed sign-up/user-create/harness-enable, and must
  never block boot. Registration and admin-create log a warning; the boot
  sweep logs and continues, and the next boot retries.
- **No double-seeding**: the insert re-checks its own pair
  (`insertIfNoneForPair`, one `INSERT … WHERE NOT EXISTS` statement), since a
  raced duplicate would be permanently undeletable and there is no unique
  constraint on (user, harness).
- **UI**: the profile row menu simply omits "Delete profile" for flagged rows
  and shows a `default` badge explaining why (the 409 message carries the
  same advice: edit it, or disable the harness to hide it).

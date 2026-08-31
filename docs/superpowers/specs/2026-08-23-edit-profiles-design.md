# Edit Profiles — Design

**Date:** 2026-08-23
**Status:** Approved
**Scope:** Frontend only — no backend changes

## Problem

Profiles (per-harness launch configurations) can be created and deleted from the Profiles
page, but there is no way to edit an existing one. Users who have a typo in an env var, want
to change flags, or toggle config isolation/auto-restart must delete and recreate the profile
(and any sessions referencing it would lose their link).

## Solution

A dedicated edit page at `/profiles/$id` that follows the existing param-route pattern
(`sessions_/$id`). The Profiles page gets an edit (pencil) button on each card that navigates
to the edit page. Saving issues a `PUT /api/profiles/:id`, which already exists and supports
partial updates of every profile field.

## Architecture

- **Route:** `apps/frontend/src/routes/profiles_.$id.tsx` → `/profiles/$id`
- **Edit button:** pencil icon (lucide `Pencil`) on each profile card in
  `apps/frontend/src/routes/profiles.tsx`, next to the existing trash button; `Link`s to
  `/profiles/$id`
- **Shared fields component:** extract the profile field inputs (name, env JSON, flags,
  config isolation, auto-restart) from the create form into a new
  `apps/frontend/src/components/profile-fields.tsx` (`ProfileFields`), plus the env/flags
  parsing helpers. Used by **both** the existing create form (which currently inlines these
  fields) and the new edit page — one source of truth.
- **No backend change:** the `PUT /api/profiles/:id` route (`apps/backend/src/api/profiles.route.ts`)
  already accepts and persists all of these fields.

### Data flow

1. User clicks the pencil on a profile card → navigates to `/profiles/$id`
2. The edit page reads `id` via `useParams` and finds the profile in the existing
   `["profiles"]` list query (`GET /api/profiles`)
3. Fields pre-fill: env JSON parsed and pretty-printed; flags array joined back into
   one-per-line; toggles from their numeric flags
4. User edits, clicks **Save** → `PUT /api/profiles/:id` with the same body shape as create
   (`env`, `flags`, `configIsolation`, `restartOnExit`, `name`)
5. On success: invalidate `["profiles"]` query and navigate back to `/profiles`
6. **Cancel** navigates back to `/profiles` without saving

## Details

### Fields (same as create form)

| Field | Input | Pre-fill |
| --- | --- | --- |
| Name | `Input` | `profile.name` |
| Env vars (JSON) | `Textarea` | pretty-printed parsed JSON, or empty |
| Flags (one per line) | `Textarea` | `profile.flagsJson` parsed → lines (whitespace split on save) |
| Config isolation | `Switch` | `profile.configIsolation === 1` |
| Auto-restart on exit | `Switch` | `profile.restartOnExit === 1` |

Empty name falls back to `"Untitled"` on save, matching create.

### Error handling

- Env JSON parse errors are blocked inline before the request, matching the create flow.
- `apiFetch` throws with the server status/message on failure — surfaced inline near the buttons.
- **Profile not found:** if the profile id from the URL isn't in the list query (deleted
  elsewhere, direct deep-link with empty cache), render a "Profile not found" state with a
  link back to `/profiles` rather than an empty form or a crash.

### Types

The `ProfileRow` interface currently lives inline in `profiles.tsx`. Both the create page and
the edit page need it, so move it to a frontend type location (e.g.
`apps/frontend/src/types/profile.ts`) and import from both — deduplication per the code-style
rules.

## Testing

- **Unit test** for the extracted env/flags parsing helpers (empty input, invalid JSON, flags
  string → array and array → string round-trip, whitespace splitting for multi-word flags).
- Route wiring and the shared fields component are thin UI — covered by `verify-types`,
  `lint`, and manual browser verification.

## Out of scope

- Exposing **settings JSON** in the UI (stored but not surfaced anywhere today; the PUT
  endpoint already accepts it, but this design keeps the UI matching the create form).
- Deleting profiles from the edit page (delete stays on the list page).
- Backend changes of any kind.

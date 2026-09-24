# Clone a preset from the action menu

Date: 2026-09-23
Status: approved by operator (design conversation, same day)

## Problem

Presets (`/presets`, `apps/server/web`) vary mostly by one or two env vars or
flags — a second model, a second base URL. Today the only path to such a
variant is Edit (which mutates the original) or New preset (which starts
blank). The row's action menu carries Edit and Delete only.

## Decision

**Clone opens the create dialog prefilled**, not a one-click server copy.
This mirrors subshell's `Clone…` (a dialog, per `clone-subshell-dialog.tsx`)
and reuses `CreatePresetDialog`, whose locked posture already exists. A
server-side `POST /:id/clone` endpoint was rejected: the browser already
holds the full row (cookie callers get `envJson`), the duplicate-name 409
already renders inline and keeps the dialog open, and new API surface buys
only a race-proof suffix picker the client can compute from the cached list.

Everything is client-side; no API, DB, or server change.

## Design

### `lib/preset-form.ts`

New pure export:

```ts
suggestCloneName(rows: PresetRow[], source: PresetRow): string
```

Candidates are `"<source.name> (2)"`, `(3)`, … — the same numeric-suffix
convention migration 0028 used to break existing collisions. A candidate is
taken when another row with the **same `harnessId`** matches it
case-insensitively (the UNIQUE index is `COLLATE NOCASE`); the source's own
name never blocks a suffixed candidate, and rows of other harnesses are
irrelevant because the collision scope is `(user, harness, name)`. First
free wins. No cap: the loop terminates because the row set is finite.

### `create-preset-dialog.tsx`

New optional prop `initialForm?: PresetFormValue`. When present it seeds the
form's initial state (replacing the blank-form seed); the harness is already
inside it and the caller also passes the existing `lockedHarness`, so the
dialog renders the locked posture with the clone's fields. With
`initialForm` the header reads **"Clone preset"**; otherwise the two existing
titles are unchanged. The submit button stays "Create preset" — the POST is
a create whatever prefilled it. "Mount IS the open" still holds: the clone
dialog is mounted only while open, so a second Clone starts from a fresh
seed of the then-current source.

### `routes/presets.tsx`

A third `ActionItem` between Edit and Delete:
`{ label: "Clone preset", icon: Copy }` (lucide `Copy`, matching the
subshell menu's Clone icon), non-destructive. Its `onSelect` sets
`cloneSource: PresetRow | null` state; while set, the page mounts
`CreatePresetDialog` with `lockedHarness={cloneSource.harnessId}` and
`initialForm={{ ...presetFormFromRow(cloneSource), name: suggestCloneName(presets ?? [], cloneSource) }}`.
Success flows through the existing `useCreatePreset` cache write +
invalidation; the new row appears under its agent header.

### What the clone carries

Name (suffixed suggestion, editable), env rows, flag rows, restart policy.
Not `description`: the form model and both payload builders never carried
it (the create path has never sent it), so a clone drops it like any preset
created through this dialog. No new distinction to draw, no new field.

### Error handling

Unchanged: a raced duplicate name answers 409 and `create.error` renders
inline under the fields with the dialog open, its message naming the clash
("You already have a … preset named …").

## Testing

- `lib/__tests__/preset-form.test.ts`: `suggestCloneName` — nothing taken
  → `"X (2)"`; `(2)` taken → `(3)`; taken-suffix gap `(2),(4)` → `(3)`;
  case-insensitive match; same-named row under a DIFFERENT harness does not
  bump; source named `"X (2)"` → `"X (2) (2)"` (deterministic, no parsing of
  existing suffixes).
- Component test (`components/__tests__/`, precedent:
  `clone-subshell-dialog.test.tsx`): mounting with `initialForm` shows the
  prefilled name/env/flags and the locked agent, and the "Clone preset"
  title; the unlocked create posture still renders its old title.
- `e2e/tests/04-presets.spec.ts`: a Clone round trip — create a preset,
  Clone it, see the `… (2)` row under the same agent header.

## Out of scope

- A server-side clone endpoint, and cross-agent cloning (harness is immutable
  at create, and cloning into another agent's schema-coupled env/flags is a
  different feature).
- Surfacing `description` in the form.

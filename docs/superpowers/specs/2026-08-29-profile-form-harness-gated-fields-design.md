# Profile create form: gate fields behind harness selection

Date: 2026-08-29
Status: approved (approach A) — **superseded 2026-09-13**

> **Superseded 2026-09-13 in its VOCABULARY by
> [2026-09-13-presets-design.md](2026-09-13-presets-design.md).** A profile is
> a **preset**: the form this spec designed is `preset-fields.tsx`, the route
> is `/presets`, and the field ids are `#preset-*`. The design itself stands —
> gating the fields behind the agent pick is exactly what the launch form does
> now, and the harness-first ordering this spec argued for became the whole
> shape of the new form. Read it for the argument, not for the names.

## Problem

The "Create profile" form (`apps/frontend/src/routes/profiles.tsx`) shows every
field — name, env vars, flags, auto-restart — before the user has picked a
harness. Env/flag autocomplete suggestions and the overall launch semantics are
harness-dependent, so the pre-selection state is noise: the user sees four
sections they can't meaningfully fill yet.

## Desired behavior

When creating a new profile, the form shows **only the Harness select** until a
harness is chosen. Selecting one reveals the remaining fields (Name, Env vars,
Flags, Auto-restart). The gate is pure rendering: if `harnessId` were ever to
become empty again (the shadcn Select offers no clear action, so this is
defensive, not a reachable click), already-entered values survive in the
parent-owned state and reappear with the fields.

## Design

### 1. Conditional disclosure in `ProfileFields`

`apps/frontend/src/components/profile-fields.tsx`: wrap everything after the
harness-select block (the Name, Env vars, Flags, and Auto-restart sections,
currently lines 112–162) in `{value.harnessId && ( ... )}`.

- No new prop. The edit page (`profiles_.$id.tsx`) always has a non-empty
  `harnessId` (the server requires one at creation and never clears it), so the
  gate is a no-op there and the create/edit paths stay shared.
- Values are kept in the parent-owned state object while hidden; hiding is pure
  rendering, so no state is lost on deselect/re-select.
- The existing auto-pick effect (exactly one installed+enabled harness →
  auto-select, lines 42–46) now also reveals the form immediately in
  single-harness setups. This is intended.

### 2. Hint while collapsed

While no harness is selected, the harness help text area gains a follow-up
line, e.g.:

> Select a harness to see the rest of the options.

Rendered only when `!value.harnessId && !lockHarness`.

### 3. Create button disabled until a harness is chosen

`profiles.tsx`: the Create button becomes `disabled={busy || !form.harnessId}`.
The existing `if (!form.harnessId) throw new Error("Choose a harness first")`
guard in `createProfile()` stays as a safety net (and remains the only
server-round-trip-free validation).

## Error handling

Nothing changes server-side: `CreateProfileBodySchema` still requires
`harnessId` (`minLength: 1`) and the POST route still rejects unusable
harnesses (409). No API or schema changes.

## Testing

Manual verification on the Profiles page:

1. Open "New profile" with multiple harnesses → only the select + hint visible;
   Create button disabled.
2. Pick a harness → all fields appear; Create enabled.
3. Switch to a different harness → fields stay visible, suggestions update.
4. Edit an existing profile → all fields visible as before (no regression).

No automated UI tests exist for this component today (only
`src/lib/__tests__/profile-form.test.ts` for the state helpers, which are
untouched), so no test changes are planned; `bun run verify-types`,
`bun run lint:check`, `bun run test` must pass.

## Explicitly out of scope

- Any change to the edit page's layout or the `lockHarness` behavior.
- Per-harness field templates or a dedicated harness-picker step.
- Backend validation changes.

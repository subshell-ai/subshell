# Required-input submit gating (form library adoption)

Date: 2026-09-29. Operator rulings: the "Add to stack" button (and any form's
submit) must be disabled unless every required input is filled — and the
substrate shall be a form **library** (ruling 2026-09-29, option "C", chosen
over inline predicates and over a boolean wrapper component).

## Problem

Six web forms validate required input only when the handler runs, so their
submit buttons stay clickable while the form is knowingly invalid; the press
just prints an error. The house precedent already disables on the same
predicate (`save-workspace-dialog.tsx:115`, `title-dialog.tsx:92`,
`system-key-create-dialog.tsx:126`, `provider-dialog.tsx:375`), but nothing
keeps predicate and button from drifting.

The audited set (submit handler validates, `disabled` omits it):

| # | Form | Missing from `disabled` |
|---|------|-------------------------|
| 1 | `components/prompts/prompt-picker-dialog.tsx:290` | body non-empty; description required only while save-to-library is ON |
| 2 | `components/prompts/prompt-form-dialog.tsx:113` | description non-empty, body non-empty, description ≤ 120 (`validatePromptDraft`) |
| 3 | `components/change-password-card.tsx:102` | min length; new === confirm |
| 4 | `components/plugins/install-by-name-form.tsx:140` | derived-or-typed plugin id passes `isSafePluginId` (empty-spec case already hides the button) |
| 5 | `components/networking/addresses-card.tsx:366` | `formProblems()` validity (dirty-only gate today) |
| 6 | `components/networking/network-settings-form.tsx:243` | required non-secret fields empty (dirty-only gate today) |

## Decisions

- **Substrate:** `@tanstack/react-form` (latest stable, pinned exact) +
  `zod@4.4.3` — the version `packages/mcp-core` already pins, so the lockfile
  gains no second zod. TanStack matches the stack (Query is in the app); zod v4
  implements the Standard Schema spec, so it plugs into the form's structural
  validation without a bespoke adapter. Bundle cost is nil: the SPA is a single
  Vite chunk (no route code-splitting, measured 2026-09-29).
- **Uncontrolled forms** (`defaultProviders: { form: "uncontrolled" }`): every
  control is a Base UI primitive already; controller wiring is the fragile
  seam, and uncontrolled keeps existing inputs untouched.
- **Sync-with-server validators are reused, not re-expressed.** #5 and #6 keep
  their existing validators (`formProblems` from
  `@internal/server/config-values`; the card's required/secret rules) as the
  form-level validator. Their reason strings are deliberately server-shadowing
  and must not fork into a second schema.
- **Disable explains readiness; the guard guarantees it.** Handler early-returns
  stay (Enter-key implicit submission, render races around mutations).
- **Copy is canonical:** every message moves verbatim from today's handlers;
  two-sentence, no-em-dash UI rules already hold there and keep holding via
  `lint:design`.
- **Install discipline:** `bun add` → `syncpack fix` → `bun install` →
  `bun run lint:lockfile` (`.claude/rules/dependencies.md`).

## Design

### Plumbing — `src/lib/form.ts` (small, one file)

- `makeForm({ defaultValues, validator, onSubmit })` → `useForm` with
  `validators: { onSubmit: validator, onChange: validator }` (structural; zod
  schema or the legacy `formProblems`-shaped function — the file's contract is
  "returns `undefined` or fielded errors"), uncontrolled providers, change
  triggers.
- `useSubmitReady(form, busy)` — subscribes to `isValid`/`isSubmitting`;
  returns the boolean every swept button passes to `disabled`
  (`busy || !valid || submitting`).
- Field errors render through the existing markup
  (`<p role="alert" className="text-destructive text-detail">…</p>`); no new
  UI primitives.

### Per-form changes

1. **prompt-picker custom step** — zod: `body` (min 1,
   "The prompt text is required"); `description` required only when
   save-to-library is ON ("A saved prompt needs a short description"), max 120.
   The Switch flip re-runs validation, so the gate is conditional. The
   sessionStorage draft ruling is preserved: draft loads to `defaultValues`,
   the durability effect keys off form state exactly as today.
2. **prompt-form-dialog** — zod replaces `validatePromptDraft` (three messages
   verbatim); `lib/prompt-form.ts` validation is deleted in the same commit and
   its tests retarget to the schema.
3. **change-password-card** — zod: min length (existing interpolated
   MIN_PASSWORD_LENGTH sentence), match on the confirm field
   ("New passwords do not match"). Native `required` attrs stay as backstop.
4. **install-by-name-form** — zod refinement on the derived-or-typed id
   ("That package name gives no usable plugin id. Name the id the plugin
   declares."); the empty-spec hide stays as-is; the message now shows as the
   user types.
5. **addresses-card** — `formProblems(wire(drafts))` becomes the structural
   validator; Save keeps `touched.length === 0 || busy` and gains
   `|| !valid`; per-field problems paint on change instead of post-Submit.
6. **network-settings-form** — the required non-secret predicate becomes the
   structural validator; Save gates on it; server `issues` remain rendered as
   the submit-time backstop.

### Non-goals

The ~20 other forms (dirty-gated, select-gated, no-input confirms — the audit
listed them) are untouched; none has a required-input submit that lies. Mobile
(RN) and desktop sub-apps are out of scope. One AGENTS.md paragraph records the
substrate for NEW forms; existing ones are not force-migrated.

### Tests (bun test + @testing-library/react, colocated `__tests__/`)

Per form: button disabled while a required input is empty, enabled once filled;
picker: the Switch flip re-gates both directions; #5/#6: existing reason
strings appear on change (not only after Submit); existing submit-guard cases
retarget to the Enter-key/implicit path so the backstop stays pinned. Web
verification: full `bun test`, `tsc --noEmit`, biome, `bun run lint:design`.

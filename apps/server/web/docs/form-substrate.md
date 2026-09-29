# The form substrate (`src/lib/form.ts`)

Spec: `docs/superpowers/specs/2026-09-29-required-input-submit-gating-design.md`.

**A form with required input runs through `makeForm`, not a hand-rolled
disabled expression.** TanStack Form + zod; zod v4 is a Standard Schema, so a
schema passes straight into `validators` with no adapter package.

- `makeForm({ defaultValues, validator, onSubmit })`: ONE structural
  validator over the whole draft: a zod schema, or the field-problem function
  when the rules shadow the server's (`formProblems`, `connectBlocker`-style
  predicates). The validator runs onMount + onChange + onSubmit; **onMount is
  load-bearing**: without it a pristine form has run nothing, reports
  itself valid, and the gated button starts ENABLED until the first
  keystroke (measured, @tanstack/react-form 1.33.5).
- `useSubmitDisabled(form, busy)`: the only expression a swept button passes
  to `disabled`.
- `fieldError(errors)`: the field's one sentence (Standard Schema issues
  carry a `{ message }` object, plain functions a string).
- **Disable explains readiness; the guard guarantees it.** Handler
  early-returns stay (Enter-key implicit submission, render races around
  mutations). Never delete them when touching a swept form.
- **The caret rule** (networking pair): a complaint never appears WHILE the
  caret is in the box; the 2026-09-16 "unfinished thought" ruling stands,
  but the moment the field blurs, the sentence sits beside the greyed button
  that field causes. A grey button with no way to learn why is the defect
  `lib/password` was born from.

Two notes on the substrate's types: `makeForm` branches internally (a function
validator and a schema cannot share one `useForm` inference) behind a single
`SubshellForm<TValues>` alias that erases the validator-error generics:
errors are read through `fieldError`, never by their concrete shape. And the
library has NO uncontrolled mode in 1.x stable (a beta-era idea that never
shipped); fields are controlled, which costs nothing here since every swept
form already held its values in React state.

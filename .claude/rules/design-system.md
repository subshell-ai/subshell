# Design System

The authoritative reference is [`docs/design-system.md`](../../docs/design-system.md);
`bun run lint:design` enforces it and fails the build on a violation.

**Pick a role, never a number.** Six type roles — `display`, `heading`,
`label`, `body`, `detail`, `caption` — at two weights, `strong` (600) and
`regular` (400):

| surface | write |
|---|---|
| SPA / client (Tailwind) | `text-label font-strong`; `text-sm`/`text-xs` are accepted aliases of body/caption |
| assistant (plain CSS) | `font-size: var(--text-label); font-weight: var(--font-weight-strong)` |
| mobile (RN) | `...font("label")` from `src/lib/tokens.ts` |

Colours by their shadcn names (`--foreground`, `--muted-foreground`,
`--border`, …) on every surface; mobile in camelCase from `tokens.ts`.
Spacing on the 4px grid. A `text-[13px]`, a `font-size: 14.5px`, a
`fontSize: 17` or a hex outside a token file is refused by the check — if
the system lacks what you need, add the token to every surface in one change.

Line items are `label` over `detail`, differing by weight and colour. **Every
explanation a control gives about itself is `detail`** — its help text, a
"set by the environment" note, a saved-vs-running line, a validation error —
all at one size; `caption` is metadata only (timestamps, versions, counts) and
`body` is running text not attached to a control. Long actions show the
process's own last line; failures render on the thing that failed. The full
pattern list, each with the defect it closes, is in the reference.

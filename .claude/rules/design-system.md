# Design System

The authoritative reference is [`docs/design-system.md`](../../docs/design-system.md);
`bun run lint:design` enforces it and fails the build on a violation.

App copy follows [the repository's writing voice](../../AGENTS.md#writing-voice):
write as you'd speak to a peer, with active verbs, natural contractions, and
varied sentence structure. Explain what's happening and what the reader can
do next. Keep explanations brief without squeezing them into long sentences.
Review tone by reading it aloud; the linter can't tell whether prose sounds
natural.

**Pick a role, never a number.** Six type roles (`display`, `heading`,
`label`, `body`, `detail`) at two weights, `strong` (600) and
`regular` (400):

| surface | write |
|---|---|
| SPA / client (Tailwind) | `text-label font-strong`; `text-sm` is the one accepted alias (body) |
| assistant (plain CSS) | `font-size: var(--text-label); font-weight: var(--font-weight-strong)` |
| mobile (RN) | `...font("label")` from `src/lib/tokens.ts` |

Colours by their shadcn names (`--foreground`, `--muted-foreground`,
`--border`, …) on every surface; mobile in camelCase from `tokens.ts`.
Spacing on the 4px grid. A `text-[13px]`, a `font-size: 14.5px`, a
`fontSize: 17` or a hex outside a token file is refused by the check; if
the system lacks what you need, add the token to every surface in one change.

**Aim for one or two short sentences per UI explanation.** Use more when
consequences or limits need it. Keep warnings at the decision point; move
optional background to docs or a disclosure. UI copy uses no em dashes;
an absence placeholder in a table isn't prose.

**Agent** means the AI agent in a pane. Call the node background program the **daemon** or **node daemon**; a compact version column can say **Version**. See `apps/docs/STYLE.md` for examples.

Line items are `label` over `detail`, differing by weight and colour. **Every
explanation a control gives about itself is `detail`** (its help text, a
"set by the environment" note, a saved-vs-running line, a validation error),
all at one size, the same `detail` that carries metadata (timestamps,
versions, counts); `body` is running text not attached to a control. A tooltip
popup is the floating-surface exception: it carries `body` (amendment 2026-10-12;
see the reference).
**Keep UI titles short and fixed.** Name the action ("Insert this prompt?",
"Close this subshell?") and put names, counts, versions, URLs, and other
variable details in the body. Apply this to dialogs, confirmations, cards,
and action headings. Object names can still appear in lists and detail
fields. Name-length limits and historical specs aren't exceptions. Follow
the [content guide](../../apps/docs/STYLE.md#product-copy-and-confirmations)
for action labels, consequences, and examples.
**A required input takes a gold `*` at rest and a gold caption once the caret
leaves it empty; a hard error (a refused value, a server refusal) stays
`text-destructive` red** (ruling 2026-09-30: gold says "nothing typed yet",
red says "what you typed is wrong"; `fieldErrorToned` reads the split).
**There is no 12px**: `detail` (13) is the floor, and `text-xs` /
`text-caption` are refused by `lint:design`. Long actions show the
process's own last line; failures render on the thing that failed. The full
pattern list, each with the defect it closes, is in the reference.

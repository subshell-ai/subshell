# Design System

The rules every surface renders by — the SPA (`apps/server/web`), the server
assistant (`apps/server/desktop/ui`), the client node page
(`apps/client/desktop/ui`) and mobile (`apps/client/mobile`). This is the
living reference; the decision record is
`docs/superpowers/specs/2026-09-14-design-system-design.md`, and the check
that enforces it is `bun run lint:design` (`scripts/design-tokens.ts`).

**The one rule:** pick a ROLE, never a number. Sizes, weights and colours are
tokens; a literal outside a token file is refused.

## Type — six roles, two weights

| role | web | mobile | for |
|---|---|---|---|
| `display` | 30 / 600 | 28 / 600 | one per screen — a frame or page title |
| `heading` | 20 / 600 | 20 / 600 | card, section, dialog and sheet titles |
| `label` | 15 / 600 | 16 / 600 | **line items**: form labels, checklist rows, radio/toggle titles, table headers, buttons — what you scan for |
| `body` | 14 / 400 | 16 / 400 | running text, hints, subtitles |
| `detail` | 13 / 400 | 13 / 400 | the explanation under a `label`; `muted-foreground` by default |
| `caption` | 12 / 400 | 12 / 400 | chips, timestamps, monospace output |

Line-height 1.2 for `display`/`heading`, 1.5 otherwise. Code is `caption` in the
monospace stack. **Weights are `strong` (600) and `regular` (400) — nothing
else.** A label is strong; prose and values are regular; nothing is louder
than `display`.

How to say it on each surface:

| surface | size | weight |
|---|---|---|
| SPA, client | `text-label` … `text-caption` (`text-sm` = `body`, `text-xs` = `caption` are accepted aliases; other Tailwind sizes are refused) | `font-strong`, or nothing |
| assistant | `font-size: var(--text-label); line-height: var(--text-label--line-height)` | `font-weight: var(--font-weight-strong)` |
| mobile | `...font("label")` | comes with the role |

- `cn()` in the SPA and the client registers the six role utilities as font-sizes — tailwind-merge would otherwise group them with the text-colours and drop one when both are named.
- `font-semibold` remains legal by VALUE (600) but is retired as a NAME — write `font-strong`.

## Colour — Dreamframe, under one set of names

Values: `docs/superpowers/specs/2026-09-03-dreamframe-theme-design.md`. Names,
everywhere: `background`, `card`, `border`, `foreground`, `muted-foreground`,
`primary`, `primary-foreground`, `success`, `warning`, `destructive`. Mobile
uses the same roles in camelCase (`mutedFg`, `primaryFg`) as hex derived from
the web's oklch — and `lint:design` re-derives every compared colour every run. Status colours
never carry meaning alone; pair them with a word.

## Spacing, radius, motion, targets

- Spacing on the 4px grid: 4, 8, 12, 16, 24, 32.
- Radius 8 (`--radius`, `radius`).
- Motion: 150ms for micro-feedback, 220ms for a screen or panel entering; every
  animation inside `prefers-reduced-motion: no-preference`. One-shot animations
  only on elements the poll does not rebuild — a rebuilt element replays its
  animation, which is how a done-mark came to pulse forever.
- Touch targets ≥ 44 where there is touch.

## Patterns

Each rule closed a real defect (spec § 4). A pattern without a reason is not
admitted here.

- **Line item** — `label` over `detail`, differing by weight AND colour, never
  by tone alone. *(15px regular over 13px muted read as one paragraph.)*
- **Choice group** — radios inside `role="radiogroup"` with an `aria-label`; a
  dependent setting sits BELOW the group after a rule, never indented under one
  option; its dependency is a disabled control that says why and names what
  would answer. *("needs the box above" named a widget.)*
- **Long action** — spinner + the process's OWN last line, verbatim + an `m:ss`
  clock. No invented percentage. The footer does not repeat the pane.
  *(Installs sat blind under ten-minute deadlines.)*
- **Failure** — on the thing that failed, as a sentence plus the output behind a
  disclosure; "couldn't run" and "ran and exited N" say which. *(An error under
  a five-row list named none of them.)*
- **Consequential action** — the control states what it executes, on screen,
  without a click. No confirm step unless destructive. *("Install" beside a
  copyable command read as two alternatives.)*
- **Destructive action** — typed consent (the reset's hostname), never a
  checkbox.
- **Step / wizard** — every step shows on every machine, with a done-mark when
  already satisfied; the title names the STEP and stays stable; no auto-advance.
  *(A skipped step jumped the dots 1→3 and killed Back.)*
- **Window chrome (desktop)** — when the shell drops the native title bar, a drag
  surface exists on EVERY route; `cursor-default`, `select-none`, `preventDefault`
  on the press.
- **Decorative art** — earns its space or is absent; an empty art box takes no
  room. *(124px per screen of glyphs repeating the heading.)*

## Accessibility

- Hints are associated (`aria-describedby`), not merely adjacent.
- Progress is `aria-live="polite"`; a region the poll rebuilds must not
  re-announce unchanged text.
- Selection and disabled state are announced (`aria-checked`,
  `accessibilityState`), not only drawn.
- `focus-visible` ring from `--ring` on every interactive element.
- Decorative means `aria-hidden`.
- Contrast: `muted-foreground` on `card` and `background` clears WCAG AA 4.5:1 —
  computed by the check, not trusted.
- Colour never carries meaning alone.

## When you need something the system lacks

Add the token — with its reason — to every surface's token file in one change,
and let `lint:design` confirm they agree. Do not add a literal at the callsite;
that is the exact move that produced eleven font sizes.

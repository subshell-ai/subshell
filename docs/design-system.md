# Design System

The rules every surface renders by: the SPA (`apps/server/web`), the server
assistant (`apps/server/desktop/ui`), the client node page
(`apps/client/desktop/ui`) and mobile (`apps/client/mobile`). This is the
living reference; the decision record is
`docs/superpowers/specs/2026-09-14-design-system-design.md`, and the check
that enforces it is `bun run lint:design` (`scripts/design-tokens.ts`).

**The one rule:** pick a ROLE, never a number. Sizes, weights and colours are
tokens; a literal outside a token file is refused. Refused by the scanner
specifically means: class literals (`text-[13px]`), CSS `font-size:` /
`font-weight:` outside the assistant's token block, and `fontSize` /
`fontWeight` / hex / oklch in mobile code; not arbitrary `rem` spellings, and
the web stylesheets are exempt by design (the two anti-zoom `font-size: 16px`
rules ride that exemption). And it cannot see the platform default: every
`Text` (mobile) / unclassed node (web) must opt into a role; an element with
no class at all is the one escape.

## Type: five roles, two weights

| role | web | mobile | for |
|---|---|---|---|
| `display` | 30 / 600 | 28 / 600 | one per screen, a frame or page title |
| `heading` | 20 / 600 | 20 / 600 | card, section, dialog and sheet titles |
| `label` | 15 / 600 | 16 / 600 | **line items**: form labels, checklist rows, radio/toggle titles, table headers, buttons, what you scan for |
| `body` | 14 / 400 | 16 / 400 | running text, subtitles, dialog and card prose |
| `detail` | 13 / 400 | 13 / 400 | **the floor, and everything quiet**: what explains a control (its help text, state note, error), plus metadata: chips, timestamps, versions, monospace output. `muted-foreground` by default |

Line-height 1.2 for `display`/`heading`, 1.5 otherwise. Code is `detail` in the
monospace stack.

**There is no 12px.** A `caption` role at 12 was dropped (2026-09-14) as too
small to read; `detail` absorbed it, so quiet text is separated from loud text
by COLOUR and WEIGHT rather than by a third size. `text-xs` and `text-caption`
are refused by `lint:design`, and that refusal is load-bearing, because
Tailwind still generates `.text-xs` from its own defaults even with the token
deleted, leaving `font-size: var(--text-xs)` with nothing behind it.

**Weights are `strong` (600) and `regular` (400), nothing else.** A label is
strong; prose and values are regular; nothing is louder than `display`.

How to say it on each surface:

| surface | size | weight |
|---|---|---|
| SPA, client | `text-label` … `text-detail` (`text-sm` = `body` is the one accepted alias; `text-xs`, `text-caption` and every other Tailwind size are refused) | `font-strong`, or nothing |
| assistant | `font-size: var(--text-label); line-height: var(--text-label--line-height)` | `font-weight: var(--font-weight-strong)` |
| mobile | `...font("label")` | comes with the role |

- `cn()` in the SPA and the client registers the six role utilities as font-sizes; tailwind-merge would otherwise group them with the text-colours and drop one when both are named.
- `font-semibold` remains legal by VALUE (600) but is retired as a NAME; write `font-strong`.

## Colour: Dreamframe, under one set of names

Values: `docs/superpowers/specs/2026-09-03-dreamframe-theme-design.md`. Names,
everywhere: `background`, `card`, `border`, `foreground`, `muted-foreground`,
`primary`, `primary-foreground`, `success`, `warning`, `destructive`. Mobile
uses the same roles in camelCase (`mutedFg`, `primaryFg`) as hex derived from
the web's oklch, and `lint:design` re-derives every compared colour every run. Status colours
never carry meaning alone; pair them with a word, and when the surface is too
small for the word beside the colour, as with the 6px status dot, the word
travels with it as the accessible name and the tooltip's state line instead
(2026-09-24: the dot's colour legend is bright-blinking working, dim idle,
amber waiting, red unreachable, faint exited, hollow ended).

## Spacing, radius, motion, targets

- Spacing on the 4px grid: 4, 8, 12, 16, 24, 32. The check does not enforce the
  grid; the 2026-09-14 audit moved the enumerated values, and a few hand-written
  stragglers remain (assistant 7/9px paddings, wizard `mb-2.5`).
- Radius 8 (`--radius`, `radius`).
- Motion: 150ms for micro-feedback, 220ms for a screen or panel entering; every
  animation inside `prefers-reduced-motion: no-preference`. One-shot animations
  only on elements the poll does not rebuild; a rebuilt element replays its
  animation, which is how a done-mark came to pulse forever. A LOOP is admitted
  for a state that genuinely IS ongoing, on an element that never remounts:
  the input-queue chevrons, the terminal's `StatusPill`, and the working dot's
  blink (2026-09-24) are that admitted shape, and each sits behind the same
  motion gate so a reduced-motion user sees the still state instead.
- Touch targets ≥ 44 where there is touch.

## Patterns

Each rule closed a real defect (spec § 4). A pattern without a reason is not
admitted here.

- **Line item**: `label` over `detail`, differing by weight AND colour, never
  by tone alone. *(15px regular over 13px muted read as one paragraph.)*
- **Quiet label vs control label**: a read-only data row labels over its value
  with the label in `muted-foreground` at `body` size, the `Fact`/`dt` grammar,
  and it takes that size from the list or `<dl>` around it rather than from the
  label itself. `font-strong` label weight belongs to a control's label and to a
  section heading, ONLY. *(A networking card set bold "NetBird FQDN" over its URL
  six pixels above a quiet "Client version" over its: two label grammars in one
  card, so one row read as a heading and the other as data, and neither was the
  control the bold claimed it was.)*
- **Copy length**: an explanation of a UI element is at most two sentences,
  and UI copy uses no em dashes; periods and commas separate clauses. If a control needs more than two sentences, the surplus
  is documentation or a detail disclosure, not help text. *(Operator ruling,
  2026-09-21, after a maintenance toggle carried a four-clause essay and a
  launch-rule card carried five sentences: the paragraph beside a control is
  read ONCE, at the moment of decision; long run-ons teach people to skim
  the whole screen.)*
- **Help text**: everything a control says about itself is `detail`, at ONE
  size: its hint, "set by the environment", a saved-vs-running note, a
  validation error, the same role metadata uses, so a field never mixes sizes.
  `body` is for running text that is not attached to a control. *(One screen explained a toggle at 13 and the field below it at
  12; a plugin's description was 12 in one card and 14 in the other; the
  assistant's `.hint` was 14. Three sizes for one idea, because the table used
  to file "hints" under `body`.)*
- **Tooltip**: the popup carries an arrow pointing back at its control.
  `TooltipContent` draws it by default, and `arrow={false}` is the rare opt-out
  for a surface with no single anchor. A floating box beside a run of elements
  does not say which one is speaking; the arrow is the pointer that names it.
  *(A disabled control's explanation floated over the whole row until it grew
  the tip; the rail's rows needed the same arrow a day earlier. Operator rule,
  2026-09-25.)*
- **Tab group**: a page's tab strip is CONTENT-SIZED (`Segmented fill={false}`),
  never stretched across the container: two tab labels sharing the page's full
  width read as data columns rather than as choices, and the stretch grows the
  dead space with the window. Equal-share fill stays right only for a switch
  INSIDE a bounded row or dialog, where a half-empty pill would read as one
  control plus dead space (2026-09-18), not as a page tab. *(Users page at a
  wide window: "Members" and "Pending approval" each took half the page
  (operator ruling, 2026-09-25).)*
- **Choice group**: radios inside `role="radiogroup"` with an `aria-label`; a
  dependent setting sits BELOW the group after a rule, never indented under one
  option; its dependency is a disabled control that says why and names what
  would answer. *("needs the box above" named a widget.)*
- **Copy affordance**: the copy ICON, at `icon-sm`, never the word "Copy" as a button
  label, and never a caption of its own: what is copied is named by `aria-label`
  (`Copy server address`), and the icon is a `Check` in `text-success` for the 1.5 s the
  confirmation is up (`server address copied`). On a screen holding two of them the name
  is not optional; the buttons are otherwise identical pixels, so the label is the only
  thing that tells an address from a key. *(One act, five affordances: a bordered "Copy"
  on the command rows, "Copied" in the API-key dialog, a named icon in a preset row, an
  unnamed icon in a fact list. The word also repeated the thing the monospace value
  beside it had already said, in the densest rows in the app.)*
- **Long action**: spinner + the process's OWN last line, verbatim + an `m:ss`
  clock. No invented percentage. The footer does not repeat the pane.
  *(Installs sat blind under ten-minute deadlines.)*
- **Failure**: on the thing that failed, as a sentence plus the output behind a
  disclosure; "couldn't run" and "ran and exited N" say which. *(An error under
  a five-row list named none of them.)*
- **Consequential action**: the control states what it executes, on screen,
  without a click. No confirm step unless destructive. *("Install" beside a
  copyable command read as two alternatives.)*
- **Destructive action**: typed consent (the reset's hostname), never a
  checkbox.
- **Step / wizard**: every step shows on every machine, with a done-mark when
  already satisfied; the title names the STEP and stays stable; no auto-advance.
  *(A skipped step jumped the dots 1→3 and killed Back.)*
- **Window chrome (desktop)**: when the shell drops the native title bar, a drag
  surface exists on EVERY route; `cursor-default`, `select-none`, `preventDefault`
  on the press.
- **Decorative art**: earns its space or is absent; an empty art box takes no
  room. *(124px per screen of glyphs repeating the heading.)*
- **Animation**: one-shot animations only on elements the poll does not rebuild.
  *(The done-mark's 160 ms pop replayed forever on every 1.5 s render.)*

## Accessibility

- Hints are associated (`aria-describedby`), not merely adjacent.
- Progress is `aria-live="polite"`; a region the poll rebuilds must not
  re-announce unchanged text.
- Selection and disabled state are announced (`aria-checked`,
  `accessibilityState`), not only drawn.
- `focus-visible` ring from `--ring` on every interactive element.
- Decorative means `aria-hidden`.
- An icon-only control is NAMED (`aria-label`, or `accessibilityLabel` on the native
  surfaces). An icon with no label is not a quiet control, it is an unnamed one.
- Contrast: `muted-foreground` on `card` and `background` clears WCAG AA 4.5:1,
  computed by the check, not trusted.
- Colour never carries meaning alone.

## When you need something the system lacks

Add the token, with its reason, to every surface's token file in one change,
and let `lint:design` confirm they agree. Do not add a literal at the callsite;
that is the exact move that produced eleven font sizes.

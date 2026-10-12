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
| `label` | 15 / 600 | 16 / 600 | **line items**: form labels, checklist rows, radio/toggle titles, buttons, what you scan for |
| `body` | 14 / 400 | 16 / 400 | running text, subtitles, dialog and card prose, table headings and values |
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

- `cn()` in the SPA and the client registers the five role utilities as font-sizes; tailwind-merge would otherwise group them with the text-colours and drop one when both are named.
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

## Dashboard pages and tables

These are the dashboard decisions established on 2026-10-11. They apply to
new pages and changes to existing pages; dated design proposals do not override
this guide.

### Page layout

Use `DashboardPage` for lists, details, personal settings, and server settings,
including their loading and error states. It fills the available content width
with 24px outer padding and 24px between sections. Keep those gutters consistent
as the screen grows; do not impose a narrow maximum width on the page or choose
a different width for each route. Tables should gain useful space on wide
screens while still fitting phones.

Terminal and workspace canvases retain their full-height layouts. Standalone
sign-in and setup screens retain their own frames. A workflow brought into the
dashboard uses the dashboard layout: Backups uses ordinary settings cards,
content-sized Backup/Restore tabs, and actions in the card footer. Do not reuse
the desktop assistant's oversized centered heading or viewport-bottom action
bar inside a dashboard page.

### Card structure and grouping

Every table belongs in the shared `Card`, including a table built with CSS
grid. A containing page card counts; do not nest a second card around its table.
Use the same card header, content spacing, borders, and background across
Nodes, Presets, Prompts, Subshells, Users, and other tabular pages.

When a list is grouped, give each group its own titled card and table. Presets
group by agent; the Subshells table uses its selected grouping. Object group
names may appear as card titles because they identify the listed objects.
Avoid full-width shaded group bands inside the table or a special striped row
style for Subshells. Without grouping, use one card.

Presets, prompts, and prompt stacks use tables. Nodes uses a table without a
tile-view toggle. Subshells can retain its other views; its table follows the
same rules as every other table.

### Type, density, and alignment

Table headings and values use normal body size (`text-sm` in the SPA).
Headings and primary name links use `font-strong`; ordinary values remain
regular. Use sentence-case column headings. Hostnames, versions, timestamps,
and other secondary values use muted colour, not a smaller font.

Use `h-8 py-0` for ordinary cells, aiming for compact 32px rows. Check the
height of the controls inside each cell too: a tall name button or menu trigger
can undo zero cell padding. Let wrapped content, expanded details, and touch
target requirements increase height when necessary; do not shrink the text.

Header and row selection checkboxes share one column width, horizontal inset,
and vertical alignment. A group's select-all checkbox selects only that
group's rows and preserves selections in other groups. It shows checked or
indeterminate state from that group's actual selection.

### Responsive columns

Use the card's available width, through container queries, to choose which
columns fit. Keep the name and row actions visible. Hide secondary metadata
progressively on small screens, and reveal it again as the card widens. Match
every header's visibility to its cells. For users, an email can move beneath
the name when its column is hidden; management actions must remain reachable.

When metadata columns are visible, give the name roughly one third of the
table instead of letting it consume all remaining space. Fit the actions
column to its controls. Truncate long names and metadata rather than letting
them push the page wider; make the complete value available through the
appropriate detail or disclosure. Keep any necessary horizontal scrolling
inside the card, never on the whole page.

### Values and interactions

Give independent behaviours separate columns. Presets show Auto-restart and
Cross-agent use separately. Boolean values, including sharing, use **Yes** or
**No** consistently. Show plain text for provider, role, permissions, and
routine states, following the field-value rule below; do not turn them into
badges. Use an absence mark when a value does not apply: the server's local
node has no remote heartbeat, so its Seen cell must not claim "never". Relative
time labels must read naturally: "just now", never "just now ago".

Clicking a name inspects the item. Node and subshell names link to their detail
pages. Preset names expand their commands; prompt names expand their text;
prompt-stack names expand their members. Use a consistent name button and
chevron for disclosures, with `aria-expanded` and an associated content region.
Expanded table content stays in a detail row spanning the columns. Edit stays
in the action menu. Command copying uses the shared copy affordance.

Row action menus and context menus put destructive actions last, after one
divider when ordinary actions precede them. Restart and Close belong in that
last group. Keep the relative ordering within each group. Presentation changes
must preserve permissions: hiding a column or removing a badge must not hide an
otherwise available management action or grant a new one.

### Configuration dialogs

For sign-in providers, the table summarizes Enabled, Sign-in, Registration,
and Approval with Yes/No values. Configure in the row action menu opens the
switches in a dialog. Each switch has a clear label and a short explanation of
what it changes, its dependencies, and its effect on existing accounts. Keep
the old automatic-registration-closure sentence out of the table.

The dialog states that changes save immediately. Save one field at a time,
show failures in the dialog, and retain the server's values on failure. Apply
the save response to the shared state before releasing controls; a slow or
failed follow-up read must not leave stale values or safeguards active. During
a save, prevent conflicting changes and premature dismissal. Done closes the
dialog; it is not a second save step.

Turning Enabled off disables the dependent switches without changing their
saved checked states. Re-enabling makes those settings available again,
subject to the existing safeguards. Explain disabled controls visibly and on
keyboard focus or hover so touch users can discover the reason too.

Moving controls must preserve business rules. The final enabled provider with
sign-in allowed cannot have Enabled or Sign-in turned off. Keep inherited
registration behaviour, server-side enforcement, and refreshed safeguards after
each change. The built-in E-mail provider has Configure, but no credential
editor or Remove action. Editing another provider's credentials must not
silently overwrite the flags managed by Configure. Implementation details live
in [the account and login notes](../apps/server/web/docs/settings-account-login.md).

### Review at small and large widths

Check both phones and wide desktop screens, including 320px and a screen wider
than 1440px. Verify aligned page gutters, readable type, compact rows, matched
header/cell visibility, reachable actions, expanded content, and long names.
Check empty, loading, and error states as well as populated tables. A layout
must not look correct only with short sample names or one row.

## Patterns

Each rule closed a real defect (spec § 4). A pattern without a reason is not
admitted here.

- **Field values**: use plain body text for roles, providers, modes, capabilities,
  ownership, permissions, and routine state values. Do not wrap them in badges.
  Warning text can retain its semantic colour. Reserve badges for compact
  counts and actionable warnings, not ordinary label/value pairs.
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
- **Copy voice**: follow [the repository's writing voice](../AGENTS.md#writing-voice).
  Speak to the reader as a peer. Use active verbs, natural contractions, and
  varied sentence structure. State what's happening and, when there's a useful
  next step, explain it. For example: "The server doesn't support this machine's
  Subshell daemon version. You can still update it from here." Keep warnings
  explicit and technical details accurate. Read messages aloud during review.
- **Copy length**: aim for one or two short sentences. Use more when needed to
  explain consequences, timing, or limits clearly; don't hide a warning in
  documentation or pack it into a run-on sentence to meet a quota. Move
  optional background into documentation or a disclosure. UI copy uses no em
  dashes. An absence placeholder in a table isn't prose.
- **Help text**: every INLINE explanation a control gives about itself is
  `detail`, at ONE size: its hint, "set by the environment", a saved-vs-running
  note, a validation error, the same role metadata uses, so a field never mixes
  sizes. A tooltip popup is the floating-surface exception and carries `body`;
  see **Tooltip**.
  `body` is for running text that is not attached to a control. *(One screen explained a toggle at 13 and the field below it at
  12; a plugin's description was 12 in one card and 14 in the other; the
  assistant's `.hint` was 14. Three sizes for one idea, because the table used
  to file "hints" under `body`.)*
- **Required input**: a gold `*` (`RequiredMark`) stands beside every
  REQUIRED label at rest, and the submit is disabled until the one schema is
  satisfied. When the caret LEAVES a field still empty, the sentence appears
  under it in the same gold. Gold means "nothing typed yet".
  *(The disabled button was honest but silent: an untouched dialog said
  nothing about what it demanded, and a live-tester dismissed a half-filled
  preset deciding the form "didn't want the name". Operator ruling,
  2026-09-30.)*
- **Hard error**: a value validation REFUSES (too long, mismatched, over a
  cap), the server's refusal of the submit, and a load failure all stay
  `text-destructive` red, rendered on the thing that failed. Red means "what
  you typed is wrong"; a zod issue tagged `gap: true` means the opposite and
  wears the gold instead, and `fieldErrorToned` is the reader a slot that can
  hold both uses. *(An hour of one-tone experiments settled the split: gold
  for everything read as alarm on unfilled fields; red for everything hid
  which fields still needed typing.)*
- **Service restrictions and prerequisites**: use gold (`text-warning`) for
  visible explanations of unavailable actions, such as owner-only permissions,
  missing supervision, or a version required to change a setting. Keep routine
  status and optional setup instructions neutral. Failed actions and load
  errors stay red (`text-destructive`); a restriction is not a failed action.
- **Titles and confirmations**: keep titles short and fixed. Name the action
  ("Insert this prompt?", "Close this subshell?", "Generate a new setup key?")
  and put variable details in the body: names, counts, versions, addresses,
  and package identifiers. Use the same approach for cards and action headings;
  object names still belong in lists and detail fields. Long names shouldn't
  change the heading's layout. Name-length limits and older specifications
  don't create exceptions.
  The body identifies the target and explains what happens, when it happens,
  and any relevant limits or permanent loss. Use an explicit action label,
  such as "Close subshell" or "Revoke key". Distinguish preparing an action
  from performing it, and an attempted operation from a guaranteed result.
  See [the content guide](../apps/docs/STYLE.md#product-copy-and-confirmations)
  for examples.
- **Tooltip**: popup text uses `body`, including disabled explanations, so it
  stays readable in the floating surface. Inline control hints use `detail`.
  The popup carries an arrow pointing back at its control.
  `TooltipContent` draws it by default, and `arrow={false}` is the rare opt-out
  for a surface with no single anchor. A floating box beside a run of elements
  does not say which one is speaking; the arrow is the pointer that names it.
  *(A disabled control's explanation floated over the whole row until it grew
  the tip; the rail's rows needed the same arrow a day earlier. Operator rule,
  2026-09-25.)*
- **Disabled buttons**: explain every disabled state in a tooltip. State the
  actual blocker and a useful next step, such as "Only the node owner can
  change sharing for this node." or "Choose a working directory first."
  Pass `disabledReason` to `Button` (or `ExplainedButton` for a control with
  its own layout). Keep the explanation available on hover and keyboard
  focus, associate it with the control for screen readers, and block pointer,
  keyboard, and form activation. Don't rely on a native `title` or a wrapper
  that changes the control's layout. Use existing form validation messages
  for missing or invalid input, and update the reason when the blocker changes.
  Keep owner-only restrictions visible beside the controls in gold
  (`text-warning`), including directory rules and stopping or uninstalling a
  node service. On touch-only surfaces, keep the reason visible or available
  on tap; hover mustn't be the only way to discover it.
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
- **Action menus**: group destructive actions at the bottom, after one divider
  when ordinary actions are also present. Keep their relative order within
  each group, including in right-click menus.
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

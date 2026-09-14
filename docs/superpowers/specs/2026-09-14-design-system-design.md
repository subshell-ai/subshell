# Design System — one vocabulary for four surfaces

**Date:** 2026-09-14 · **Status:** approved (operator, brainstorm 2026-09-14) · **Author:** Theo + Claude
**Companion to:** `2026-09-03-dreamframe-theme-design.md` (colour — unchanged by this spec, referenced by it),
`2026-09-11-first-run-second-pass-design.md` § 3 (the assistant frame, whose size this spec's predecessor
cut to 720×620 on 2026-09-14).

**Produces:** `docs/design-system.md` (the living reference), `scripts/design-tokens.ts` (the check),
`.claude/rules/design-system.md` (the pointer agents load). This file is the decision record and is not
revised; the reference is.

## 1. The problem, measured

Four surfaces render one product — the SPA (`apps/server/web`), the server assistant
(`apps/server/desktop/ui`), the client node page (`apps/client/desktop/ui`) and mobile
(`apps/client/mobile`) — and on 2026-09-14 a first-run pass corrected the same class of defect on
them one row at a time: a label that blended into its caption, two surfaces asking one question at
two sizes, a link a point smaller and a tone greyer than the rows above it. Each fix was right and
none of them prevented the next. The inventory that day:

| surface | distinct font sizes | source of truth for colour | pinned by test |
|---|---|---|---|
| SPA | `text-sm` ×195, `text-xs` ×147, plus **7 arbitrary** `text-[…px]` (10, 11, 11.5, 12, 13, 15, 30) | Dreamframe tokens in `styles.css` (53) | no |
| assistant | **11** (12, 12.5, 13, 13.5, 14, 14.5, 15, 19, 20, 21, 30) | its own `--color-fg/-line/-ok…` — same values, third vocabulary | no |
| client node page | `text-xs` ×28, `text-sm` ×12, 3 arbitrary | the SPA block "COPIED VERBATIM" | **no** — the only test touching the file is about CSP |
| mobile | **8** (11, 12, 13, 14, 16, 17, 26, 28) | `tokens.ts`, "the dark-only port of the web `styles.css`" | no |

Two facts from that table are the argument for the whole spec:

- **`12.5`, `13.5`, `14.5`** are what a stylesheet looks like when every size is a local judgement.
  Nobody chose a half-pixel scale; eleven people each chose the size that looked right beside the
  thing they were building.
- **Mobile's palette is the one Dreamframe replaced.** `tokens.ts` says it mirrors the web; its ground
  is `#0a0a0a` and its primary `#7abdff` (blue, hue 250°). The web moved to `#1d182a` and orchid
  322° on 2026-09-03. A comment claiming sync is what a silent drift looks like from the outside,
  and the client's "COPIED VERBATIM" block has the same shape with the same absence of a test.

The design standard therefore has to live in **code that refuses**, with the document explaining
what the code refuses and why. A document alone is how the table above came to exist.

## 2. Decisions

Four, taken in the brainstorm, in dependency order.

1. **Scope: all four surfaces.** Mobile is React Native and cannot share CSS, which is a reason to
   design the vocabulary so it *can* be shared, not a reason to leave the surface out. Its palette
   drift is the strongest single case for inclusion.
2. **Enforcement: tokens in code, plus a lint that fails.** Discouraging arbitrary values relies on
   review; the eleven sizes were all reviewed. See § 6.
3. **Mobile: the same ROLES at platform-native sizes.** iOS body text is 17pt; a 14px `body` on a
   phone reads as a web page in a wrapper. The cross-surface check asserts the role set and the
   weight rules agree everywhere, and the sizes agree across the three web surfaces; mobile's sizes
   are its own column of the same table.
4. **Source of truth: per-surface token files bound by one test — first.** A shared
   `packages/design-tokens` is the cleaner end state and is the named follow-on (§ 8). It is not
   the first step because it is a new workspace, a build-order change in four apps and a rename of
   every assistant `--color-*` reference in one motion. With the role names identical across the
   four files, extracting them later is a move, not a redesign — which is also what the client's
   own "should be a straight move" comment predicted for its verbatim copy, and would have been
   true if a test had held the two together.

## 3. The vocabulary

### 3.1 Type — six roles

| role | web (px / weight) | mobile (pt / weight) | for |
|---|---|---|---|
| `display` | 30 / 600 | 28 / 600 | one per screen: the assistant frame title, the setup titles |
| `heading` | 20 / 600 | 20 / 600 | card and section headings (collapses the assistant's 19, 20, 21) |
| `label` | 15 / 600 | 16 / 600 | **line items** — form labels, checklist rows, radio titles, toggles: the short string you scan for |
| `body` | 14 / 400 | 16 / 400 | running text, hints, subtitles (the SPA's `text-sm` ×195 already lives here) |
| `detail` | 13 / 400 | 13 / 400 | the explanation under a `label`; `muted-foreground` by default |
| `caption` | 12 / 400 | 12 / 400 | chips, timestamps, mono output (the SPA's `text-xs` ×147) |

Code is `caption`-sized in the monospace stack. Line heights: `display`/`heading` 1.2, everything
else 1.5.

**Two weights, not three.** `display`, `heading` and `label` are 600; everything else is 400. The SPA
carries 43 `font-medium` (500), 9 `font-semibold`, 2 `font-bold`; the assistant has only 400 and 600
and proved it enough. Weight 500 is how "is this emphasised?" becomes a per-callsite judgement, and
each of the 43 resolves to a role during the audit (§ 7 phase 3). `font-bold` is not a role;
nothing in the product is louder than `display`.

**Two web calls made explicit** because they move real pixels: the assistant's 15px paragraphs
(`.assistant-subtitle`, `.hint` at 14/15) become `body` at 14 — one point down — rather than the
SPA's 195 `text-sm` usages moving up one; and `label` sits ABOVE `body` by a point, which is the
normal shape of a dense application UI (a scannable label slightly larger and heavier than the
prose beside it) rather than an error to be smoothed.

### 3.2 Colour — one set of names

The values are Dreamframe's (`2026-09-03-dreamframe-theme-design.md`) and this spec does not
change a single one. What changes is that **the shadcn names are the names everywhere**:

| assistant today | everywhere after |
|---|---|
| `--color-bg` | `--background` |
| `--color-card` | `--card` |
| `--color-line` | `--border` |
| `--color-fg` | `--foreground` |
| `--color-muted` | `--muted-foreground` |
| `--color-primary` / `--color-primary-fg` | `--primary` / `--primary-foreground` |
| `--color-ok` / `--color-warn` / `--color-bad` | `--success` / `--warning` / `--destructive` |

So a rule reads the same in all three CSS files, and the check can compare them by name. Mobile's
`tokens.ts` keeps its camelCase keys (`mutedFg`, `destructive`) — they are the same roles in a
language without hyphens — and is **re-derived from Dreamframe's oklch values** using the
OKLab→sRGB conversion its own header already documents. The status trio (`success`, `warning`,
`destructive`) keeps its unretinted semantics, as Dreamframe ruled.

### 3.3 Spacing, radius, motion, targets

- **Spacing: the 4px grid** Tailwind already gives the SPA, made explicit — 4, 8, 12, 16, 24, 32. The
  assistant's hand-written `14px` gaps and `28px` margins move onto it (16 and 24 or 32; decided
  per site in the audit, recorded in the reference).
- **Radius: 8**, already `--radius: 8px` on every surface and `radius = 8` in mobile.
- **Motion: two durations** — 150ms for micro-feedback, 220ms for a screen or panel entering — and
  every animation inside `prefers-reduced-motion: no-preference`, which the assistant already does.
- **Touch targets ≥ 44** on touch surfaces; mobile already pins `touchTarget = 44`, the SPA's key bar
  is `min-h-11`.

## 4. Component patterns

Each pattern below closed a defect found on 2026-09-14. They are written as rules so the defect stops
being rediscovered; the reference (`docs/design-system.md`) carries them with the reason, and a
pattern without a reason is not admitted.

| pattern | rule | the defect it closes |
|---|---|---|
| **Line item** | `label` over `detail`; the two differ by weight AND colour, never by tone alone | 15px regular over 13px muted read as one paragraph, and the scannable half receded |
| **Choice group** | radios inside `role="radiogroup"` with `aria-label`; a dependent setting sits BELOW the group after a rule, never indented under one option; the dependency is a disabled control that says why and names what would answer | "needs the box above" named a widget; two checkboxes both starting "Start it…" read as one axis |
| **Long action** | spinner + the process's OWN last line, verbatim + an `m:ss` clock; no invented percentage; the footer does not repeat the pane | `brew install` and `curl … \| bash` sat blind under 10-minute deadlines; "Installing…" said twice |
| **Failure** | rendered ON the thing that failed, as a sentence plus the output behind a disclosure; the two kinds — "couldn't run" and "ran and exited N" — say which | an error under a five-row list named none of them, output collapsed under "Installer output" |
| **Consequential action** | the control states what it executes, on screen, without a click; no confirm step unless the act is destructive | "Install" beside a copyable command read as two alternatives, for an act that runs a vendor's script as the server's user |
| **Destructive action** | typed consent — the reset's hostname — never a checkbox | the existing rule, written down |
| **Step / wizard** | every step shows on every machine, with a done-mark when already satisfied; the title names the STEP and stays stable, the content says whether to act; no auto-advance | the tmux step vanished, dots jumped 1→3, Back was dead, "tmux Is Ready" asked "then why am I here?" |
| **Window chrome (desktop)** | when the shell drops the native title bar, a drag surface exists on EVERY route; `cursor-default`, `select-none`, `preventDefault` on the press | `/login` and `/setup` could not be dragged; the strip showed an I-beam |
| **Decorative art** | earns its space or is absent; an empty art box takes NO room | 124px per screen of glyphs repeating the heading beneath them |
| **Animation** | one-shot animations only on elements the poll does not rebuild; otherwise none | the done-mark's 160ms pop replayed on every 1.5s render, forever |

## 5. Accessibility

Codifying what is already partly in use (SPA + assistant, 2026-09-14: `aria-live` ×8,
`aria-describedby` ×7, `focus-visible` ×14, `prefers-reduced-motion` ×6, `role="radiogroup"` ×1):

- **Hints are associated, not adjacent:** `aria-describedby` from the control to its hint. Visual
  reading order is not an association.
- **Progress is announced:** the long-action line is `aria-live="polite"`. A region the poll rebuilds
  must not re-announce unchanged text — the assistant's `title`/`subtitle` guard is the pattern.
- **State is announced, not just drawn:** `aria-checked` / `accessibilityState={{ selected, disabled }}`
  wherever border colour and opacity are the visual cue.
- **Focus is visible:** `focus-visible` ring from `--ring` on every interactive element.
- **Decorative means hidden:** `aria-hidden` on art, glyphs, drag strips.
- **Contrast is computed, not trusted:** `detail` (`muted-foreground`) on `card` and on `background`
  must clear WCAG AA 4.5:1; the check derives it from the tokens (§ 6).
- **Colour never carries meaning alone:** the status chips already pair colour with a word; that is
  the rule.
- **Targets ≥ 44** on touch surfaces.

## 6. Enforcement

### 6.1 Token files — one per surface, identical role names

- **SPA** `apps/server/web/src/styles.css`: the `@theme` block gains `--text-display`,
  `--text-heading`, `--text-label`, `--text-body`, `--text-detail`, `--text-caption` (each with its
  line-height) and `--font-weight-strong: 600` / `--font-weight-regular: 400`. Tailwind v4 generates
  `text-label`, `text-detail`… from `--text-*` in `@theme`, so the utilities come for free.
- **Client node page** `apps/client/desktop/ui/src/styles.css`: the SAME token section, byte-equal,
  and the check says so (§ 6.2). The comment "COPIED VERBATIM" becomes true by test rather than by
  assertion.
- **Assistant** `apps/server/desktop/ui/src/styles.css`: the same custom-property names in its
  `@layer base` token block — type roles added, colour names renamed per § 3.2. Its ~100
  `var(--color-*)` references are renamed in the audit (§ 7 phase 2), a mechanical replace with
  the rename table as the map.
- **Mobile** `apps/client/mobile/src/lib/tokens.ts`: a `type` export with the six roles at the
  mobile column's sizes and weights; `colors` re-derived from Dreamframe.

### 6.2 The check — `scripts/design-tokens.ts`, `bun run lint:design`

The same shape as `scripts/license-fields.ts`: a bun script, run by `lint.yml` and pre-push, because
none of this is a type error, a lint error or a test failure. Three jobs:

1. **Agreement.** Parse the four token sources. The role set is identical in all four; the weights
   are identical in all four; the sizes are identical across the three web files (mobile's are its
   own column and are asserted present, not equal). The client's token section is byte-equal to the
   SPA's.
2. **Escapes.** Fail on any of: `text-[…px]` or `text-(base|lg|xl|2xl|3xl)` in the SPA or client
   (`text-sm` and `text-xs` are accepted ALIASES — Tailwind's 14 and 12 are `body` and `caption` by
   coincidence, and defining them so in `@theme` makes the alias exact rather than migrating 342
   callsites for no visible change); `font-size: Npx` in the assistant outside its token block;
   `fontSize: N` in mobile outside `tokens.ts`; a raw `#hex` or `oklch(` outside any token block on
   any surface. Each finding names the file, line and the role to use instead.
3. **Contrast.** Convert the oklch tokens to sRGB (the conversion mobile's header already
   describes) and compute WCAG contrast for `muted-foreground` on `card` and on `background`;
   fail under 4.5:1. The palette is then checked every time someone touches it, rather than once
   when it was approved.

`--report` prints without failing, which is how phases 1–4 run; phase 5 removes the flag from CI.

### 6.3 Where agents learn it

`.claude/rules/design-system.md` is a short pointer to `docs/design-system.md` with the six roles and
the "check before you pick a size" rule inline, so it loads into every session the way
`security-context.md` does. Each app's `AGENTS.md` gains one line naming the reference and the
check.

## 7. Rollout — five phases, each shippable alone

1. **Tokens + check, reporting.** Add the six roles to all four token files (values only; nothing
   consumes them yet), write `scripts/design-tokens.ts`, wire `lint:design --report` into `lint.yml`.
   Commit the baseline the report prints — the inventory in § 1, made exact.
2. **Assistant to green.** 11 sizes → 6 roles; `--color-*` → shadcn names; 14/28px → the 4px grid;
   `label`/`.label` consolidation is already done. The assistant first because it has the worst
   drift and the smallest surface (~1,200 lines of CSS, one page).
3. **SPA + client to green.** The 7 arbitrary sizes → roles; 43 `font-medium` resolved to 400 or
   600 each; `text-base/lg/xl/2xl` → roles; the client's token section made byte-equal and the
   verbatim-copy test added.
4. **Mobile to green.** Palette re-derived from Dreamframe; 8 sizes → the mobile column; escapes
   moved into `tokens.ts`. Its `AGENTS.md` mirror section extended from behaviour to tokens.
5. **Flip and document.** Remove `--report` from CI; write `docs/design-system.md` from the
   now-true state (not from this spec — from what the code enforces); add
   `.claude/rules/design-system.md`; one line in each app `AGENTS.md`.

Phases 2–4 each end with the check green for that surface under `--report --only=<surface>`, so a
surface can land without waiting on the others.

## 8. Follow-on, named and out of scope

**`packages/design-tokens`** — one Apache workspace exporting `tokens.css` and `tokens.ts` from one
definition; the four files become four imports and § 6.2's agreement check becomes unnecessary
because there is nothing to disagree. It is out of scope here for the reasons in § 2.4, and in
scope the moment § 7 is done, because the names will already match. The client's verbatim copy and
mobile's port both said "extract later"; the difference this time is that a test holds the copies
together until then.

## 9. Rejected

- **Document only, apply by hand.** The eleven sizes were all reviewed by hand.
- **One numeric scale on every surface including mobile.** 14px body on a phone reads as a web page
  in a wrapper; the roles are the shared thing, not the pixels.
- **Migrating `text-sm`/`text-xs` to role utilities.** 342 callsites for no visible change;
  defining the aliases exactly in `@theme` achieves the same guarantee.
- **A confirm step on every consequential action.** The tmux install runs on one press with a note;
  one product does not ask twice for the same kind of act. Confirmation is for destruction.
- **The shared package first.** Right destination, wrong first step (§ 2.4).

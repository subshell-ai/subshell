# Dreamframe — UI Theme (Castorice palette)

**Date:** 2026-09-03 · **Status:** implemented, approved in the live app
**Companion to:** `2026-09-02-subshell-branding-design.md` (whose §1.1 explicitly deferred
this move — "brand palette as canonical if/when the UI accent moves to purple". It moved.)

## Decisions (operator, visual iteration 2026-09-02/03)

- **Direction:** "Dreamframe" — violet-veined void surfaces, frost-lavender text, orchid
  accent; Castorice's hue family ≈ 312–340°, deliberately *not* Slack's cool aubergine
  (mid-grey, blue-leaning). Warmth/extremes over mud.
- **Rejected along the way:** a bright-gradient primary button and bright-gradient edit
  badge (too loud), ghost/outline buttons (read as unstyled), outlined primary buttons.

## Token map (`apps/frontend/src/styles.css`)

| Token | Value |
|---|---|
| `--background` | `oklch(0.13 0.045 318)` |
| `--foreground` / card / popover fg | `oklch(0.92 0.03 312)` frost |
| `--card` / `--popover` | `oklch(0.175 0.05 318)` |
| `--primary` / `--ring` | `oklch(0.75 0.17 322)` orchid / `oklch(0.62 0.13 322)` |
| `--primary-foreground` | `oklch(0.16 0.05 322)` |
| `--secondary` / `--muted` | `oklch(0.23 0.05 318)` |
| `--accent` | `oklch(0.3 0.06 318)` |
| `--border` / `--input` | `oklch(0.32 0.06 318)` |
| `--success` / `--warning` / `--destructive` | **unchanged semantics** |
| terminal strip / canvas / tab | `#1d1230` / `#150c24` / `#26173d` |

`--primary` intentionally stays **bright** — links, focus rings, the active-tab underline
(`border-primary`), switch tracks and hover glows ride it. Quietness is applied at the
component level instead:

- **Primary buttons** (`ui/button.tsx` default variant): sunk plum gradient
  `135° oklch(0.34 0.10 322) → oklch(0.40 0.10 340)`, frost text, no outline; hover blooms
  one step brighter. (Gradients can't ride a color token, so they live in the component.)
- **Selected sidebar nav** (`app-sidebar.tsx`): `90°` plum→rose band, same family.
- **Share levels** (`sharing-dialog-core.tsx`, decision "N2"): `View + edit` = lit plum
  chip; `View` = bare muted text — contrast by presence, not hue.
- **Sidebar brand block**: no bottom border; wordmark renders at 28px (`h-7`).

## What deliberately stays neutral

- xterm `foreground` `#e4e4e7` — code output outranks theme tint.
- Transcript/status semantics (success/warning/destructive) — never retinted.
- Brand PNG assets (locked pipeline in `brand/`).

## Out of scope

Mobile app (`apps/mobile`) theme still uses its own palette; porting Dreamframe there is a
separate follow-up if desired.

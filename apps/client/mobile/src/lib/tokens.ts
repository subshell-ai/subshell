/**
 * Design tokens — mobile's column of the design system
 * (`docs/design-system.md`; spec 2026-09-14).
 *
 * **Colours are Dreamframe's** (spec 2026-09-03), converted to hex because
 * native colour parsing cannot be assumed to speak oklch(). Each value names
 * the oklch it was converted from, and `bun run lint:design` re-derives every
 * one and fails if this file is more than one 8-bit step away — because the
 * previous version of this file said the same thing in its header and was a
 * whole palette behind (black ground, blue primary) when checked.
 *
 * **Type is the same six ROLES as the web at platform-native sizes** (spec
 * § 3.1, mobile column): iOS body is 17pt, and a 14px `body` on a phone reads
 * as a web page in a wrapper. Roles and weights are shared; the sizes are this
 * column. Consume through `font()`, never a literal `fontSize:` — the check
 * refuses those outside this file.
 */
export const colors = {
  /** App background — web `--background: oklch(0.224 0.035 296)`. */
  bg: "#1d182a",
  /** Raised surfaces: cards, sheets, bars — web `--card: oklch(0.255 0.032 296)`. */
  card: "#242031",
  /** Hairlines and inputs — web `--border: oklch(0.33 0.035 296)`. */
  border: "#373246",
  /** Primary text — web `--foreground: oklch(0.92 0.03 312)`. */
  fg: "#ebdff3",
  /** Secondary text — web `--muted-foreground: oklch(0.74 0.04 310)`. */
  mutedFg: "#b3a4be",
  /** Pressed/selected fill — web `--accent: oklch(0.33 0.04 296)`. */
  accent: "#373148",
  /** Brand/action colour — web `--primary: oklch(0.75 0.17 322)` (orchid). */
  primary: "#df86ed",
  /** Text on a primary fill — web `--primary-foreground: oklch(0.16 0.05 322)`. */
  primaryFg: "#17051a",
  /** Started/alive — web `--success: oklch(0.765 0.177 163.223)`. */
  success: "#00d492",
  /** THE "waiting for you" colour — web `--warning: oklch(0.828 0.189 84.429)`. */
  warning: "#ffb900",
  /** Terminate/delete — web `--destructive: oklch(0.65 0.2 25)`. */
  destructive: "#f14d4c",
  /** Terminal chrome: shell bg — web `--terminal-strip` (already hex there). */
  termBg: "#221c32",
  /** Terminal canvas — web `--terminal-canvas`. */
  termCanvas: "#181226",
  /** Terminal ink — xterm theme.foreground; no CSS token, not compared. */
  termFg: "#e4e4e7",
} as const;

/** Corner radius, mirroring the web `--radius: 8px`. */
export const radius = 8;

/** Minimum interactive size (Apple HIG / the web key bar's `min-h-11`). */
export const touchTarget = 44;

export type TypeRole = "display" | "heading" | "label" | "body" | "detail" | "caption";

/** React Native wants `fontWeight` as a string. Two weights only. */
type Weight = "400" | "600";

/** Spec § 3.1, mobile column. `lineHeight` is unitless here; `font()` multiplies it out. */
export const type: Record<TypeRole, { size: number; lineHeight: number; weight: Weight }> = {
  display: { size: 28, lineHeight: 1.2, weight: "600" },
  heading: { size: 20, lineHeight: 1.2, weight: "600" },
  label: { size: 16, lineHeight: 1.5, weight: "600" },
  body: { size: 16, lineHeight: 1.5, weight: "400" },
  detail: { size: 13, lineHeight: 1.5, weight: "400" },
  caption: { size: 12, lineHeight: 1.5, weight: "400" },
};

/**
 * The style fragment for one role — spread it into a `style` object:
 * `style={{ ...font("label"), color: colors.fg }}`. React Native's
 * `lineHeight` is in points, not a multiplier, so it is resolved here.
 */
export function font(role: TypeRole): { fontSize: number; lineHeight: number; fontWeight: Weight } {
  const t = type[role];
  return { fontSize: t.size, lineHeight: Math.round(t.size * t.lineHeight), fontWeight: t.weight };
}

/**
 * Design tokens — the dark-only port of `apps/frontend/src/styles.css`.
 * The web app's oklch() values are converted to hex (OKLab→linear-sRGB→sRGB,
 * anchor-checked against CSS red) because native colour parsing cannot be
 * assumed to speak oklch(); the terminal trio is hex at the source.
 * There is deliberately no light mode (spec §Out of scope).
 */
export const colors = {
  /** App background (web `--background`). */
  bg: "#0a0a0a",
  /** Raised surfaces: cards, sheets, bars (web `--card`). */
  card: "#121212",
  /** Hairlines and inputs (web `--border`). */
  border: "#2a2e33",
  /** Primary text (web `--foreground`). */
  fg: "#fafafa",
  /** Secondary text (web `--muted-foreground`). */
  mutedFg: "#8b9095",
  /** Pressed/selected fill (web `--accent`). */
  accent: "#262f38",
  /** Brand/action colour (web primary `oklch(0.78 0.12 250)`). */
  primary: "#7abdff",
  /** Started/alive — emerald-400. */
  success: "#34d399",
  /** THE "waiting for you" colour — amber-400, matches the web chip. */
  warning: "#fbbf24",
  /** Terminate/delete (`oklch(0.65 0.2 25)`). */
  destructive: "#f14d4c",
  /** Terminal chrome (spec §Layout): shell bg. */
  termBg: "#0f1216",
  /** Terminal canvas — xterm theme.background. */
  termCanvas: "#0a0c0f",
  /** Terminal ink — xterm theme.foreground. */
  termFg: "#e4e4e7",
} as const;

/** Corner radius, mirroring the web `--radius: 8px`. */
export const radius = 8;

/** Minimum interactive size (Apple HIG / the web key bar's `min-h-11`). */
export const touchTarget = 44;

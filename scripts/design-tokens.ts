#!/usr/bin/env bun
/**
 * `bun run lint:design` — the design system's one arbiter.
 *
 * Four surfaces render one product and each keeps its tokens in its own
 * mechanism (Tailwind `@theme` in the SPA and client, plain custom properties
 * in the assistant, `tokens.ts` in mobile). This script is what holds them
 * together: it reads all four, asserts they declare the same roles at the
 * agreed sizes and weights, refuses the escapes that made the drift
 * (`text-[14.5px]`, `font-size: 13.5px`, `fontSize: 17`), and computes the
 * palette's contrast rather than trusting the day it was approved.
 *
 * Same shape as `license-fields.ts`, for the same reason: none of this is a
 * type error, a lint error or a test failure, so nothing else would see it.
 *
 *   bun scripts/design-tokens.ts             # fail on any problem
 *   bun scripts/design-tokens.ts --report    # print every problem, exit 0
 *   bun scripts/design-tokens.ts --only=spa  # one surface (spa|client|assistant|mobile)
 *
 * Spec: docs/superpowers/specs/2026-09-14-design-system-design.md § 6.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TYPE_ROLES = ["display", "heading", "label", "body", "detail", "caption"] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];

export interface TypeStep {
  /** px on the web, pt on mobile */
  size: number;
  /** unitless */
  lineHeight: number;
  weight: 400 | 600;
}

/** Spec § 3.1, web column. */
export const WEB_SCALE: Record<TypeRole, TypeStep> = {
  display: { size: 30, lineHeight: 1.2, weight: 600 },
  heading: { size: 20, lineHeight: 1.2, weight: 600 },
  label: { size: 15, lineHeight: 1.5, weight: 600 },
  body: { size: 14, lineHeight: 1.5, weight: 400 },
  detail: { size: 13, lineHeight: 1.5, weight: 400 },
  caption: { size: 12, lineHeight: 1.5, weight: 400 },
};

/** Spec § 3.1, mobile column: the same roles and weights, platform-native sizes. */
export const MOBILE_SCALE: Record<TypeRole, TypeStep> = {
  display: { size: 28, lineHeight: 1.2, weight: 600 },
  heading: { size: 20, lineHeight: 1.2, weight: 600 },
  label: { size: 16, lineHeight: 1.5, weight: 600 },
  body: { size: 16, lineHeight: 1.5, weight: 400 },
  detail: { size: 13, lineHeight: 1.5, weight: 400 },
  caption: { size: 12, lineHeight: 1.5, weight: 400 },
};

/** Spec § 3.2: the shadcn names, everywhere. */
export const COLOR_ROLES = [
  "background",
  "card",
  "border",
  "foreground",
  "muted-foreground",
  "primary",
  "primary-foreground",
  "success",
  "warning",
  "destructive",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export interface CssTokens {
  text: Partial<Record<TypeRole, { size: number; lineHeight?: number }>>;
  weights: { strong?: number; regular?: number };
  /** Every `--name: value` that is not a type token and not a `var()` alias. */
  colors: Record<string, string>;
}

const DECL = /^\s*--([a-z][a-z0-9-]*)\s*:\s*([^;]+);/;

/**
 * Reads the token declarations out of a stylesheet.
 *
 * A LINE scanner, not a CSS parser: every token file in this repo writes one
 * declaration per line, and a parser would be a dependency for a format
 * nobody uses here. It reads declarations from ANY block, so the SPA's
 * `:root, .dark {}` + `@theme inline {}` and the assistant's bare `:root {}`
 * both work. `--color-*: var(--x)` lines are Tailwind aliases of the real
 * tokens and are skipped so a colour is not counted twice.
 */
export function parseCssTokens(css: string): CssTokens {
  const out: CssTokens = { text: {}, weights: {}, colors: {} };
  for (const raw of css.split("\n")) {
    const line = raw.replace(/\/\*.*?\*\//g, "");
    const m = DECL.exec(line);
    if (!m) continue;
    const [, name, valueRaw] = m;
    const value = valueRaw.trim();
    if (value.startsWith("var(")) continue;
    const lh = /^text-([a-z]+)--line-height$/.exec(name);
    if (lh && (TYPE_ROLES as readonly string[]).includes(lh[1])) {
      const role = lh[1] as TypeRole;
      out.text[role] = { size: out.text[role]?.size ?? Number.NaN, lineHeight: Number(value) };
      continue;
    }
    const size = /^text-([a-z]+)$/.exec(name);
    if (size && (TYPE_ROLES as readonly string[]).includes(size[1])) {
      const role = size[1] as TypeRole;
      out.text[role] = { ...out.text[role], size: Number.parseFloat(value) };
      continue;
    }
    if (name === "font-weight-strong") out.weights.strong = Number(value);
    else if (name === "font-weight-regular") out.weights.regular = Number(value);
    else if (!name.startsWith("text-") && !name.startsWith("font-")) out.colors[name] = value;
  }
  return out;
}

/**
 * Every way one surface's tokens disagree with the scale it must follow.
 * One string per problem, each naming the surface, the token and both values,
 * so a report reads as a to-do list rather than a diff.
 */
export function agreementProblems(name: string, tokens: CssTokens, scale: Record<TypeRole, TypeStep>): string[] {
  const problems: string[] = [];
  for (const role of TYPE_ROLES) {
    const have = tokens.text[role];
    const want = scale[role];
    if (!have || Number.isNaN(have.size)) {
      problems.push(`${name}: missing --text-${role} (want ${want.size}px)`);
      continue;
    }
    if (have.size !== want.size) problems.push(`${name}: --text-${role} is ${have.size}px, want ${want.size}px`);
    if (have.lineHeight !== undefined && have.lineHeight !== want.lineHeight) {
      problems.push(`${name}: --text-${role}--line-height is ${have.lineHeight}, want ${want.lineHeight}`);
    }
  }
  if (tokens.weights.strong !== 600)
    problems.push(`${name}: --font-weight-strong is ${tokens.weights.strong ?? "missing"}, want 600`);
  if (tokens.weights.regular !== 400)
    problems.push(`${name}: --font-weight-regular is ${tokens.weights.regular ?? "missing"}, want 400`);
  for (const role of COLOR_ROLES) {
    if (!(role in tokens.colors)) problems.push(`${name}: missing colour --${role}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Colour math. OKLCH → OKLab → LMS → linear sRGB → sRGB, the standard
// Björn Ottosson matrices. Mobile cannot parse oklch() and keeps hex, so this
// is how the check knows whether mobile's hex IS the web's oklch — the drift
// spec § 1 found was a whole palette hiding behind a comment that said "port".
// ---------------------------------------------------------------------------

export function parseOklch(value: string): [number, number, number] | null {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gamma(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function oklchToSrgb(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  return [gamma(r), gamma(g), gamma(bl)];
}

export function hexToSrgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : h;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio, ≥ 1. */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mobile's camelCase keys → the CSS roles they must equal. The terminal trio is not compared (mobile's termFg has no CSS token). */
export const MOBILE_COLOR_MAP: Record<string, ColorRole> = {
  bg: "background",
  card: "card",
  border: "border",
  fg: "foreground",
  mutedFg: "muted-foreground",
  primary: "primary",
  primaryFg: "primary-foreground",
  success: "success",
  warning: "warning",
  destructive: "destructive",
};

/**
 * Every way mobile disagrees with the SPA: a colour whose hex is more than one
 * 8-bit step from the SPA's oklch on any channel, a missing colour key, a type
 * role at the wrong size or weight for the MOBILE column.
 */
export function mobileAgreement(
  spaCss: string,
  mobile: { colors: Record<string, string>; type: Record<string, { size: number; weight: string }> },
): string[] {
  const problems: string[] = [];
  const spa = parseCssTokens(spaCss);
  for (const [key, role] of Object.entries(MOBILE_COLOR_MAP)) {
    const hex = mobile.colors[key];
    if (!hex) {
      problems.push(`mobile: colors.${key} is missing (should be --${role})`);
      continue;
    }
    const oklch = spa.colors[role] ? parseOklch(spa.colors[role]) : null;
    if (!oklch) continue; // the SPA's own agreement check reports that
    const want = oklchToSrgb(...oklch);
    const have = hexToSrgb(hex);
    if (want.some((v, i) => Math.abs(v - have[i]) > 1)) {
      const wantHex = `#${want.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      problems.push(`mobile: colors.${key} is ${hex}, but --${role} converts to ${wantHex}`);
    }
  }
  for (const role of TYPE_ROLES) {
    const have = mobile.type[role];
    const want = MOBILE_SCALE[role];
    if (!have) {
      problems.push(`mobile: type.${role} is missing`);
      continue;
    }
    if (have.size !== want.size) problems.push(`mobile: type.${role}.size is ${have.size}, want ${want.size}`);
    if (Number(have.weight) !== want.weight)
      problems.push(`mobile: type.${role}.weight is ${have.weight}, want ${want.weight}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The surfaces. Paths are relative to the repo root, which is where every
// package.json script runs from.
// ---------------------------------------------------------------------------

export const REPO_ROOT = join(import.meta.dir, "..");

export type Surface = "spa" | "client" | "assistant" | "mobile";

export const CSS_SURFACES: Record<Exclude<Surface, "mobile">, string> = {
  spa: "apps/server/web/src/styles.css",
  client: "apps/client/desktop/ui/src/styles.css",
  assistant: "apps/server/desktop/ui/src/styles.css",
};

export const MOBILE_TOKENS = "apps/client/mobile/src/lib/tokens.ts";

/** The agreement half of the check, all four surfaces. */
export async function allAgreement(only?: Surface): Promise<string[]> {
  const problems: string[] = [];
  for (const [surface, rel] of Object.entries(CSS_SURFACES) as [Exclude<Surface, "mobile">, string][]) {
    if (only && only !== surface) continue;
    problems.push(...agreementProblems(surface, parseCssTokens(readFileSync(join(REPO_ROOT, rel), "utf8")), WEB_SCALE));
  }
  if (!only || only === "mobile") {
    // Imported, not parsed: tokens.ts is a pure module (no React Native
    // imports), so bun can load it directly and we compare real values.
    const mod = (await import(join(REPO_ROOT, MOBILE_TOKENS))) as {
      colors: Record<string, string>;
      type: Record<string, { size: number; weight: string }>;
    };
    problems.push(...mobileAgreement(readFileSync(join(REPO_ROOT, CSS_SURFACES.spa), "utf8"), mod));
  }
  return problems;
}

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) as Surface | undefined;
  const problems = await allAgreement(only);
  if (problems.length === 0) {
    console.log("✓ design tokens agree");
    process.exit(0);
  }
  const out = report ? console.log : console.error;
  out(`${report ? "•" : "✗"} ${problems.length} design-token problem(s):\n`);
  for (const p of problems) out(`  ${p}`);
  out("");
  process.exit(report ? 0 : 1);
}

# Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One type/colour/spacing vocabulary across the SPA, the server assistant, the client node page and mobile — expressed as per-surface tokens, bound by a check (`bun run lint:design`) that asserts agreement, refuses escapes and computes contrast, then applied surface by surface until the check runs green and failing in CI.

**Architecture:** Each surface keeps its native mechanism (Tailwind v4 `@theme` in the SPA and client, plain CSS custom properties in the assistant, a `tokens.ts` in mobile) but declares the SAME six type roles, two weights and ten colour roles. `scripts/design-tokens.ts` reads all four sources and is the single arbiter. It runs in `--report` mode (prints, exits 0) through the audits and flips to failing in the last task. The five phases of the spec map to Tasks 1–6 (tokens + check), 7 (assistant), 8–11 (SPA + client), 12 (mobile), 13 (flip + docs).

**Tech Stack:** Bun 1.4.x, TypeScript, Tailwind CSS v4 (`@theme inline`), plain CSS with `@layer`, React Native, Biome, `bun test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-design-system-design.md` — read it first; every task below cites the section it implements.

## Global Constraints

- **Six type roles, exactly these names:** `display`, `heading`, `label`, `body`, `detail`, `caption` (spec § 3.1).
- **Web sizes / weights:** display 30/600, heading 20/600, label 15/600, body 14/400, detail 13/400, caption 12/400. Line-height 1.2 for display and heading, 1.5 otherwise.
- **Mobile sizes / weights:** display 28/600, heading 20/600, label 16/600, body 16/400, detail 13/400, caption 12/400.
- **Two weights only:** `600` ("strong") and `400` ("regular"). Weight 500 and 700 are retired (spec § 3.1).
- **Ten colour roles, shadcn names everywhere:** `background`, `card`, `border`, `foreground`, `muted-foreground`, `primary`, `primary-foreground`, `success`, `warning`, `destructive`. Values are Dreamframe's and DO NOT change (spec § 3.2).
- **`text-sm` and `text-xs` are accepted aliases** of `body` and `caption` in the SPA and client; `text-base`, `text-lg`, `text-xl`, `text-2xl`, `text-3xl` and every `text-[Npx]` are escapes (spec § 6.2).
- **Spacing grid:** 4, 8, 12, 16, 24, 32 (spec § 3.3). Radius stays 8.
- **Commits:** Conventional-commit style as the repo uses (`feat(scope): …`, `fix(scope): …`). End every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Verification before every commit:** `bun run verify-types` and `bun run lint:check` must pass. `scripts/` is NOT covered by turbo's lint — run `bunx biome check scripts/` directly for anything under `scripts/`. Rust is untouched by this plan.
- **Never edit `bun.lock` by hand;** this plan adds no dependencies so it should never change.
- **Do not touch `apps/server/web/src/styles/dockview-theme.css`** or xterm theme literals — they are consumers of the terminal trio, deliberately raw (spec § 3.2 leaves terminal surfaces alone).

---

## File Structure

**Created**

| path | responsibility |
|---|---|
| `scripts/design-tokens.ts` | The check. Parses the four token sources, asserts agreement, scans for escapes, computes contrast. `--report` prints without failing; `--only=<surface>` narrows. Exports its pure functions for tests. |
| `scripts/__tests__/design-tokens.test.ts` | Fixture-driven tests for the parser, the agreement rules, the escape scanner and the colour math. |
| `apps/client/desktop/ui/src/__tests__/tokens-match-spa.test.ts` | The "COPIED VERBATIM" contract, pinned: the client's token block equals the SPA's (terminal trio excluded). |
| `docs/design-system.md` | The living reference (Task 13). |
| `.claude/rules/design-system.md` | The pointer agents load (Task 13). |

**Modified**

| path | what changes |
|---|---|
| `apps/server/web/src/styles.css` | `@theme inline` gains `--text-<role>` + line-heights, `--font-weight-strong/regular`, pins `--text-sm`/`--text-xs`. |
| `apps/client/desktop/ui/src/styles.css` | Same `@theme` additions; its `:root, .dark` block made equal to the SPA's minus the terminal trio. |
| `apps/server/desktop/ui/src/styles.css` | `:root` gains the type roles; colour vars renamed to shadcn names (and every `var(--color-*)` use); primary-button gradient literals become tokens; 48 `font-size` literals → `var(--text-*)`; 14/28px spacing → grid. |
| `apps/client/mobile/src/lib/tokens.ts` | `colors` re-derived from Dreamframe (hex); `type` + `font()` added. |
| 12 mobile `.tsx` files | `fontSize: N` → `...font("role")`. |
| ~30 SPA/client `.tsx` files | arbitrary and off-scale sizes → role utilities; `font-medium`/`font-bold` resolved. |
| `package.json` | `lint:design`, `lint:design:report` scripts. |
| `.github/workflows/lint.yml`, `lefthook.yml` | run the check. |
| `apps/{server/web,server/desktop,client/desktop,client/mobile}/AGENTS.md` | one line each pointing at the reference. |

---

## Phase 1 — Tokens and the check (reporting only)

### Task 1: The check's core — parser, scales, agreement — with fixture tests

**Files:**
- Create: `scripts/design-tokens.ts`
- Create: `scripts/__tests__/design-tokens.test.ts`

**Interfaces:**
- Produces (used by every later task, by name):
  ```ts
  export const TYPE_ROLES = ["display", "heading", "label", "body", "detail", "caption"] as const;
  export type TypeRole = (typeof TYPE_ROLES)[number];
  export interface TypeStep { size: number; lineHeight: number; weight: 400 | 600 }
  export const WEB_SCALE: Record<TypeRole, TypeStep>;
  export const MOBILE_SCALE: Record<TypeRole, TypeStep>;
  export const COLOR_ROLES = ["background","card","border","foreground","muted-foreground","primary","primary-foreground","success","warning","destructive"] as const;
  export interface CssTokens { text: Partial<Record<TypeRole, { size: number; lineHeight?: number }>>; weights: { strong?: number; regular?: number }; colors: Record<string, string> }
  export function parseCssTokens(css: string): CssTokens;
  export function agreementProblems(name: string, tokens: CssTokens, scale: Record<TypeRole, TypeStep>): string[];
  ```
- The CLI (`bun scripts/design-tokens.ts [--report] [--only=spa|client|assistant|mobile]`) is completed in Task 6; this task ships the library half and a CLI that runs agreement only.

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/design-tokens.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  agreementProblems,
  COLOR_ROLES,
  MOBILE_SCALE,
  parseCssTokens,
  TYPE_ROLES,
  WEB_SCALE,
} from "../design-tokens";

/**
 * The parser reads whatever block a surface keeps its tokens in: the SPA's
 * `:root, .dark {}` plus `@theme inline {}`, or the assistant's bare `:root {}`.
 * It is deliberately a line scanner, not a CSS parser — every token file in
 * this repo writes one declaration per line, and a real parser would be a
 * dependency for the sake of a format nobody uses here.
 */
const SPA_LIKE = `
:root,
.dark {
  --background: oklch(0.224 0.035 296);
  --foreground: oklch(0.92 0.03 312);
  --muted-foreground: oklch(0.74 0.04 310);
  --card: oklch(0.255 0.032 296);
  --border: oklch(0.33 0.035 296);
  --primary: oklch(0.75 0.17 322);
  --primary-foreground: oklch(0.16 0.05 322);
  --success: oklch(0.74 0.14 155);
  --warning: oklch(0.8 0.14 80);
  --destructive: oklch(0.68 0.19 20);
}
@theme inline {
  --text-display: 30px;
  --text-display--line-height: 1.2;
  --text-heading: 20px;
  --text-heading--line-height: 1.2;
  --text-label: 15px;
  --text-label--line-height: 1.5;
  --text-body: 14px;
  --text-body--line-height: 1.5;
  --text-detail: 13px;
  --text-detail--line-height: 1.5;
  --text-caption: 12px;
  --text-caption--line-height: 1.5;
  --font-weight-strong: 600;
  --font-weight-regular: 400;
}
`;

describe("the scales", () => {
  test("declare exactly the six roles, in the spec's order", () => {
    expect([...TYPE_ROLES]).toEqual(["display", "heading", "label", "body", "detail", "caption"]);
    for (const role of TYPE_ROLES) {
      expect(WEB_SCALE[role]).toBeDefined();
      expect(MOBILE_SCALE[role]).toBeDefined();
    }
  });

  test("use two weights only, and agree on which roles are strong", () => {
    for (const role of TYPE_ROLES) {
      expect([400, 600]).toContain(WEB_SCALE[role].weight);
      expect(MOBILE_SCALE[role].weight).toBe(WEB_SCALE[role].weight);
    }
    expect(WEB_SCALE.label.weight).toBe(600);
    expect(WEB_SCALE.body.weight).toBe(400);
  });

  test("pin the web sizes the spec chose", () => {
    expect(WEB_SCALE.display.size).toBe(30);
    expect(WEB_SCALE.heading.size).toBe(20);
    expect(WEB_SCALE.label.size).toBe(15);
    expect(WEB_SCALE.body.size).toBe(14);
    expect(WEB_SCALE.detail.size).toBe(13);
    expect(WEB_SCALE.caption.size).toBe(12);
  });

  test("name ten colour roles", () => {
    expect(COLOR_ROLES).toHaveLength(10);
    expect(COLOR_ROLES).toContain("muted-foreground");
  });
});

describe("parseCssTokens", () => {
  test("reads type roles, line-heights, weights and colours from any block", () => {
    const t = parseCssTokens(SPA_LIKE);
    expect(t.text.label).toEqual({ size: 15, lineHeight: 1.5 });
    expect(t.text.display).toEqual({ size: 30, lineHeight: 1.2 });
    expect(t.weights).toEqual({ strong: 600, regular: 400 });
    expect(t.colors.background).toBe("oklch(0.224 0.035 296)");
    expect(t.colors["muted-foreground"]).toBe("oklch(0.74 0.04 310)");
  });

  test("ignores Tailwind's @theme aliases of the colours (`--color-*: var(...)`)", () => {
    // The SPA's @theme block maps `--color-background: var(--background)`; those
    // are consumers, not definitions, and reading them would double-count.
    const t = parseCssTokens(`${SPA_LIKE}\n@theme inline {\n  --color-background: var(--background);\n}`);
    expect(t.colors["color-background"]).toBeUndefined();
  });

  test("tolerates comments and blank lines between declarations", () => {
    const t = parseCssTokens(`:root {\n  /* ground */\n\n  --background: #1d182a;\n  --text-body: 14px; /* trailing */\n}`);
    expect(t.colors.background).toBe("#1d182a");
    expect(t.text.body?.size).toBe(14);
  });
});

describe("agreementProblems", () => {
  test("is empty for a complete, correct surface", () => {
    expect(agreementProblems("spa", parseCssTokens(SPA_LIKE), WEB_SCALE)).toEqual([]);
  });

  test("names a missing role, a wrong size and a wrong weight, each once", () => {
    const broken = SPA_LIKE.replace("--text-caption: 12px;", "")
      .replace("--text-caption--line-height: 1.5;", "")
      .replace("--text-label: 15px;", "--text-label: 14px;")
      .replace("--font-weight-strong: 600;", "--font-weight-strong: 500;");
    const problems = agreementProblems("spa", parseCssTokens(broken), WEB_SCALE);
    expect(problems).toContainEqual(expect.stringContaining("caption"));
    expect(problems).toContainEqual(expect.stringContaining("label"));
    expect(problems).toContainEqual(expect.stringContaining("strong"));
    expect(problems).toHaveLength(3);
  });

  test("names a missing colour role", () => {
    const broken = SPA_LIKE.replace("--destructive: oklch(0.68 0.19 20);", "");
    expect(agreementProblems("spa", parseCssTokens(broken), WEB_SCALE)).toEqual([
      expect.stringContaining("destructive"),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/__tests__/design-tokens.test.ts`
Expected: FAIL — `Cannot find module '../design-tokens'`.

- [ ] **Step 3: Write the library half of `scripts/design-tokens.ts`**

```ts
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
  if (tokens.weights.strong !== 600) problems.push(`${name}: --font-weight-strong is ${tokens.weights.strong ?? "missing"}, want 600`);
  if (tokens.weights.regular !== 400) problems.push(`${name}: --font-weight-regular is ${tokens.weights.regular ?? "missing"}, want 400`);
  for (const role of COLOR_ROLES) {
    if (!(role in tokens.colors)) problems.push(`${name}: missing colour --${role}`);
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

/** The agreement half of the check, for the three CSS surfaces. Task 5 adds mobile. */
export function cssAgreement(only?: Surface): string[] {
  const problems: string[] = [];
  for (const [surface, rel] of Object.entries(CSS_SURFACES) as [Exclude<Surface, "mobile">, string][]) {
    if (only && only !== surface) continue;
    problems.push(...agreementProblems(surface, parseCssTokens(readFileSync(join(REPO_ROOT, rel), "utf8")), WEB_SCALE));
  }
  return problems;
}

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) as Surface | undefined;
  const problems = cssAgreement(only);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/__tests__/design-tokens.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the CLI in report mode against the real files**

Run: `bun scripts/design-tokens.ts --report`
Expected: exit 0, and a list of problems — every CSS surface is missing all six `--text-*` roles and both weights, and the assistant is missing every colour role (its names are still `--color-fg` etc.). That list is the baseline; Tasks 2–5 drive it to zero.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check --write scripts/design-tokens.ts scripts/__tests__/design-tokens.test.ts
bunx biome check scripts/
git add scripts/design-tokens.ts scripts/__tests__/design-tokens.test.ts
git commit -m "feat(scripts): design-tokens — the scales, a token parser and the agreement check

The library half of \`lint:design\` (spec 2026-09-14 § 6.2). Six type roles at
two weights, a web and a mobile column, ten colour roles under shadcn's
names; a line-scanning parser that reads any block a surface keeps its
tokens in; and \`agreementProblems\`, which names every way one surface
disagrees with its scale. Run in --report mode it prints the baseline the
next four tasks drive to zero.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SPA type tokens in `@theme`, `text-sm`/`text-xs` pinned as aliases

**Files:**
- Modify: `apps/server/web/src/styles.css:69-98` (the `@theme inline` block)

**Interfaces:**
- Consumes: `bun scripts/design-tokens.ts --only=spa --report` (Task 1) as the verifier.
- Produces: Tailwind utilities `text-display`, `text-heading`, `text-label`, `text-body`, `text-detail`, `text-caption` (font-size + line-height), `font-strong`, `font-regular`. Tasks 8–10 use these names.

- [ ] **Step 1: Confirm the baseline for this surface**

Run: `bun scripts/design-tokens.ts --only=spa --report`
Expected: 8 problems — six `missing --text-*` and two `--font-weight-*` missing.

- [ ] **Step 2: Add the type tokens to `@theme inline`**

In `apps/server/web/src/styles.css`, inside the `@theme inline { … }` block, immediately after the line `--radius-xl: calc(var(--radius) + 4px);` and before the closing `}`, add:

```css
  /* Type roles (design-system.md § Type; spec 2026-09-14 § 3.1). Tailwind v4
     generates `text-<role>` from `--text-<role>` and reads the matching
     `--text-<role>--line-height`, so these six lines ARE the utilities. Two
     weights only: `font-strong` and `font-regular`. `--text-sm` and `--text-xs`
     are pinned to exact px so Tailwind's defaults (0.875rem, 0.75rem — the same
     numbers at a 16px root, but only by coincidence) become `body` and `caption`
     by definition; they are accepted aliases, and `lint:design` refuses every
     other Tailwind text size. */
  --text-display: 30px;
  --text-display--line-height: 1.2;
  --text-heading: 20px;
  --text-heading--line-height: 1.2;
  --text-label: 15px;
  --text-label--line-height: 1.5;
  --text-body: 14px;
  --text-body--line-height: 1.5;
  --text-detail: 13px;
  --text-detail--line-height: 1.5;
  --text-caption: 12px;
  --text-caption--line-height: 1.5;
  --text-sm: 14px;
  --text-sm--line-height: 1.5;
  --text-xs: 12px;
  --text-xs--line-height: 1.5;
  --font-weight-strong: 600;
  --font-weight-regular: 400;
```

- [ ] **Step 3: Verify with the check and the SPA's own suite**

Run: `bun scripts/design-tokens.ts --only=spa`
Expected: `✓ design tokens agree`, exit 0.

Run: `cd apps/server/web && bun test 2>&1 | tail -3`
Expected: 0 fail. (Pinning `--text-sm` to 14px/1.5 changes `text-sm`'s line-height from Tailwind's default 1.25rem ≈ 1.43 to 1.5 — a sub-pixel change on 14px text; no test asserts computed line-height.)

- [ ] **Step 4: Verify a utility is actually generated**

Run: `cd apps/server/web && bun run build 2>&1 | tail -2 && grep -o "\.text-label{[^}]*}" dist/assets/*.css | head -1`
Expected: a rule like `.text-label{font-size:var(--text-label);line-height:var(--tw-leading,var(--text-label--line-height))}` — proof Tailwind read the token. (If `dist/` is not where the build lands, check `vite.config.ts`'s `build.outDir`.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/web/src/styles.css
git commit -m "feat(web): the six type roles as Tailwind tokens; text-sm/xs pinned as body/caption

Nothing consumes them yet — the audit in later tasks does. \`--text-sm\` and
\`--text-xs\` are pinned to exact px so Tailwind's defaults become \`body\` and
\`caption\` by definition rather than by the coincidence of a 16px root, which
is what lets 342 existing callsites stand as accepted aliases (spec § 6.2).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Client type tokens, and the client's token block made equal to the SPA's — pinned by test

**Files:**
- Modify: `apps/client/desktop/ui/src/styles.css:25-67` (`:root, .dark`) and `:69-95` (`@theme inline`)
- Create: `apps/client/desktop/ui/src/__tests__/tokens-match-spa.test.ts`

**Interfaces:**
- Consumes: Task 2's exact `@theme` additions (copied byte-for-byte).
- Produces: the invariant "client `:root, .dark` == SPA `:root, .dark` minus `--terminal-*`", which Task 6's check also enforces.

- [ ] **Step 1: Write the failing test**

Create `apps/client/desktop/ui/src/__tests__/tokens-match-spa.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This stylesheet's palette is "COPIED VERBATIM from apps/server/web/src/styles.css"
 * — its own header says so, and until 2026-09-14 nothing checked it. Mobile
 * made the same claim and drifted a whole palette behind it (spec
 * 2026-09-14 § 1). A copy held together by a comment is a copy that has
 * already started to differ; this is the test that comment should have been.
 *
 * Compared: every `--name: value;` declaration in the `:root, .dark` block and
 * every one in `@theme inline`, EXCEPT the terminal trio (`--terminal-*` and
 * their `--color-terminal-*` aliases) — this page has no terminal and does not
 * carry them. Comments and blank lines are not compared: the two files are
 * free to explain themselves differently.
 */
const HERE = import.meta.dir;
const CLIENT = join(HERE, "../styles.css");
const SPA = join(HERE, "../../../../server/web/src/styles.css");

/** The declarations of one named block, normalised to `--name: value`. */
function declarations(css: string, opener: RegExp): string[] {
  const start = css.search(opener);
  if (start < 0) return [];
  const body = css.slice(start, css.indexOf("\n}", start));
  return body
    .split("\n")
    .map((l) => l.replace(/\/\*.*?\*\//g, "").trim())
    .filter((l) => l.startsWith("--") && !l.includes("terminal"))
    .map((l) => l.replace(/\s+/g, " "));
}

describe("the client's tokens are the SPA's", () => {
  const client = readFileSync(CLIENT, "utf8");
  const spa = readFileSync(SPA, "utf8");

  test(":root, .dark declares the same values, terminal trio aside", () => {
    expect(declarations(client, /^:root,\n\.dark \{/m)).toEqual(declarations(spa, /^:root,\n\.dark \{/m));
  });

  test("@theme inline declares the same tokens, terminal trio aside", () => {
    expect(declarations(client, /^@theme inline \{/m)).toEqual(declarations(spa, /^@theme inline \{/m));
  });

  test("and there is something to compare", () => {
    // A regex that stops matching would make both lists empty and the
    // equality above vacuous.
    expect(declarations(spa, /^:root,\n\.dark \{/m).length).toBeGreaterThan(20);
    expect(declarations(spa, /^@theme inline \{/m).length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/client/desktop/ui && bun test src/__tests__/tokens-match-spa.test.ts`
Expected: FAIL on the `@theme inline` test (the SPA now has 18 type declarations the client lacks). The `:root, .dark` test may pass or fail depending on drift; either way, continue.

- [ ] **Step 3: Make the client's two blocks equal to the SPA's**

Open both files side by side. In `apps/client/desktop/ui/src/styles.css`:

1. Replace the entire contents of the `:root, .dark { … }` block (lines 25–67) with the SPA's `:root, .dark { … }` block contents (`apps/server/web/src/styles.css` lines 18–67), then DELETE the terminal trio from the copy — the comment beginning `/* Terminal/workspace surfaces.` and the three lines `--terminal-strip`, `--terminal-canvas`, `--terminal-tab-active`. Keep the client's own leading header comment above `:root` untouched.
2. Replace the entire contents of `@theme inline { … }` with the SPA's `@theme inline` contents (which now include Task 2's type tokens), then DELETE the three `--color-terminal-*` alias lines.

- [ ] **Step 4: Run the test and the check**

Run: `cd apps/client/desktop/ui && bun test src/__tests__/tokens-match-spa.test.ts`
Expected: PASS, 3 tests.

Run: `bun scripts/design-tokens.ts --only=client`
Expected: `✓ design tokens agree`.

Run: `cd apps/client/desktop/ui && bun test 2>&1 | tail -3`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/client/desktop/ui/src/styles.css apps/client/desktop/ui/src/__tests__/tokens-match-spa.test.ts
git commit -m "feat(desktop-client): the token block IS the SPA's, and a test says so

Its header has claimed \"COPIED VERBATIM\" since the page existed; nothing
checked. Mobile made the same claim and drifted a whole palette behind it.
The two blocks are now equal minus the terminal trio this page does not
carry, and the test compares declarations only — the two files stay free to
explain themselves differently. Gains the six type roles with the copy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Assistant tokens — type roles added, colours renamed to shadcn names, gradient literals tokenised

**Files:**
- Modify: `apps/server/desktop/ui/src/styles.css` (the `:root {}` token block near the top, lines ~18–29; then every `var(--color-*)` reference in the file — 96 of them; and the primary-button gradient at lines ~62–72)
- Modify: `apps/server/desktop/ui/src/__tests__/config-form.test.ts` ONLY if it greps for a `--color-*` name (check with `grep -n "color-" apps/server/desktop/ui/src/__tests__/*.ts`; at time of writing it does not)

**Interfaces:**
- Consumes: the rename table from spec § 3.2.
- Produces: `--text-<role>`, `--text-<role>--line-height`, `--font-weight-strong`, `--font-weight-regular`, `--button-primary-from`, `--button-primary-to`, `--button-primary-hover-from`, `--button-primary-hover-to`, `--button-primary-foreground` custom properties, and the shadcn colour names. Task 7 consumes all of these.

- [ ] **Step 1: Confirm the baseline**

Run: `bun scripts/design-tokens.ts --only=assistant --report`
Expected: 18 problems — six type roles, two weights, ten colour roles (because the assistant's are named `--color-*`).

- [ ] **Step 2: Rename the colour tokens at their definition**

In `apps/server/desktop/ui/src/styles.css`, the `:root {` block near the top declares the assistant's colours. Replace those declarations so the block reads:

```css
:root {
  /* Dreamframe (spec 2026-09-03), under the shadcn names every surface uses
     (spec 2026-09-14 § 3.2) — so a rule here reads the same as one in the
     SPA, and `lint:design` can compare the three files by name. Values are
     unchanged. */
  --background: oklch(0.224 0.035 296);
  --card: oklch(0.264 0.038 298);
  --border: oklch(0.34 0.04 300);
  --foreground: oklch(0.92 0.03 312);
  --muted-foreground: oklch(0.74 0.04 310);
  --primary: oklch(0.75 0.17 322);
  --primary-foreground: oklch(0.18 0.04 300);
  --success: oklch(0.74 0.14 155);
  --warning: oklch(0.8 0.14 80);
  --destructive: oklch(0.68 0.19 20);
  /* The primary button's "sunk plum" gradient (Dreamframe: quiet at the
     component, bright at the token). Named here because `lint:design`
     refuses colour literals outside a token block, and a gradient IS a
     design decision, not a one-off. */
  --button-primary-from: oklch(0.34 0.1 322);
  --button-primary-to: oklch(0.4 0.1 340);
  --button-primary-hover-from: oklch(0.4 0.11 322);
  --button-primary-hover-to: oklch(0.46 0.11 340);
  --button-primary-foreground: oklch(0.9 0.05 320);
  /* Type roles (spec § 3.1, web column). Plain custom properties — this page
     has no Tailwind — consumed as `font-size: var(--text-label)`. Two weights. */
  --text-display: 30px;
  --text-display--line-height: 1.2;
  --text-heading: 20px;
  --text-heading--line-height: 1.2;
  --text-label: 15px;
  --text-label--line-height: 1.5;
  --text-body: 14px;
  --text-body--line-height: 1.5;
  --text-detail: 13px;
  --text-detail--line-height: 1.5;
  --text-caption: 12px;
  --text-caption--line-height: 1.5;
  --font-weight-strong: 600;
  --font-weight-regular: 400;
  --default-font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
}
```

(Keep `--default-font-family` exactly as it was; keep any other non-colour declaration that block already had.)

- [ ] **Step 3: Rename every reference, mechanically**

Run, from the repo root:

```bash
f=apps/server/desktop/ui/src/styles.css
sed -i '' \
  -e 's/var(--color-bg)/var(--background)/g' \
  -e 's/var(--color-card)/var(--card)/g' \
  -e 's/var(--color-line)/var(--border)/g' \
  -e 's/var(--color-fg)/var(--foreground)/g' \
  -e 's/var(--color-muted)/var(--muted-foreground)/g' \
  -e 's/var(--color-primary-fg)/var(--primary-foreground)/g' \
  -e 's/var(--color-primary)/var(--primary)/g' \
  -e 's/var(--color-ok)/var(--success)/g' \
  -e 's/var(--color-warn)/var(--warning)/g' \
  -e 's/var(--color-bad)/var(--destructive)/g' \
  "$f"
grep -c "var(--color-" "$f"
```

Expected: the final `grep -c` prints `0`. (Order matters: `--color-primary-fg` is replaced before `--color-primary`, or the latter would eat the former's prefix.)

- [ ] **Step 4: Replace the gradient literals with the new tokens**

Around lines 62–72 the primary button reads:

```css
    background: linear-gradient(135deg, oklch(0.34 0.1 322), oklch(0.4 0.1 340));
    color: oklch(0.9 0.05 320);
```
and its hover:
```css
    background: linear-gradient(135deg, oklch(0.4 0.11 322), oklch(0.46 0.11 340));
```

Replace with:

```css
    background: linear-gradient(135deg, var(--button-primary-from), var(--button-primary-to));
    color: var(--button-primary-foreground);
```
and
```css
    background: linear-gradient(135deg, var(--button-primary-hover-from), var(--button-primary-hover-to));
```

Then confirm no colour literal remains outside the token block:

```bash
awk 'NR>60' apps/server/desktop/ui/src/styles.css | grep -nE '#[0-9a-fA-F]{3,8}\b|oklch\(' ; echo "exit=$?"
```
Expected: no lines printed, `exit=1`. (Adjust `NR>60` to the line after the `:root {}` block's closing brace if it moved.)

- [ ] **Step 5: Verify**

Run: `bun scripts/design-tokens.ts --only=assistant`
Expected: `✓ design tokens agree`.

Run: `cd apps/server/desktop/ui && bunx biome check --write src/styles.css && bun test 2>&1 | tail -3`
Expected: 0 fail.

Run: `bun run dev:desktop-server --check 2>&1 | tail -2` — this stages the sidecar and stops; it proves nothing about CSS but confirms the app still builds. Then launch `bun run dev:desktop-server` and eyeball the assistant once: colours must be IDENTICAL to before (this task renames, it does not recolour). Quit it (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git add apps/server/desktop/ui/src/styles.css
git commit -m "refactor(desktop): the assistant's colours under shadcn's names; type roles added

Same values, one vocabulary: \`--color-fg\` is \`--foreground\`, \`--color-line\` is
\`--border\`, \`--color-ok\` is \`--success\` — so a rule here reads the same as one
in the SPA and \`lint:design\` compares the three files by name. 96 references
renamed mechanically. The primary button's sunk-plum gradient becomes five
tokens rather than five literals, because a gradient is a design decision and
the check refuses colour literals outside a token block. The six type roles
land as plain custom properties; nothing consumes them until the audit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Mobile tokens — Dreamframe palette re-derived, type roles and `font()` added, and the check learns mobile

**Files:**
- Modify: `apps/client/mobile/src/lib/tokens.ts`
- Modify: `scripts/design-tokens.ts` (add colour math + `mobileAgreement`)
- Modify: `scripts/__tests__/design-tokens.test.ts` (colour math + mobile agreement tests)

**Interfaces:**
- Produces in `tokens.ts`:
  ```ts
  export const colors: { bg; card; border; fg; mutedFg; accent; primary; primaryFg; success; warning; destructive; termBg; termCanvas; termFg } // hex strings
  export const type: Record<TypeRole, { size: number; lineHeight: number; weight: "400" | "600" }>
  export type TypeRole = "display" | "heading" | "label" | "body" | "detail" | "caption";
  export function font(role: TypeRole): { fontSize: number; lineHeight: number; fontWeight: "400" | "600" }
  ```
  Task 12 consumes `font()`.
- Produces in `scripts/design-tokens.ts`:
  ```ts
  export function parseOklch(value: string): [l: number, c: number, h: number] | null
  export function oklchToSrgb(l: number, c: number, h: number): [r: number, g: number, b: number] // 0–255, clamped
  export function hexToSrgb(hex: string): [number, number, number]
  export function contrastRatio(a: [number, number, number], b: [number, number, number]): number
  export const MOBILE_COLOR_MAP: Record<string, ColorRole> // mobile key → CSS role
  export function mobileAgreement(spaCss: string, mobile: { colors: Record<string,string>; type: Record<string, {size:number; weight:string}> }): string[]
  ```

- [ ] **Step 1: Write the failing tests for the colour math and mobile agreement**

Append to `scripts/__tests__/design-tokens.test.ts`:

```ts
import {
  contrastRatio,
  hexToSrgb,
  mobileAgreement,
  oklchToSrgb,
  parseOklch,
} from "../design-tokens";

describe("colour math", () => {
  test("parses an oklch() string", () => {
    expect(parseOklch("oklch(0.224 0.035 296)")).toEqual([0.224, 0.035, 296]);
    expect(parseOklch("#1d182a")).toBeNull();
  });

  test("converts Dreamframe's ground to the hex the operator approved", () => {
    // spec 2026-09-03: --background oklch(0.224 0.035 296) "= #1d182a exactly".
    // Rounding lands within one 8-bit step per channel.
    const [r, g, b] = oklchToSrgb(0.224, 0.035, 296);
    const [er, eg, eb] = hexToSrgb("#1d182a");
    expect(Math.abs(r - er)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - eg)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - eb)).toBeLessThanOrEqual(1);
  });

  test("white on black is 21:1 and a colour on itself is 1:1", () => {
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0);
    expect(contrastRatio([120, 120, 120], [120, 120, 120])).toBe(1);
  });
});

describe("mobileAgreement", () => {
  const spa = `:root, .dark {
  --background: oklch(0.224 0.035 296);
  --card: oklch(0.255 0.032 296);
  --border: oklch(0.33 0.035 296);
  --foreground: oklch(0.92 0.03 312);
  --muted-foreground: oklch(0.74 0.04 310);
  --primary: oklch(0.75 0.17 322);
  --primary-foreground: oklch(0.16 0.05 322);
  --success: oklch(0.74 0.14 155);
  --warning: oklch(0.8 0.14 80);
  --destructive: oklch(0.68 0.19 20);
}`;
  const good = {
    colors: {
      bg: "#1d182a",
      card: "#251f34",
      border: "#352d47",
      fg: "#ece4f2",
      mutedFg: "#b3a7bd",
      primary: "#e392d6",
      primaryFg: "#2f1230",
      success: "#4fcf8e",
      warning: "#e6b74a",
      destructive: "#f0655f",
    },
    type: {
      display: { size: 28, weight: "600" },
      heading: { size: 20, weight: "600" },
      label: { size: 16, weight: "600" },
      body: { size: 16, weight: "400" },
      detail: { size: 13, weight: "400" },
      caption: { size: 12, weight: "400" },
    },
  };

  test("accepts hex within one step of the converted oklch", () => {
    // The fixture hexes are placeholders shaped like real ones; the assertion
    // that matters is on the REAL tokens.ts in the CLI. Here: a wrong ground.
    const drifted = { ...good, colors: { ...good.colors, bg: "#0a0a0a" } };
    const problems = mobileAgreement(spa, drifted);
    expect(problems).toContainEqual(expect.stringContaining("bg"));
    expect(problems.filter((p) => p.includes("bg"))).toHaveLength(1);
  });

  test("names a type role at the wrong size or weight", () => {
    const wrong = { ...good, type: { ...good.type, label: { size: 15, weight: "500" } } };
    const problems = mobileAgreement(spa, wrong).filter((p) => p.includes("label"));
    expect(problems).toHaveLength(2);
  });

  test("names a missing colour key", () => {
    const { destructive: _drop, ...rest } = good.colors;
    expect(mobileAgreement(spa, { ...good, colors: rest })).toContainEqual(expect.stringContaining("destructive"));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test scripts/__tests__/design-tokens.test.ts`
Expected: FAIL — `parseOklch`, `oklchToSrgb`, `hexToSrgb`, `contrastRatio`, `mobileAgreement` are not exported.

- [ ] **Step 3: Add the colour math and mobile agreement to `scripts/design-tokens.ts`**

Insert after `agreementProblems` and before the `// The surfaces` banner:

```ts
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
  const full = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h;
  return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)];
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
    if (Number(have.weight) !== want.weight) problems.push(`mobile: type.${role}.weight is ${have.weight}, want ${want.weight}`);
  }
  return problems;
}
```

Then extend the CLI so mobile is checked. Replace the `cssAgreement` function and the `if (import.meta.main)` block with:

```ts
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
```

Note on the dynamic import: `.claude/rules/code-style.md` bans `await import()` in the codebase because it breaks `bun build --compile`. This script is a dev tool under `scripts/`, never compiled into a binary, and the import target is a fixed path — the rule's reasoning does not apply. Say so in a comment (already above) so the next reader does not "fix" it.

- [ ] **Step 4: Run the tests**

Run: `bun test scripts/__tests__/design-tokens.test.ts`
Expected: PASS (the earlier 10 plus 6 new). The `mobileAgreement` "accepts hex" test only asserts on the DRIFTED ground; the fixture hexes for the others need not be exact.

- [ ] **Step 5: Compute the real Dreamframe hexes**

Run from the repo root:

```bash
bun -e '
import { parseCssTokens, parseOklch, oklchToSrgb, COLOR_ROLES } from "./scripts/design-tokens.ts";
import { readFileSync } from "node:fs";
const spa = parseCssTokens(readFileSync("apps/server/web/src/styles.css","utf8"));
for (const role of [...COLOR_ROLES, "accent"]) {
  const o = parseOklch(spa.colors[role] ?? ""); if (!o) { console.log(role, "(not oklch:", spa.colors[role], ")"); continue; }
  const [r,g,b] = oklchToSrgb(...o);
  console.log(role.padEnd(18), spa.colors[role].padEnd(28), "#"+[r,g,b].map(v=>v.toString(16).padStart(2,"0")).join(""));
}'
```

Copy the printed hex for each role into Step 6. (`accent` is used by mobile's `colors.accent`; the SPA has `--accent`. The terminal trio: keep mobile's existing `termBg`/`termCanvas`/`termFg` values — they are NOT compared and the SPA's `--terminal-strip`/`--terminal-canvas` are already hex; copy those two across if they differ, leave `termFg` as is.)

- [ ] **Step 6: Rewrite `apps/client/mobile/src/lib/tokens.ts`**

Replace the whole file with (substituting the hexes from Step 5 where `<hex>` appears; the oklch source stays in the comment beside each so the derivation is auditable):

```ts
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
  bg: "<hex>",
  /** Raised surfaces: cards, sheets, bars — web `--card`. */
  card: "<hex>",
  /** Hairlines and inputs — web `--border`. */
  border: "<hex>",
  /** Primary text — web `--foreground`. */
  fg: "<hex>",
  /** Secondary text — web `--muted-foreground`. */
  mutedFg: "<hex>",
  /** Pressed/selected fill — web `--accent`. */
  accent: "<hex>",
  /** Brand/action colour — web `--primary` (orchid). */
  primary: "<hex>",
  /** Text on a primary fill — web `--primary-foreground`. */
  primaryFg: "<hex>",
  /** Started/alive — web `--success`. */
  success: "<hex>",
  /** THE "waiting for you" colour — web `--warning`. */
  warning: "<hex>",
  /** Terminate/delete — web `--destructive`. */
  destructive: "<hex>",
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
```

- [ ] **Step 7: Verify mobile agrees, and mobile's own tests still pass**

Run: `bun scripts/design-tokens.ts --only=mobile`
Expected: `✓ design tokens agree`. If a colour is reported off by more than one step, you mistyped a hex — re-run Step 5 and copy again.

Run: `cd apps/client/mobile && bun test 2>&1 | tail -3`
Expected: 0 fail. (`colors.primary` changed value — the device-free tests do not assert colours.)

Run: `bun scripts/design-tokens.ts`
Expected: `✓ design tokens agree` — all four surfaces, for the first time.

- [ ] **Step 8: Lint and commit**

```bash
bunx biome check --write scripts/design-tokens.ts scripts/__tests__/design-tokens.test.ts apps/client/mobile/src/lib/tokens.ts
bunx biome check scripts/
git add scripts/design-tokens.ts scripts/__tests__/design-tokens.test.ts apps/client/mobile/src/lib/tokens.ts
git commit -m "feat(mobile, scripts): mobile's palette is Dreamframe's again, and the check can tell

tokens.ts said it was the port of the web stylesheet and carried the palette
Dreamframe replaced on 2026-09-03: a black ground and a blue primary under a
comment claiming sync. Every colour is re-derived from the SPA's oklch — the
source is named beside each hex — and \`lint:design\` now converts the SPA's
tokens itself and fails if this file is more than one 8-bit step away, so
the comment is no longer what holds the two together. The six type roles
land as the mobile column, with \`font()\` as the one way to consume them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The escape scanner and the contrast check; wired into CI and pre-push in report mode

**Files:**
- Modify: `scripts/design-tokens.ts`
- Modify: `scripts/__tests__/design-tokens.test.ts`
- Modify: `package.json` (scripts)
- Modify: `.github/workflows/lint.yml`
- Modify: `lefthook.yml`

**Interfaces:**
- Produces:
  ```ts
  export interface Escape { file: string; line: number; found: string; use: string }
  export function findEscapes(surface: Surface, relPath: string, source: string): Escape[]
  export function contrastProblems(spaCss: string): string[]
  ```
- Produces the commands `bun run lint:design` (fails) and `bun run lint:design:report` (prints). CI and pre-push run the REPORT variant until Task 13.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/__tests__/design-tokens.test.ts`:

```ts
import { contrastProblems, findEscapes } from "../design-tokens";

describe("findEscapes", () => {
  test("spa/client: arbitrary px and off-scale Tailwind sizes; sm/xs are aliases", () => {
    const src = `<p className="text-[13px] text-sm text-lg font-medium">x</p>\n<span className="text-xs text-[11.5px]">y</span>`;
    const found = findEscapes("spa", "a.tsx", src);
    expect(found.map((e) => e.found)).toEqual(["text-[13px]", "text-lg", "font-medium", "text-[11.5px]"]);
    expect(found[0]).toMatchObject({ file: "a.tsx", line: 1, use: "text-detail" });
    expect(found[1].use).toBe("text-heading or text-label");
    expect(found[2].use).toBe("font-strong or (regular) nothing");
    expect(found[3].use).toBe("text-caption");
  });

  test("spa/client: a hex or oklch literal outside styles.css", () => {
    const found = findEscapes("spa", "components/x.tsx", `const c = "#1d182a"; const d = "oklch(0.5 0.1 300)";`);
    expect(found).toHaveLength(2);
    expect(found[0].use).toBe("a colour token (var(--…) / a text-*/bg-* utility)");
  });

  test("spa/client: styles.css and dockview-theme.css are not scanned for literals", () => {
    expect(findEscapes("spa", "styles.css", `--background: #1d182a;`)).toEqual([]);
    expect(findEscapes("spa", "styles/dockview-theme.css", `color: #fff;`)).toEqual([]);
  });

  test("assistant: font-size and font-weight literals outside the token block", () => {
    const css = `:root {\n  --text-label: 15px;\n}\n.x {\n  font-size: 14.5px;\n  font-weight: 600;\n}\n.y { font-size: var(--text-body); }`;
    const found = findEscapes("assistant", "styles.css", css);
    expect(found.map((e) => e.found)).toEqual(["font-size: 14.5px", "font-weight: 600"]);
    expect(found[0].use).toBe("var(--text-body) or var(--text-label)");
    expect(found[1].use).toBe("var(--font-weight-strong)");
  });

  test("assistant: colour literals outside :root", () => {
    const css = `:root {\n  --background: oklch(0.2 0 0);\n}\n.x { color: #fff; }`;
    expect(findEscapes("assistant", "styles.css", css)).toHaveLength(1);
  });

  test("mobile: fontSize/fontWeight literals anywhere but tokens.ts", () => {
    expect(findEscapes("mobile", "app/x.tsx", `style={{ fontSize: 17, fontWeight: "500" }}`)).toHaveLength(2);
    expect(findEscapes("mobile", "src/lib/tokens.ts", `size: 17,`)).toEqual([]);
    expect(findEscapes("mobile", "app/y.tsx", `style={{ ...font("label") }}`)).toEqual([]);
  });

  test("mobile: hex literals outside tokens.ts", () => {
    expect(findEscapes("mobile", "app/x.tsx", `color: "#7abdff"`)).toHaveLength(1);
  });
});

describe("contrastProblems", () => {
  test("passes Dreamframe's muted-foreground on card and background", () => {
    const spa = `:root, .dark {\n  --background: oklch(0.224 0.035 296);\n  --card: oklch(0.255 0.032 296);\n  --muted-foreground: oklch(0.74 0.04 310);\n  --foreground: oklch(0.92 0.03 312);\n}`;
    expect(contrastProblems(spa)).toEqual([]);
  });

  test("fails a muted text that would not clear AA", () => {
    const spa = `:root, .dark {\n  --background: oklch(0.224 0.035 296);\n  --card: oklch(0.255 0.032 296);\n  --muted-foreground: oklch(0.45 0.04 310);\n  --foreground: oklch(0.92 0.03 312);\n}`;
    const problems = contrastProblems(spa);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("4.5");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test scripts/__tests__/design-tokens.test.ts`
Expected: FAIL — `findEscapes` and `contrastProblems` not exported.

- [ ] **Step 3: Implement the scanner and the contrast check**

Insert into `scripts/design-tokens.ts` after `mobileAgreement`:

```ts
// ---------------------------------------------------------------------------
// Escapes: the values that made the drift. One rule set per surface kind,
// each finding naming the role to use instead so the report is a to-do list.
// ---------------------------------------------------------------------------

export interface Escape {
  file: string;
  line: number;
  found: string;
  use: string;
}

/** Nearest role for a px size — what the message suggests, not a decision made for the author. */
function roleForPx(px: number, prefix: string, sep = " or "): string {
  if (px >= 26) return `${prefix}display`;
  if (px >= 17) return `${prefix}heading${sep}${prefix}label`;
  if (px > 14.5) return `${prefix}label`;
  if (px >= 13.5) return `${prefix}body${sep}${prefix}label`;
  if (px >= 12.5) return `${prefix}detail`;
  return `${prefix}caption`;
}

const HEX_OR_OKLCH = /#[0-9a-fA-F]{3,8}\b|oklch\(/g;

/**
 * Files that DEFINE colours are allowed literals; everything else consumes
 * tokens. The dockview theme and xterm consume the terminal trio raw by
 * design (spec § 3.2) and are not scanned.
 */
function isColourSource(surface: Surface, relPath: string): boolean {
  if (surface === "mobile") return relPath.endsWith("src/lib/tokens.ts");
  return relPath.endsWith("styles.css") || relPath.includes("dockview-theme") || relPath.includes("subshell-terminal");
}

export function findEscapes(surface: Surface, relPath: string, source: string): Escape[] {
  const out: Escape[] = [];
  const lines = source.split("\n");
  const push = (i: number, found: string, use: string) => out.push({ file: relPath, line: i + 1, found, use });

  if (surface === "spa" || surface === "client") {
    if (relPath.endsWith(".css")) return out; // Task 2/3 own the stylesheets; literals there are the tokens
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/\btext-\[([\d.]+)px\]/g)) push(i, m[0], roleForPx(Number(m[1]), "text-"));
      for (const m of l.matchAll(/\btext-(base|lg|xl|2xl|3xl)\b/g)) {
        const px = { base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30 }[m[1]] ?? 16;
        push(i, m[0], roleForPx(px, "text-"));
      }
      for (const m of l.matchAll(/\bfont-(medium|bold|extrabold|black)\b/g)) {
        push(i, m[0], m[1] === "medium" ? "font-strong or (regular) nothing" : "font-strong");
      }
      if (!isColourSource(surface, relPath)) {
        for (const m of l.matchAll(HEX_OR_OKLCH)) push(i, m[0], "a colour token (var(--…) / a text-*/bg-* utility)");
      }
    });
    return out;
  }

  if (surface === "assistant") {
    // Everything before the first `}` closes the `:root {}` token block.
    const tokenBlockEnd = lines.findIndex((l) => l.trim() === "}");
    lines.forEach((l, i) => {
      if (i <= tokenBlockEnd) return;
      const fs = /font-size:\s*([\d.]+)px/.exec(l);
      if (fs) push(i, fs[0], roleForPx(Number(fs[1]), "var(--text-", ") or ").replace(/(\w)$/, "$1)"));
      const fw = /font-weight:\s*(\d+)/.exec(l);
      if (fw) push(i, fw[0], Number(fw[1]) >= 500 ? "var(--font-weight-strong)" : "var(--font-weight-regular)");
      for (const m of l.matchAll(HEX_OR_OKLCH)) push(i, m[0], "a colour token in :root");
    });
    return out;
  }

  // mobile
  if (isColourSource(surface, relPath)) return out;
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/\bfontSize:\s*(\d+)/g)) push(i, m[0], `...font("${roleForPx(Number(m[1]), "").split(" or ")[0]}")`);
    for (const m of l.matchAll(/\bfontWeight:\s*"?\d+"?/g)) push(i, m[0], `...font("<role>") — weight comes with the role`);
    for (const m of l.matchAll(/#[0-9a-fA-F]{6}\b/g)) push(i, m[0], "colors.<role> from tokens.ts");
  });
  return out;
}

/** The files each surface's scanner walks. */
export const SURFACE_GLOBS: Record<Surface, { root: string; include: RegExp; exclude: RegExp }> = {
  spa: { root: "apps/server/web/src", include: /\.(tsx?|css)$/, exclude: /__tests__|\.test\./ },
  client: { root: "apps/client/desktop/ui/src", include: /\.(tsx?|css)$/, exclude: /__tests__|\.test\./ },
  assistant: { root: "apps/server/desktop/ui/src", include: /styles\.css$/, exclude: /__tests__/ },
  mobile: { root: "apps/client/mobile", include: /\.(tsx?)$/, exclude: /__tests__|\.test\.|node_modules|\.expo/ },
};

// ---------------------------------------------------------------------------
// Contrast: computed from the tokens, every run, rather than trusted from the
// day the palette was approved (spec § 5).
// ---------------------------------------------------------------------------

const AA = 4.5;

export function contrastProblems(spaCss: string): string[] {
  const t = parseCssTokens(spaCss);
  const rgb = (role: string) => {
    const v = t.colors[role];
    const o = v ? parseOklch(v) : null;
    return o ? oklchToSrgb(...o) : v?.startsWith("#") ? hexToSrgb(v) : null;
  };
  const problems: string[] = [];
  for (const [text, ground] of [
    ["muted-foreground", "card"],
    ["muted-foreground", "background"],
    ["foreground", "card"],
    ["foreground", "background"],
  ] as const) {
    const a = rgb(text);
    const b = rgb(ground);
    if (!a || !b) continue;
    const ratio = contrastRatio(a, b);
    if (ratio < AA) problems.push(`contrast: --${text} on --${ground} is ${ratio.toFixed(2)}:1, below AA ${AA}:1`);
  }
  return problems;
}
```

Then replace the `if (import.meta.main)` block with the full CLI:

```ts
import { readdirSync, statSync } from "node:fs";

function walk(dir: string, include: RegExp, exclude: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (exclude.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, include, exclude, out);
    else if (include.test(p)) out.push(p);
  }
  return out;
}

export function allEscapes(only?: Surface): Escape[] {
  const out: Escape[] = [];
  for (const [surface, g] of Object.entries(SURFACE_GLOBS) as [Surface, (typeof SURFACE_GLOBS)[Surface]][]) {
    if (only && only !== surface) continue;
    for (const abs of walk(join(REPO_ROOT, g.root), g.include, g.exclude)) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      out.push(...findEscapes(surface, rel.slice(g.root.length + 1), readFileSync(abs, "utf8")).map((e) => ({ ...e, file: rel })));
    }
  }
  return out;
}

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) as Surface | undefined;
  const agreement = await allAgreement(only);
  const escapes = allEscapes(only);
  const contrast = only && only !== "spa" ? [] : contrastProblems(readFileSync(join(REPO_ROOT, CSS_SURFACES.spa), "utf8"));
  const total = agreement.length + escapes.length + contrast.length;
  if (total === 0) {
    console.log("✓ design system: tokens agree, no escapes, contrast clears AA");
    process.exit(0);
  }
  const out = report ? console.log : console.error;
  out(`${report ? "•" : "✗"} ${total} design-system problem(s)\n`);
  if (agreement.length) {
    out(`  agreement (${agreement.length}):`);
    for (const p of agreement) out(`    ${p}`);
  }
  if (escapes.length) {
    out(`  escapes (${escapes.length}):`);
    for (const e of escapes) out(`    ${e.file}:${e.line}  ${e.found}  →  ${e.use}`);
  }
  if (contrast.length) {
    out(`  contrast (${contrast.length}):`);
    for (const p of contrast) out(`    ${p}`);
  }
  out(report ? "\n  (report mode — not failing; see docs/design-system.md)\n" : "\n  See docs/design-system.md for the roles.\n");
  process.exit(report ? 0 : 1);
}
```

Move the `import { readdirSync, statSync } from "node:fs";` up to the top of the file and merge it with the existing `import { readFileSync } from "node:fs";` → `import { readdirSync, readFileSync, statSync } from "node:fs";`.

- [ ] **Step 4: Run the tests**

Run: `bun test scripts/__tests__/design-tokens.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Run the full check in report mode and read the baseline**

Run: `bun scripts/design-tokens.ts --report 2>&1 | tail -40`
Expected: exit 0; `agreement` is empty; `escapes` lists roughly: assistant ~48 `font-size` + ~10 `font-weight` literals; SPA 16 `text-[…px]` + 10 `text-base/lg/2xl` + ~54 `font-medium/bold`; client 4 arbitrary; mobile ~48 `fontSize` + any `fontWeight`/hex. `contrast` is empty. Save this output — it is the to-do list for Tasks 7–12.

- [ ] **Step 6: Wire the scripts, CI and pre-push (report mode)**

In `package.json`, after the line `"lint:lockfile:fix": "bun scripts/lockfile-workspace-versions.ts --fix",` add:

```json
    "lint:design": "bun scripts/design-tokens.ts",
    "lint:design:report": "bun scripts/design-tokens.ts --report",
```

In `.github/workflows/lint.yml`, after the step `Check the per-path licence declarations` (`run: bun run lint:licenses`), add:

```yaml
      # The design system (docs/design-system.md): one type/colour vocabulary
      # across four surfaces, asserted from the token files rather than trusted
      # to a comment saying "copied verbatim". REPORT mode until the audits in
      # docs/superpowers/plans/2026-09-14-design-system.md land; Task 13 flips it.
      - name: Check the design tokens (report)
        run: bun run lint:design:report
```

In `lefthook.yml`, inside `pre-push: commands:`, after the `"licenses":` entry, add:

```yaml
    "design tokens":
      run: bun run lint:design:report
      tags:
        - lint
```

- [ ] **Step 7: Verify the wiring and commit**

Run: `bun run lint:design:report | tail -2 && echo "exit=$?"`
Expected: the report tail and `exit=0`.

```bash
bun run syncpack:format >/dev/null 2>&1 || true
bunx biome check --write scripts/design-tokens.ts scripts/__tests__/design-tokens.test.ts
bunx biome check scripts/
git add scripts/design-tokens.ts scripts/__tests__/design-tokens.test.ts package.json .github/workflows/lint.yml lefthook.yml
git commit -m "feat(scripts): lint:design refuses escapes and computes contrast; wired in report mode

The other two jobs of the check (spec § 6.2). Escapes are the values that
made the drift — \`text-[14.5px]\`, \`text-lg\`, \`font-medium\`, \`font-size:
13.5px\`, \`fontSize: 17\`, a hex outside a token file — each finding naming the
role to use instead. Contrast for muted-foreground on card and background is
computed from the tokens every run. CI and pre-push run \`--report\` until the
four surface audits land; the report printed today is their to-do list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 2 — The assistant to green

### Task 7: Assistant audit — 48 `font-size` literals to roles, weights to tokens, spacing to the 4px grid

**Files:**
- Modify: `apps/server/desktop/ui/src/styles.css`

**Interfaces:**
- Consumes: `var(--text-<role>)`, `var(--text-<role>--line-height)`, `var(--font-weight-strong|regular)` from Task 4.
- Verified by: `bun scripts/design-tokens.ts --only=assistant` going green.

- [ ] **Step 1: Read the to-do list for this surface**

Run: `bun scripts/design-tokens.ts --only=assistant --report`
Expected: ~58 escapes, all in `styles.css`. Keep it open.

- [ ] **Step 2: Apply the size mapping**

Every `font-size: Npx` in `styles.css` becomes `font-size: var(--text-<role>)` per this table (selector → role). Where a selector is not listed, use `roleForPx`'s suggestion from the report, and add the row to this table in your commit message.

| selector | today | role |
|---|---|---|
| `body` | 15 | `body` (14) |
| `label` | 15 | `label` |
| `.label` | 15 | `label` |
| `.facts` | 13.5 | `detail` |
| `.facts .fact-sub` | 12.5 | `caption` |
| `.hint` | 14 | `body` |
| `.pane-pre` | 13.5 | `detail` (monospace stays) |
| `.nav-item`, `.nav-group` | 14 | `body` |
| `.nav-item.child` | 13 | `detail` |
| `.sidebar-version`, `.pane-source`, `.group-heading`, `.install-line` | 12 | `caption` |
| `.section-title`, `.reset-title`, `.hero-state` | 19 / 19 / 20 | `heading` |
| `.section-lead`, `.about-lead`, `.wizard-copy`, `.switch`, `.choice-sub` | 14.5 | `body` |
| `.hero-sub`, `.step-body`, `.assistant-subtitle`, `.big`, `.install-head`, `.tmux-ready`, `.linkish.plain` | 15 | `.linkish.plain`, `.install-head`, `.tmux-ready`, `.big` → `label`; `.hero-sub`, `.step-body`, `.assistant-subtitle` → `body` |
| `.strip-line`, `.reset-steps`, `.assistant-problem`, `.linkish`, `.assistant details > summary`, `.tmux-warning` | 14 | `body` |
| `.assistant-title` | 30 | `display` |
| `.about-name` | 21 | `heading` |
| `.about-version`, `.tmux-warning code` | 13.5 | `detail` |
| `.about-license`, `.assistant-bar-right .reason`, `.supervision-copy .detail`, `.checklist .detail`, `.checklist .sub`, `.code-line`, `.pane-tabs button`, `.tmux-ready .glyph` | 13 | `detail` |
| `.about-copyright` | 12.5 | `caption` |

Where a rule sets `font-size` it should also set `line-height: var(--text-<role>--line-height);` unless the rule already sets an explicit line-height for a layout reason (e.g. `.assistant-title`'s tight heading) — in that case use the role's line-height token there too, since the token IS the layout value (1.2 for display/heading).

- [ ] **Step 3: Weights to tokens**

Every `font-weight: 600` → `font-weight: var(--font-weight-strong)`; every `font-weight: 400` → `font-weight: var(--font-weight-regular)`. There are no 500s in this file.

```bash
f=apps/server/desktop/ui/src/styles.css
sed -i '' -e 's/font-weight: 600;/font-weight: var(--font-weight-strong);/g' -e 's/font-weight: 400;/font-weight: var(--font-weight-regular);/g' "$f"
```

- [ ] **Step 4: Spacing onto the 4px grid**

```bash
grep -nE "\b(14|28|18|22|26|6|10)px" apps/server/desktop/ui/src/styles.css | grep -vE "font-size|--text-|border|radius|width: 1|height: 1" | head -40
```

For each hit that is a `gap`, `margin`, or `padding`: 14 → 16; 28 → 24 or 32 (24 where it is a margin under a heading, 32 where it separates sections); 18 → 16; 22 → 24; 26 → 24; 10 → 8 or 12 (8 for gaps inside a row, 12 for padding); 6 → 4 or 8. Do NOT change border widths, radii, icon sizes or the 20px glyph. Record each decision as a short comment only where it is not obvious.

- [ ] **Step 5: Verify — the check, the tests, and by eye**

Run: `bun scripts/design-tokens.ts --only=assistant`
Expected: `✓ design system: tokens agree, no escapes, contrast clears AA`.

Run: `cd apps/server/desktop/ui && bunx biome check --write src/styles.css && bun test 2>&1 | tail -3`
Expected: 0 fail.

Launch `bun run dev:desktop-server` and walk Welcome → tmux → Set Up; then open the recovery screen (`bun run reset:desktop`, relaunch, use "Reset" from the dashboard's danger card — or simply confirm the Set Up and About screens). The visible changes should be: paragraphs 15→14, headings 19/21→20, no half-pixel sizes; everything else identical. Quit with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add apps/server/desktop/ui/src/styles.css
git commit -m "refactor(desktop): the assistant on six type roles, two weights and the 4px grid

Forty-eight font-size literals — eleven distinct sizes, 12.5, 13.5 and 14.5
among them — become six role tokens; every weight is a token; 14 and 28px
gaps move to 16 and 24/32. The only visible movements: paragraphs 15→14
(body), headings 19/21→20, and the half-pixel sizes gone. \`lint:design
--only=assistant\` is green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 3 — The SPA and the client to green

### Task 8: SPA — the 16 arbitrary sizes to roles

**Files:**
- Modify (one line each unless noted):
  - `apps/server/web/src/components/subshell-terminal.tsx:741`
  - `apps/server/web/src/components/app-sidebar.tsx:553`
  - `apps/server/web/src/components/user-menu.tsx:59`
  - `apps/server/web/src/components/terminal-preview.tsx:26`
  - `apps/server/web/src/components/sidebar/SubshellRecentRow.tsx:38`
  - `apps/server/web/src/components/nodes/node-log-card.tsx:183`
  - `apps/server/web/src/components/setup/setup-assistant.tsx:85,89,103`
  - `apps/server/web/src/components/service/server-log-card.tsx:137`
  - `apps/server/web/src/components/service/supervision-card.tsx:101,107,108,192,195`

**Interfaces:**
- Consumes: `text-display`, `text-label`, `text-detail`, `text-caption`, `font-strong` (Task 2).

- [ ] **Step 1: Confirm the list**

Run: `bun scripts/design-tokens.ts --only=spa --report 2>&1 | grep "text-\["`
Expected: the 16 lines above.

- [ ] **Step 2: Replace each**

| file:line | replace | with |
|---|---|---|
| `setup-assistant.tsx:85` | `text-[30px]` | `text-display` |
| `setup-assistant.tsx:89` | `text-[15px]` | `text-body` (it is the subtitle paragraph — body, per spec § 3.1's "assistant subtitles become body") |
| `setup-assistant.tsx:103` | `text-[13px]` | `text-detail` |
| `supervision-card.tsx:107, 192` | `text-[15px]` | `text-label` |
| `supervision-card.tsx:108, 195` | `text-[13px]` | `text-detail` |
| `supervision-card.tsx:101` (the comment) | update the comment: it names `text-[15px]`/`text-[13px]`; say `text-label`/`text-detail` |
| `server-log-card.tsx:137` | `text-[12px]` | `text-caption` |
| `node-log-card.tsx:183` | `text-[11.5px]` | `text-caption` |
| `subshell-terminal.tsx:741`, `user-menu.tsx:59` | `text-[11px]` | `text-caption` |
| `app-sidebar.tsx:553`, `terminal-preview.tsx:26`, `SubshellRecentRow.tsx:38` | `text-[10px]` | `text-caption` (12 — the smallest role; 10px was below any readable floor) |

Also on `setup-assistant.tsx:85` change `font-semibold` → `font-strong`, and on `supervision-card.tsx:107,192` change `font-semibold` → `font-strong` (Task 10 does the rest of the weights; these lines are already open).

- [ ] **Step 3: Verify**

Run: `bun scripts/design-tokens.ts --only=spa --report 2>&1 | grep -c "text-\["`
Expected: `0`.

Run: `cd apps/server/web && bun test 2>&1 | tail -3`
Expected: 0 fail. If `setup-assistant.test.tsx` or `supervision-card.test.tsx` asserted a class name, update the assertion to the role utility.

- [ ] **Step 4: Commit**

```bash
git add apps/server/web/src
git commit -m "refactor(web): the sixteen arbitrary text sizes become roles

Seven distinct px values across nine files — 10, 11, 11.5, 12, 13, 15, 30 —
each reached for where the scale ran out. Three 10px chips become caption
(12): that was below any readable floor. The setup frame's title is display,
its subtitle body, the supervision card's rows label/detail.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: SPA — `text-base`/`text-lg`/`text-2xl` to roles

**Files:**
- Modify: `entity-card.tsx:72,78`, `page-header.tsx:23`, `route-error.tsx:66`, `about-dialog.tsx:52`, `ui/dialog.tsx:74`, `setup/agent-row.tsx:44`, `ui/sheet.tsx:75`, `routes/index.tsx:73`, `routes/presets.tsx:148` (all under `apps/server/web/src/components/` or `apps/server/web/src/routes/`)

- [ ] **Step 1: Confirm the list**

Run: `bun scripts/design-tokens.ts --only=spa --report 2>&1 | grep -E "text-(base|lg|2xl)"`
Expected: 10 lines.

- [ ] **Step 2: Replace**

| file:line | today | role | why |
|---|---|---|---|
| `page-header.tsx:23` | `text-2xl font-bold` | `text-heading font-strong` | page title = heading (20). Nothing in the product is louder than `display`, and a page header is not a display title |
| `routes/index.tsx:73` | `text-2xl font-bold` | `text-heading font-strong` | same |
| `ui/dialog.tsx:74`, `ui/sheet.tsx:75` | `text-lg font-semibold` | `text-heading font-strong` | dialog/sheet titles are headings |
| `agent-row.tsx:44` | `text-lg` (the emoji icon) | `text-heading` | it sizes an emoji; heading (20) matches the 18→20 nudge |
| `entity-card.tsx:72,78`, `route-error.tsx:66`, `about-dialog.tsx:52`, `routes/presets.tsx:148` | `text-base` | `text-label` if the element is a title/name of a thing (entity card name, preset group heading), `text-body` if it is prose (route-error message, about-dialog paragraph). Read each line and decide; record the decision in the commit. |

- [ ] **Step 3: Verify**

Run: `bun scripts/design-tokens.ts --only=spa --report 2>&1 | grep -cE "text-(base|lg|xl|2xl|3xl)"`
Expected: `0`.

Run: `cd apps/server/web && bun test 2>&1 | tail -3`
Expected: 0 fail (fix any class-name assertion in `page-header`/`dialog` tests to the role utility).

- [ ] **Step 4: Commit**

```bash
git add apps/server/web/src
git commit -m "refactor(web): Tailwind's off-scale text sizes become roles

text-2xl page titles and text-lg dialog titles are all \`heading\` — a page
header is not a display title, and nothing is louder than display. The five
text-base sites split into label (a thing's name) and body (prose).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: SPA — weights resolved to two

**Files:**
- Modify: every SPA file the report lists under `font-medium` / `font-bold` (≈20 files; the report is authoritative). Known: `ui/button.tsx`, `ui/label.tsx`, `ui/input.tsx`, `ui/card.tsx`, `ui/badge.tsx`, `subshell-manager-table.tsx`, `routes/users.tsx`, `settings/audit-trail-card.tsx`, `presets/preset-fields.tsx`, `app-sidebar.tsx`, `routes/presets.tsx`, `routes/preferences.tsx`, `workspace-header.tsx`, `user-menu.tsx`, `system-api-keys-card.tsx`, `subshell-picker/no-launch-targets.tsx`, `subshell-picker/existing-subshell-list.tsx`, `sidebar/SubshellRecentRow.tsx`, `setup/agent-row.tsx`, `service/dev-proxy-notice.tsx`, `route-error.tsx`, `presets/preset-list-row.tsx`, `routes/index.tsx:153`.

- [ ] **Step 1: Get the list**

Run: `bun scripts/design-tokens.ts --only=spa --report 2>&1 | grep -E "font-(medium|bold|semibold)"`
Expected: ~50 lines (`font-semibold` is not an escape — it is already 600 — but rename it to `font-strong` wherever you touch a file, for one name).

- [ ] **Step 2: Apply the rule to each `font-medium`**

**The rule:** is the element a *line item* — a form label, a row/entity title, a table header, a button or menu item label, a badge? → `font-strong`. Is it prose, a cell value, a description, a timestamp? → delete the class (regular is the default).

Decisions already known:
- `ui/button.tsx`, `ui/label.tsx`, `ui/badge.tsx`, `ui/card.tsx` (title) → `font-strong`
- `ui/input.tsx` → delete (an input's text is not a label)
- `subshell-manager-table.tsx` ×7: header cells → `font-strong`; body cells → delete
- `routes/users.tsx` ×4, `settings/audit-trail-card.tsx` ×4: same split (headers strong, values regular)
- `app-sidebar.tsx`, `SubshellRecentRow.tsx`, `preset-list-row.tsx`, `existing-subshell-list.tsx`: item names → `font-strong`
- `route-error.tsx`, `dev-proxy-notice.tsx`, `no-launch-targets.tsx`: prose → delete

Every `font-bold` → `font-strong`. Every `font-semibold` in a file you touch → `font-strong`.

- [ ] **Step 3: Verify**

Run: `bun scripts/design-tokens.ts --only=spa`
Expected: `✓ design system: tokens agree, no escapes, contrast clears AA` — the SPA is green.

Run: `cd apps/server/web && bun test 2>&1 | tail -3`
Expected: 0 fail. Tests asserting `font-medium` by class (grep `__tests__` for it) update to `font-strong` or to no class, matching the decision.

Run: `cd apps/server/web && bun run dev` and open the dashboard once — table headers, sidebar item names and buttons should read slightly heavier than before; body text unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/server/web/src
git commit -m "refactor(web): two weights — font-medium resolved to strong or nothing

Forty-three font-medium sites, each a per-callsite judgement of \"is this
emphasised?\". The rule: a line item (label, row title, table header, button,
badge) is strong; prose and values are regular. font-bold and font-semibold
are strong — nothing is louder than display. \`lint:design --only=spa\` is
green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Client node page — the four arbitrary sizes and any weights

**Files:**
- Modify: `apps/client/desktop/ui/src/components/enroll-fields.tsx:50`, `components/assistant/details-disclosure.tsx:62`, `components/assistant/frame.tsx:74,75`, plus any `font-medium`/`font-bold` the report lists.

- [ ] **Step 1: Get the list**

Run: `bun scripts/design-tokens.ts --only=client --report`

- [ ] **Step 2: Replace**

| file:line | today | role |
|---|---|---|
| `frame.tsx:74` | `text-[30px]` (+ any `font-semibold`) | `text-display font-strong` |
| `frame.tsx:75` | `text-[15px]` | `text-body` (subtitle) |
| `enroll-fields.tsx:50`, `details-disclosure.tsx:62` | `text-[11.5px]` | `text-caption` |
| every `font-medium` | apply Task 10's rule | `font-strong` or delete |

- [ ] **Step 3: Verify and commit**

Run: `bun scripts/design-tokens.ts --only=client` → green. `cd apps/client/desktop/ui && bun test 2>&1 | tail -3` → 0 fail.

```bash
git add apps/client/desktop/ui/src
git commit -m "refactor(desktop-client): the node page on roles

Its frame is the shared assistant frame, so its title is display and its
subtitle body, as the server assistant's are; the two 11.5px captions are
caption. \`lint:design --only=client\` is green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 4 — Mobile to green

### Task 12: Mobile — 48 `fontSize` literals to `font()`, colour literals to `colors`

**Files:**
- Modify: `apps/client/mobile/app/(tabs)/new.tsx` (10), `app/(tabs)/settings.tsx` (7), `app/connect.tsx` (6), `src/components/subshell-detail.tsx` (5), `src/components/subshell-card.tsx` (4), `src/components/devices-strip.tsx` (4), `src/components/key-bar.tsx` (3), `src/components/field.tsx` (3), `app/(tabs)/index.tsx` (3), `src/components/prompt-modal.tsx`, `src/components/live-host.tsx`, `app/sign-in.tsx` (1 each), plus any file the report lists for a hex literal or `fontWeight`.
- Modify: `apps/client/mobile/AGENTS.md` (the mirror section)

**Interfaces:**
- Consumes: `font(role)` and `colors.*` from `tokens.ts` (Task 5).

- [ ] **Step 1: Get the list**

Run: `bun scripts/design-tokens.ts --only=mobile --report`
Expected: ~48 `fontSize`, some `fontWeight`, possibly a few hex.

- [ ] **Step 2: Replace, using the mobile column**

Import in each file: `import { colors, font } from "@/lib/tokens";` (add `font`; `colors` is usually already imported).

Mapping from today's literal to the role, by the mobile column (spec § 3.1):

| today | role | typical site |
|---|---|---|
| 26, 28 | `display` | screen titles |
| 17, 16 (titles) | `heading` when it is a section title; `label` when it is a row/chip title; `body` when it is prose | read the site |
| 14 | `body` (16) — mobile body is larger than web's; a 14 on a phone was small | prose |
| 13 | `detail` | captions under labels, hints |
| 12, 11 | `caption` | chips, timestamps, mono |

For a style object `{ fontSize: 13, color: colors.mutedFg }` write `{ ...font("detail"), color: colors.mutedFg }`. Where a `fontWeight: "600"` sits with the size, delete it — the role carries the weight. Where a `fontWeight` sits WITHOUT a fontSize (rare), pick the role by what the text is and spread `font()`.

Any hex literal (`"#…"`) in a `.tsx` becomes the matching `colors.<key>`; if no key fits, the value is a new design decision — stop and add a documented key to `tokens.ts` rather than inventing it at the callsite.

- [ ] **Step 3: Verify**

Run: `bun scripts/design-tokens.ts --only=mobile`
Expected: green.

Run: `cd apps/client/mobile && bun test 2>&1 | tail -3` → 0 fail.

Run: `bun scripts/design-tokens.ts`
Expected: `✓ design system: tokens agree, no escapes, contrast clears AA` — all four surfaces green together.

Visual check: `apps/client/mobile/AGENTS.md` names the AVDs (`subshell_phone34`); launch it once and open New, Settings and a subshell. Expect the Dreamframe palette (indigo ground, orchid accents) replacing black/blue, and 16pt body text.

- [ ] **Step 4: Extend the mirror section of `apps/client/mobile/AGENTS.md`**

Find the section that lists the accepted divergences from web ("Two divergences from web are ACCEPTED here"). Immediately before it, add:

```markdown
**Tokens mirror the web by CHECK, not by comment.** `src/lib/tokens.ts` is the
mobile column of the design system (`docs/design-system.md`): the same six type
roles and ten colour roles as the web, at platform-native sizes. `bun run
lint:design` re-derives every colour from the SPA's oklch and fails if this
file drifts by more than one 8-bit step — because this file once said "port of
the web stylesheet" and was a whole palette behind. Consume type through
`font(role)` and colour through `colors.*`; the check refuses a literal
`fontSize` or hex anywhere else.
```

- [ ] **Step 5: Commit**

```bash
git add apps/client/mobile
git commit -m "refactor(mobile): the app on the mobile column — six roles, Dreamframe's colours

Forty-eight fontSize literals across twelve files become \`font(role)\`, and
body text moves to 16pt where it was 13–14: a phone is not a web page in a
wrapper. Every colour reads from tokens.ts, which is Dreamframe's again, so
the app matches the web for the first time since 2026-09-03. \`lint:design\`
is green on all four surfaces.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 5 — Flip, and write the reference

### Task 13: The lint fails; `docs/design-system.md`; the agents' rule; app pointers

**Files:**
- Modify: `.github/workflows/lint.yml`, `lefthook.yml` (report → failing)
- Create: `docs/design-system.md`
- Create: `.claude/rules/design-system.md`
- Modify: `apps/server/web/AGENTS.md`, `apps/server/desktop/AGENTS.md`, `apps/client/desktop/AGENTS.md`, `apps/client/mobile/AGENTS.md` (one line each)
- Modify: `AGENTS.md` (root — one line in the "Linting and Formatting" command list)

- [ ] **Step 1: Confirm green before flipping**

Run: `bun run lint:design && echo "exit=$?"`
Expected: `✓ design system: …` and `exit=0`. If not, a prior task is incomplete — stop and finish it; do not flip a red check.

- [ ] **Step 2: Flip CI and pre-push to the failing variant**

In `.github/workflows/lint.yml` change the step to:

```yaml
      # The design system (docs/design-system.md): one type/colour vocabulary
      # across four surfaces, asserted from the token files. A stray
      # `text-[13px]`, `font-size: 14.5px` or `fontSize: 17` is not a type,
      # lint or test failure — this is the only thing that sees it.
      - name: Check the design tokens
        run: bun run lint:design
```

In `lefthook.yml` change `run: bun run lint:design:report` → `run: bun run lint:design`.

In the root `AGENTS.md`, in the `### Linting and Formatting` command block, after the `bun run lint:lockfile` line add:

```
bun run lint:design        # the design system: tokens agree, no escapes, contrast clears AA
```

- [ ] **Step 3: Write `docs/design-system.md`**

```markdown
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

## Colour — Dreamframe, under one set of names

Values: `docs/superpowers/specs/2026-09-03-dreamframe-theme-design.md`. Names,
everywhere: `background`, `card`, `border`, `foreground`, `muted-foreground`,
`primary`, `primary-foreground`, `success`, `warning`, `destructive`. Mobile
uses the same roles in camelCase (`mutedFg`, `primaryFg`) as hex derived from
the web's oklch — and `lint:design` re-derives them every run. Status colours
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
```

- [ ] **Step 4: Write `.claude/rules/design-system.md`**

```markdown
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

Line items are `label` over `detail`, differing by weight and colour; long
actions show the process's own last line; failures render on the thing that
failed. The full pattern list, each with the defect it closes, is in the
reference.
```

- [ ] **Step 5: One line in each app's `AGENTS.md`**

Add to each of `apps/server/web/AGENTS.md`, `apps/server/desktop/AGENTS.md`, `apps/client/desktop/AGENTS.md`, `apps/client/mobile/AGENTS.md`, near the top (after the first heading's introductory paragraph):

```markdown
**Styling follows `docs/design-system.md`** — six type roles, two weights,
shadcn colour names — and `bun run lint:design` fails on a literal size,
weight or colour outside the token file. Pick a role, never a number.
```

- [ ] **Step 6: Verify everything and commit**

Run: `bun run lint:design && bun run verify-types && bun run lint:check && bun run test:scripts`
Expected: all green.

```bash
bunx biome check scripts/
git add .github/workflows/lint.yml lefthook.yml docs/design-system.md .claude/rules/design-system.md AGENTS.md apps/server/web/AGENTS.md apps/server/desktop/AGENTS.md apps/client/desktop/AGENTS.md apps/client/mobile/AGENTS.md
git commit -m "docs: the design system reference; lint:design now fails

All four surfaces are green, so the check stops reporting and starts
refusing — in CI and on pre-push, beside lint:licenses. docs/design-system.md
is written from what the code now enforces: six type roles at two weights,
Dreamframe under shadcn's names, the 4px grid, ten patterns each with the
defect it closed, the accessibility rules. .claude/rules/design-system.md
loads the short form into every session; each app's AGENTS.md points at it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes (already applied)

- **Spec coverage:** § 3.1 → Tasks 1, 2, 4, 5, 7–12; § 3.2 → Tasks 4, 5; § 3.3 → Task 7 (grid), Task 13 (documented; radius/motion/targets were already in place); § 4–5 → Task 13 (documented; the patterns were implemented in the 2026-09-14 FTE commits that preceded this plan); § 6.1 → Tasks 2–5; § 6.2 → Tasks 1, 5, 6; § 6.3 → Task 13; § 7 phases → the five phase headings; § 8 (shared package) is out of scope by the spec's own ruling.
- **Names used consistently:** `TYPE_ROLES`, `WEB_SCALE`, `MOBILE_SCALE`, `COLOR_ROLES`, `parseCssTokens`, `agreementProblems`, `mobileAgreement`, `findEscapes`, `contrastProblems`, `allAgreement`, `allEscapes`, `font()`, `type`, `colors`, `text-<role>`, `font-strong`/`font-regular`, `--text-<role>`, `--text-<role>--line-height`, `--font-weight-strong`/`--font-weight-regular`.
- **A known judgement the plan delegates on purpose:** Task 10's `font-medium` resolution and Task 12's 16/17-pt role choice are rules with listed decisions, not per-line prescriptions — the executor reads the element and applies the rule, recording the decision in the commit.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agreementProblems,
  allAgreement,
  COLOR_ROLES,
  CSS_SURFACES,
  contrastProblems,
  contrastRatio,
  cssColorAgreement,
  findEscapes,
  hexToSrgb,
  MOBILE_SCALE,
  mobileAgreement,
  oklchToSrgb,
  parseCssTokens,
  parseOklch,
  REPO_ROOT,
  SCAN_ROOTS,
  SHARED_TOKENS,
  SURFACE_GLOBS,
  sharedImportProblems,
  sharedRedeclarationProblems,
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
  --font-weight-strong: 600;
  --font-weight-regular: 400;
}
`;

describe("the scales", () => {
  test("declare exactly the five roles, in the spec's order", () => {
    // `caption` (12px) was dropped 2026-09-14 as too small to read; `detail`
    // absorbed it and is the floor.
    expect([...TYPE_ROLES]).toEqual(["display", "heading", "label", "body", "detail"]);
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
    // The floor. Nothing on any surface is smaller than this.
    expect(Math.min(...Object.values(WEB_SCALE).map((s) => s.size))).toBe(13);
    expect(Math.min(...Object.values(MOBILE_SCALE).map((s) => s.size))).toBe(13);
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
    const t = parseCssTokens(
      `:root {\n  /* ground */\n\n  --background: #1d182a;\n  --text-body: 14px; /* trailing */\n}`,
    );
    expect(t.colors.background).toBe("#1d182a");
    expect(t.text.body?.size).toBe(14);
  });
});

describe("agreementProblems", () => {
  test("is empty for a complete, correct surface", () => {
    expect(agreementProblems("spa", parseCssTokens(SPA_LIKE), WEB_SCALE)).toEqual([]);
  });

  test("names a missing role, a wrong size and a wrong weight, each once", () => {
    const broken = SPA_LIKE.replace("--text-detail: 13px;", "")
      .replace("--text-detail--line-height: 1.5;", "")
      .replace("--text-label: 15px;", "--text-label: 14px;")
      .replace("--font-weight-strong: 600;", "--font-weight-strong: 500;");
    const problems = agreementProblems("spa", parseCssTokens(broken), WEB_SCALE);
    expect(problems).toContainEqual(expect.stringContaining("detail"));
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

describe("cssColorAgreement", () => {
  const spa = `:root, .dark {\n  --card: oklch(0.255 0.032 296);\n  --success: oklch(0.765 0.177 163.223);\n}`;

  test("is empty when a surface's colour values equal the SPA's", () => {
    expect(cssColorAgreement(spa, { assistant: spa })).toEqual([]);
  });

  test("names a role whose VALUE differs, even under the same name", () => {
    // The gap the first wave left open: the assistant carried six values that
    // were "near-Dreamframe tuning" under Dreamframe's names, and a check that
    // compared names only called that agreement. A shared vocabulary with
    // private values is the drift the system exists to end, wearing its
    // uniform.
    const tuned = spa.replace("oklch(0.765 0.177 163.223)", "oklch(0.74 0.14 155)");
    const problems = cssColorAgreement(spa, { assistant: tuned });
    expect(problems).toEqual([expect.stringContaining("assistant: --success is oklch(0.74 0.14 155)")]);
    expect(problems[0]).toContain("oklch(0.765 0.177 163.223)");
  });

  test("ignores whitespace and a role the SPA itself lacks", () => {
    const spaced = spa.replace("oklch(0.255 0.032 296)", "oklch( 0.255  0.032 296 )");
    expect(cssColorAgreement(spa, { client: spaced })).toEqual([]);
    // A role missing from the SPA is the SPA's own agreement problem, not a
    // disagreement with it.
    expect(cssColorAgreement(spa, { client: `${spa}\n:root { --warning: oklch(0.8 0.14 80); }` })).toEqual([]);
  });
});

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

describe("findEscapes", () => {
  test("spa/client: arbitrary px and off-scale Tailwind sizes; only sm is an alias", () => {
    const src = `<p className="text-[13px] text-sm text-lg font-medium">x</p>\n<span className="text-xs text-[11.5px]">y</span>`;
    const found = findEscapes("spa", "a.tsx", src);
    expect(found.map((e) => e.found)).toEqual(["text-[13px]", "text-lg", "font-medium", "text-[11.5px]", "text-xs"]);
    expect(found[0]).toMatchObject({ file: "a.tsx", line: 1, use: "text-detail" });
    expect(found[1].use).toBe("text-heading or text-label");
    expect(found[2].use).toBe("font-strong or (regular) nothing");
    // 11.5px used to be answered with `text-caption`; the floor is detail now.
    expect(found[3].use).toBe("text-detail");
  });

  test("spa/client: text-xs and text-caption are refused, not aliased", () => {
    // Load-bearing: Tailwind still GENERATES `.text-xs` from its own defaults
    // even with `--text-xs` deleted, so the utility survives as
    // `font-size: var(--text-xs)` with nothing defining it — the element
    // silently inherits. Deleting the token is not enough; the source has to
    // be refused.
    for (const cls of ["text-xs", "text-caption"]) {
      const found = findEscapes("spa", "a.tsx", `<p className="${cls}">x</p>`);
      expect(found).toHaveLength(1);
      expect(found[0]?.found).toBe(cls);
      expect(found[0]?.use).toContain("text-detail");
    }
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

  test("terminal trio consumers are exempt by exact path, not by pattern", () => {
    // These files hold ANSI/xterm palette literals that MUST stay raw to
    // match what xterm renders (plan Global Constraints). The clause that
    // exempts them is live code, so each of its three arms is pinned here —
    // deleting any one must turn this test red. Paths are relative to each
    // surface's SURFACE_GLOBS root, exactly as allEscapes passes them.
    expect(findEscapes("spa", "components/subshell-terminal.tsx", `const bg = "#1d182a";`)).toEqual([]);
    expect(findEscapes("spa", "lib/ansi.ts", `const fg = "#1d182a"; const o = "oklch(0.5 0.1 300)";`)).toEqual([]);
    expect(findEscapes("mobile", "scripts/sync-terminal-assets.ts", `color: "#7abdff"`)).toEqual([]);
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
    // Short hex and oklch() are the same escape as a 6-digit hex — every
    // colour spelling a mobile consumer reaches for must instead come from
    // tokens.ts, so the mobile branch shares the web's HEX_OR_OKLCH rule.
    expect(findEscapes("mobile", "app/x.tsx", `color: "#fff"`)).toHaveLength(1);
    expect(findEscapes("mobile", "app/x.tsx", `color: "oklch(0.5 0.1 300)"`)).toHaveLength(1);
    expect(findEscapes("mobile", "src/lib/tokens.ts", `bg: "#1d182a",`)).toEqual([]);
  });
});

describe("optional roles are compared when present", () => {
  test("a hex-valued web token is compared to mobile, not silently skipped", () => {
    // `--scrim` is a hex with alpha (black at 70%, not a tint of the palette),
    // and the mobile comparison converts oklch→hex — so a hex on the web side
    // hit `parseOklch() === null` and fell through the `continue`. The value
    // agreed only because it had just been set by hand, which is the state
    // this whole check exists to stop trusting.
    const spa = `:root, .dark {\n  --scrim: #000000b3;\n}`;
    const ok = { colors: { scrim: "#000000b3" }, type: {} };
    const drifted = { colors: { scrim: "#000000aa" }, type: {} };
    expect(mobileAgreement(spa, ok).filter((p) => p.includes("scrim"))).toEqual([]);
    expect(mobileAgreement(spa, drifted).filter((p) => p.includes("scrim"))).toHaveLength(1);
  });

  test("a surface that simply lacks the optional role is not a problem", () => {
    // The assistant has no modal and declares no scrim; absence is not drift.
    const spa = `:root, .dark {\n  --scrim: #000000b3;\n}`;
    expect(cssColorAgreement(spa, { assistant: `:root {\n  --background: oklch(0.2 0 0);\n}` })).toEqual([]);
  });

  test("but a surface that declares it must match", () => {
    const spa = `:root, .dark {\n  --scrim: #000000b3;\n}`;
    expect(cssColorAgreement(spa, { client: `:root {\n  --scrim: #000000aa;\n}` })).toHaveLength(1);
  });
});

describe("colour WORDS are escapes too", () => {
  test("bg-black/70 and friends are refused, with the token named", () => {
    // The one colour literal the scanner could not see: it matches hex and
    // oklch, and Tailwind's named utilities are neither. `bg-black/70` sat in
    // dialog.tsx and sheet.tsx — the same value written twice, invisible to a
    // check whose whole job is finding exactly that.
    const found = findEscapes("spa", "components/ui/dialog.tsx", `<div className="fixed inset-0 bg-black/70" />`);
    expect(found).toHaveLength(1);
    expect(found[0].found).toBe("bg-black/70");
    expect(found[0].use).toContain("scrim");
  });

  test("names the roles for white and for a bare black", () => {
    const found = findEscapes("spa", "x.tsx", `<p className="bg-white text-black border-white/20" />`);
    expect(found.map((e) => e.found)).toEqual(["bg-white", "text-black", "border-white/20"]);
    expect(found[0].use).toContain("--");
  });

  test("does not fire on words that merely contain a colour name", () => {
    // `text-blackboard` is not `text-black`, and a utility this rule does not
    // know is not this rule's business.
    expect(findEscapes("spa", "x.tsx", `className="bg-background text-foreground border-border"`)).toEqual([]);
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

describe("the shared token file", () => {
  const shared = readFileSync(join(REPO_ROOT, SHARED_TOKENS), "utf8");

  test("every colour role the system requires is declared once, in the shared file", () => {
    const t = parseCssTokens(shared);
    for (const role of COLOR_ROLES) expect(t.colors[role]).toBeDefined();
    // scrim is optional per surface but must have one value to be optional against.
    expect(t.colors.scrim).toBe("#000000b3");
  });

  test("names a surface that re-declares a shared colour with a near-miss value", () => {
    // The assistant once carried six "near-Dreamframe" values under Dreamframe's
    // names; comparing names only called that agreement. Same guard, now that
    // the colours live in one file.
    const tuned = ":root {\n  --warning: oklch(0.828 0.189 90);\n}";
    expect(sharedRedeclarationProblems("assistant", shared, tuned)).toEqual([
      expect.stringContaining("assistant: --warning is oklch(0.828 0.189 90)"),
    ]);
  });

  test("tolerates a surface restating a shared value identically", () => {
    // Tailwind's @theme block re-states the type roles literally in several
    // files; that is a build convention, and var() indirection does not work
    // there. Only a different value is drift.
    const t = parseCssTokens(shared);
    const same = `:root {\n  --warning: ${t.colors.warning};\n  --text-label: 15px;\n}`;
    expect(sharedRedeclarationProblems("client", shared, same)).toEqual([]);
  });

  test("names a type role or weight a surface restates at a different value", () => {
    expect(sharedRedeclarationProblems("spa", shared, ":root {\n  --text-detail: 12px;\n}")).toEqual([
      expect.stringContaining("--text-detail is 12px"),
    ]);
    expect(sharedRedeclarationProblems("spa", shared, ":root {\n  --font-weight-strong: 700;\n}")).toEqual([
      expect.stringContaining("--font-weight-strong is 700"),
    ]);
  });

  test("the three real surfaces still resolve a complete palette through the import", () => {
    // The refactor's risk is a role that existed only in a surface file and now
    // exists nowhere: each surface read as shared-plus-own must still satisfy
    // every required role and clear contrast.
    for (const surface of ["spa", "client", "assistant"] as const) {
      const merged = `${shared}\n${readFileSync(join(REPO_ROOT, CSS_SURFACES[surface]), "utf8")}`;
      expect(agreementProblems(surface, parseCssTokens(merged), WEB_SCALE)).toEqual([]);
    }
    expect(contrastProblems(`${shared}\n${readFileSync(join(REPO_ROOT, CSS_SURFACES.spa), "utf8")}`)).toEqual([]);
  });
});

describe("the shared palette as a build input", () => {
  test("turbo treats it as a global dependency", () => {
    // Every CSS surface imports `packages/assistant/tokens.css`, and the macOS
    // helper panel ships the built result inside a signed bundle. Without this,
    // a commit that edits only the palette hits a warm cache, serves the old
    // inlined stylesheet, and `bun run lint:design` still passes: the checker
    // reads sources, and the shipped bytes are whatever the cache held.
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")) as {
      globalDependencies?: string[];
    };
    expect(turbo.globalDependencies).toContain(SHARED_TOKENS);
  });
});

describe("a package page that joins a surface", () => {
  test("the helper panel is walked under the assistant rules, by name", () => {
    // Nothing else checks the registration itself. A scan root pointing at a
    // moved directory, or a stylesheet whose name the surface's include glob
    // never matches, leaves that page unswept while `lint:design` still prints
    // its green tick, which is how "extracted into a package" has historically
    // meant "escaped the role system".
    expect(SCAN_ROOTS.assistant).toContain("packages/helper-panel/src");
    expect(existsSync(join(REPO_ROOT, "packages/helper-panel/src/styles.css"))).toBe(true);
    expect(SURFACE_GLOBS.assistant.include.test("styles.css")).toBe(true);
  });
});

test("every shipped CSS surface imports the shared palette and the agreement pipeline checks it", async () => {
  for (const surface of Object.keys(CSS_SURFACES) as (keyof typeof CSS_SURFACES)[]) {
    const css = readFileSync(join(REPO_ROOT, CSS_SURFACES[surface]), "utf8");
    expect(sharedImportProblems(surface, css)).toEqual([]);
    expect(sharedImportProblems(surface, css.replace(/^@import[^;]*tokens\.css[^;]*;/m, ""))).toHaveLength(1);
  }
  const panel = readFileSync(join(REPO_ROOT, "packages/helper-panel/src/styles.css"), "utf8");
  expect(panel).toContain('@import "../../assistant/tokens.css";');
  expect(await allAgreement()).toEqual([]);
});

test("the agreement pipeline rejects missing imports and local palette overrides", async () => {
  const fixture = mkdtempSync("/tmp/subshell-tokens-");
  const files = [...Object.values(CSS_SURFACES), SHARED_TOKENS, "packages/helper-panel/src/styles.css"];
  try {
    for (const file of files) {
      const destination = join(fixture, file);
      mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
      writeFileSync(destination, readFileSync(join(REPO_ROOT, file), "utf8"));
    }
    const assistant = join(fixture, CSS_SURFACES.assistant);
    const original = readFileSync(assistant, "utf8");
    writeFileSync(assistant, original.replace(/^@import[^;]*tokens\.css[^;]*;/m, ""));
    expect(await allAgreement("assistant", fixture)).toContain(
      `assistant: import ${SHARED_TOKENS} before declaring local tokens`,
    );
    writeFileSync(assistant, `${original}\n:root {\n  --primary: red;\n}\n`);
    expect(
      (await allAgreement("assistant", fixture)).some((line) =>
        line.includes("--primary is red, but packages/assistant/tokens.css sets"),
      ),
    ).toBe(true);
    writeFileSync(assistant, original);
    const panel = join(fixture, "packages/helper-panel/src/styles.css");
    const originalPanel = readFileSync(panel, "utf8");
    writeFileSync(panel, originalPanel.replace(/^@import[^;]*tokens\.css[^;]*;/m, ""));
    expect(await allAgreement("assistant", fixture)).toContain(
      `helper-panel: import ${SHARED_TOKENS} before declaring local tokens`,
    );
    writeFileSync(panel, `${originalPanel}\n:root {\n  --primary: red;\n}\n`);
    expect(
      (await allAgreement("assistant", fixture)).some((line) =>
        line.includes("helper-panel: --primary is red, but packages/assistant/tokens.css sets"),
      ),
    ).toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

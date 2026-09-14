import { describe, expect, test } from "bun:test";
import {
  agreementProblems,
  COLOR_ROLES,
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

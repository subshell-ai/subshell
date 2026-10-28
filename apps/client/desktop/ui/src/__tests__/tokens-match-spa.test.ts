import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLOR_ROLES } from "../../../../../../scripts/design-tokens";

/**
 * Until 2026-10-27 this stylesheet's palette was "COPIED VERBATIM from
 * apps/server/web/src/styles.css", its own header said so, and nothing checked
 * it until mobile made the same claim and drifted a whole palette behind it
 * (spec 2026-09-14 § 1). The colours now live in one file,
 * `packages/assistant/tokens.css`, which every surface imports, so "verbatim"
 * is structural rather than a promise. What is left to check is that both
 * surfaces really do import it, that the shared file carries the roles, and
 * that each surface's own block still matches the other's.
 *
 * Compared per block: every `--name: value;` declaration in `:root, .dark` and
 * every one in `@theme inline`, EXCEPT the terminal trio (`--terminal-*` and
 * their `--color-terminal-*` aliases), which this page has no terminal for.
 * Comments and blank lines are not compared; the two files may explain
 * themselves differently.
 */
const HERE = import.meta.dir;
const CLIENT = join(HERE, "../styles.css");
const SPA = join(HERE, "../../../../../server/web/src/styles.css");
// HERE is ui/src/__tests__: five levels up is apps/, six is the repo root.
const SHARED = join(HERE, "../../../../../../packages/assistant/tokens.css");

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
  const shared = readFileSync(SHARED, "utf8");

  test("both surfaces import the one palette rather than restating it", () => {
    expect(spa).toContain('@import "../../../../packages/assistant/tokens.css";');
    expect(client).toContain('@import "../../../../../packages/assistant/tokens.css";');
  });

  test("the shared file declares every colour role the system requires", () => {
    const declared = declarations(shared, /^:root \{/m);
    for (const role of COLOR_ROLES) {
      expect(
        declared.some((d) => d.startsWith(`--${role}:`)),
        `--${role} missing from ${SHARED}`,
      ).toBe(true);
    }
  });

  test("neither surface shadows a shared colour with its own value", () => {
    // A local restatement wins on cascade order, which is how a surface gets a
    // private palette while importing everyone else's.
    const sharedDecls = new Set(declarations(shared, /^:root \{/m));
    for (const [name, css] of [
      ["spa", spa],
      ["client", client],
    ] as const) {
      for (const decl of declarations(css, /^:root,\n\.dark \{/m)) {
        if (decl.includes("var(")) continue;
        const role = decl.slice(2, decl.indexOf(":")).trim();
        if (COLOR_ROLES.includes(role as (typeof COLOR_ROLES)[number])) {
          expect(sharedDecls.has(decl), `${name} re-declares --${role} locally`).toBe(true);
        }
      }
    }
  });

  test(":root, .dark declares the same values, terminal trio aside", () => {
    expect(declarations(client, /^:root,\n\.dark \{/m)).toEqual(declarations(spa, /^:root,\n\.dark \{/m));
  });

  test("@theme inline declares the same tokens, terminal trio aside", () => {
    expect(declarations(client, /^@theme inline \{/m)).toEqual(declarations(spa, /^@theme inline \{/m));
  });

  test("and there is something to compare", () => {
    // A regex that stops matching would make both lists empty and the
    // equalities above vacuous. The colours left for the shared file, so the
    // floor is the surface's own extras (button gradients, tints, aliases).
    expect(declarations(spa, /^:root,\n\.dark \{/m).length).toBeGreaterThan(10);
    expect(declarations(spa, /^@theme inline \{/m).length).toBeGreaterThan(20);
    expect(declarations(shared, /^:root \{/m).length).toBeGreaterThan(COLOR_ROLES.length - 1);
  });
});

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
const SPA = join(HERE, "../../../../../server/web/src/styles.css");

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

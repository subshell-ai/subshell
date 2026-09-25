import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proseOf, violations } from "../prose-dashes.ts";

/**
 * prose-dashes is the repository-prose twin of the docs site's em-dash ban
 * (operator ruling 2026-09-25). What is pinned: the prose/exempt split (fence
 * and inline-code content may carry U+2014; prose may not), the exclusion
 * rules that keep dated records, generated CHANGELOGs and vendored skills out
 * of the gate's reach, and the CURRENT TREE CLEANLINESS — the rule is
 * enforced from the day it lands, so a new dash in current prose fails here
 * and in CI, not at review.
 */

const D = "—";

describe("proseOf", () => {
  test("keeps prose and drops fenced blocks", () => {
    const src = [`intro ${D} still here`, "```", `code ${D} exempt`, "```", "outro"].join("\n");
    const prose = proseOf(src);
    expect(prose).toContain("intro");
    expect(prose).not.toContain("exempt");
    expect(prose.match(new RegExp(D, "g"))?.length).toBe(1);
  });

  test("drops inline code spans", () => {
    const src = `prose ${D} stays and \`code ${D} goes\``;
    expect(proseOf(src).match(new RegExp(D, "g"))?.length).toBe(1);
  });

  test("an unterminated fence swallows the rest (a dangling fence is checked as code, not prose)", () => {
    const src = `head ${D}\n\`\`\`\nnever closed ${D}`;
    // The opening fence runs to EOF; only the head is prose.
    expect(proseOf(src).match(new RegExp(D, "g"))?.length).toBe(1);
  });
});

describe("exclusions", () => {
  const read = () => `prose ${D}`;
  test("dated specs and plans are records, not live prose", () => {
    expect(violations(["docs/superpowers/specs/x.md"], read)).toEqual([]);
  });
  test("generated CHANGELOGs are regenerated from the changesets, not hand-edited", () => {
    expect(violations(["apps/server/api/CHANGELOG.md"], read)).toEqual([]);
  });
  test("vendored skills and the cache are not our voice", () => {
    expect(violations([".agents/skills/foo/SKILL.md", ".claude/cache/thing.md"], read)).toEqual([]);
  });
  test("the site's content is the content test's job", () => {
    expect(violations(["apps/docs/content/docs/index.mdx.md"], read)).toEqual([]);
  });
  test("everything else is seen", () => {
    expect(violations(["docs/security.md"], read)).toEqual([{ file: "docs/security.md", count: 1 }]);
  });
});

describe("the current tree", () => {
  test("no authored prose file carries an em dash", () => {
    const root = join(import.meta.dir, "..", "..");
    const listed = Bun.spawnSync(["git", "ls-files", "--", "*.md"], { cwd: root });
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout.toString().split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(50); // ls-files actually found the corpus
    const found = violations(files, (p) => readFileSync(join(root, p), "utf8"));
    expect(found.map((v) => `${v.file}: ${v.count}`)).toEqual([]);
  });
});

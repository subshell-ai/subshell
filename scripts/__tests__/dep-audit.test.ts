import { describe, expect, test } from "bun:test";
import { advisoriesFrom, evaluate, ghsaFromUrl, type IgnoreEntry } from "../dep-audit";

const url = (ghsa: string) => `https://github.com/advisories/${ghsa}`;

const raw = (
  pkg: string,
  ghsa: string,
  over: { title?: string; severity?: string } = {},
): [string, { url: string; title: string; severity: string }[]] => [
  pkg,
  [{ url: url(ghsa), title: `${pkg}: thing`, severity: "high", ...over }],
];

const entry = (pkg: string, advisories: string[], reason = "dev-only tooling"): IgnoreEntry => ({
  package: pkg,
  advisories,
  reason,
});

describe("ghsaFromUrl", () => {
  test("extracts the id from an advisory URL", () => {
    expect(ghsaFromUrl(url("GHSA-w3rx-r6r6-pgpr"))).toBe("GHSA-w3rx-r6r6-pgpr");
  });
  test("is empty for a missing or non-GHSA URL", () => {
    expect(ghsaFromUrl(undefined)).toBe("");
    expect(ghsaFromUrl("https://example.com/advisory")).toBe("");
  });
});

describe("advisoriesFrom", () => {
  test("normalises bun audit --json to package → advisories", () => {
    const live = advisoriesFrom(Object.fromEntries([raw("left-pad", "GHSA-aaaa-bbbb-cccc")]));
    expect(live.get("left-pad")?.[0]).toEqual({
      ghsa: "GHSA-aaaa-bbbb-cccc",
      title: "left-pad: thing",
      severity: "high",
    });
  });
});

describe("evaluate", () => {
  test("live subset of the allowlist passes with nothing stale", () => {
    const live = advisoriesFrom(Object.fromEntries([raw("a", "GHSA-aaaa-aaaa-aaaa"), raw("b", "GHSA-bbbb-bbbb-bbbb")]));
    const v = evaluate(live, [entry("a", ["GHSA-aaaa-aaaa-aaaa"]), entry("b", ["GHSA-bbbb-bbbb-bbbb"])]);
    expect(v.violations).toEqual([]);
    expect(v.stalePackages).toEqual([]);
    expect(v.staleAdvisories).toEqual([]);
  });

  test("an advisory with no allowlist entry is a violation naming it", () => {
    const live = advisoriesFrom(
      Object.fromEntries([raw("a", "GHSA-aaaa-aaaa-aaaa"), raw("newpkg", "GHSA-nwne-nwne-nwnw")]),
    );
    const v = evaluate(live, [entry("a", ["GHSA-aaaa-aaaa-aaaa"])]);
    expect(v.violations).toHaveLength(1);
    expect(v.violations[0]?.pkg).toBe("newpkg");
    expect(v.violations[0]?.advisory.ghsa).toBe("GHSA-nwne-nwne-nwnw");
  });

  test("an allowlisted package still reports its OTHER advisories", () => {
    const live = advisoriesFrom(
      Object.fromEntries([
        [
          "a",
          [
            { url: url("GHSA-aaaa-aaaa-aaaa"), title: "one", severity: "low" },
            { url: url("GHSA-zzzz-zzzz-zzzz"), title: "two", severity: "critical" },
          ],
        ],
      ]),
    );
    const v = evaluate(live, [entry("a", ["GHSA-aaaa-aaaa-aaaa"])]);
    expect(v.violations.map((x) => x.advisory.ghsa)).toEqual(["GHSA-zzzz-zzzz-zzzz"]);
  });

  test("titles match as well as ids", () => {
    const live = advisoriesFrom(Object.fromEntries([raw("a", "GHSA-aaaa-aaaa-aaaa")]));
    const v = evaluate(live, [entry("a", ["a: thing"])]);
    expect(v.violations).toEqual([]);
    expect(v.staleAdvisories).toEqual([]);
  });

  test("an allowlisted package with no live advisories is stale", () => {
    const v = evaluate(advisoriesFrom({}), [entry("gone", ["GHSA-gone-gone-gone"])]);
    expect(v.violations).toEqual([]);
    expect(v.stalePackages).toEqual(["gone"]);
  });

  test("a listed advisory string that no longer matches is stale", () => {
    const live = advisoriesFrom(Object.fromEntries([raw("a", "GHSA-1111-1111-1111")]));
    const v = evaluate(live, [entry("a", ["GHSA-1111-1111-1111", "GHSA-oldp-oldp-oldp"])]);
    expect(v.violations).toEqual([]);
    expect(v.stalePackages).toEqual([]);
    expect(v.staleAdvisories).toEqual([{ pkg: "a", entry: "GHSA-oldp-oldp-oldp" }]);
  });

  test("a clean audit against an empty allowlist passes", () => {
    const v = evaluate(advisoriesFrom({}), []);
    expect(v.violations).toEqual([]);
    expect(v.stalePackages).toEqual([]);
    expect(v.staleAdvisories).toEqual([]);
  });
});

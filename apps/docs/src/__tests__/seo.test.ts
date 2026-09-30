import { describe, expect, test } from "bun:test";
import robots from "../../app/robots";

// Build-output checks run through verify:export after a fresh build, never
// conditionally against an absent or stale export during the unit suite.
describe("robots", () => {
  test("allows crawling and advertises the canonical sitemap", () => {
    const r = robots();
    expect(r.rules).toEqual([{ userAgent: "*", allow: "/" }]);
    expect(r.sitemap).toBe("https://docs.subshell.sh/sitemap.xml");
  });
});

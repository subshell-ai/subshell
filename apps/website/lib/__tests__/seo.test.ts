import { describe, expect, test } from "bun:test";
import robots from "../../app/robots";
import sitemap from "../../app/sitemap";

/** The marketing site's discovery layer: one page, found on purpose. */
describe("seo routes", () => {
  test("robots allows all and points at the sitemap", () => {
    const r = robots();
    expect(r.rules).toEqual([{ userAgent: "*", allow: "/" }]);
    expect(r.sitemap).toBe("https://subshell.sh/sitemap.xml");
  });

  test("the sitemap carries exactly the landing page, absolute", () => {
    expect(sitemap()).toEqual([{ url: "https://subshell.sh/" }]);
  });
});

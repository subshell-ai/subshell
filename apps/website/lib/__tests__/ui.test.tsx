import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "../../components/analytics";
import { GitHubIcon } from "../../components/icons";

describe("GitHubIcon", () => {
  test("renders GitHub's Octicons mark at its native size", () => {
    const html = renderToStaticMarkup(<GitHubIcon />);
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain("M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656");
    expect(html).toContain('width="16" height="16"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain("aria-hidden");
  });
});

describe("Analytics", () => {
  test("renders nothing when the id is unset (the default)", () => {
    expect(renderToStaticMarkup(<Analytics id="" />)).toBe("");
    expect(renderToStaticMarkup(<Analytics id={undefined} />)).toBe("");
  });

  test("renders gtag.js with the id when configured", () => {
    const html = renderToStaticMarkup(<Analytics id="G-ABC123" />);
    expect(html).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
    expect(html).toContain('"G-ABC123"');
  });
});

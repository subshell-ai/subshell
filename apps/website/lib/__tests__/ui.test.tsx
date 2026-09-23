import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "../../components/analytics";
import { GitHubIcon } from "../../components/icons";

describe("GitHubIcon", () => {
  test("renders GitHub's classic site mark path at currentColor", () => {
    const html = renderToStaticMarkup(<GitHubIcon />);
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain("M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53");
    expect(html).toContain("aria-hidden");
  });
});

describe("Analytics", () => {
  test("renders nothing when the id is unset — the default", () => {
    expect(renderToStaticMarkup(<Analytics id="" />)).toBe("");
    expect(renderToStaticMarkup(<Analytics id={undefined} />)).toBe("");
  });

  test("renders gtag.js with the id when configured", () => {
    const html = renderToStaticMarkup(<Analytics id="G-ABC123" />);
    expect(html).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
    expect(html).toContain('"G-ABC123"');
  });
});

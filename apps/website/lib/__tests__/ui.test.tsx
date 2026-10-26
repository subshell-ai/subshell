import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "../../components/analytics";

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

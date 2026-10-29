import { describe, expect, it } from "bun:test";
import { previewCompatScript, previewInlineScript } from "../browser-compat.js";

/**
 * The shim is one function's source, serialized into proxied documents and run
 * only inside the sandboxed frame, so it cannot be executed here. These pin the
 * two rules that were each broken once by editing the string: what may be handed
 * to the URL mapper, and which constructor gets the ws: spelling. The behavior
 * itself belongs to the browser check in e2e (capture-preview-demo --security-only).
 */
describe("the injected preview shim", () => {
  const source = previewCompatScript("http://127.0.0.1:3000", "http://plane/pv/abc/");

  it("keeps EventSource on http while WebSocket gets ws", () => {
    expect(source).toContain('["WebSocket", mapSocket]');
    expect(source).toContain('["EventSource", map]');
    // One loop, two mappers: rewriting both would hand EventSource a ws: URL, which
    // its spec rejects and every SSE stream inside a preview would die on.
    expect(source).toContain('const mapSocket = (value) => map(value).replace(/^http/i, "ws");');
    // The rewrite is chosen per constructor, so neither one can drift back onto
    // the other's mapper by accident.
    expect(source).toContain("args[0] = rewrite(String(args[0]));");
  });

  it("returns rel untouched, because it is a token list and not a URL", () => {
    // map() would resolve "noopener" against the document base and write a proxied
    // path into it, silently losing the opener isolation and the preload the app
    // asked for. The rel branch has to return before the mapper is reached.
    const relBranch = source.indexOf('if (name === "rel")');
    const mapper = source.indexOf("const mapped = map(String(value))");
    expect(relBranch).toBeGreaterThan(-1);
    expect(mapper).toBeGreaterThan(relBranch);
    expect(source.slice(relBranch, mapper)).toContain("return String(value)");
    // And the stylesheet test is a token list, so "stylesheet preload" counts.
    expect(source).toContain('.split(/\\s+/).includes("stylesheet")');
    // The twin being scanned for is judged the same way. Comparing the attribute
    // exactly would miss `rel="preload stylesheet"`, leaving the stale stylesheet
    // reused, which is the only thing the revision exists to stop.
    expect(source).toContain('!isStylesheetRel(previous.getAttribute("rel"))');
    // And it is idempotent, because two paths legitimately reach it for one
    // insertion (the rel branch and the observer's append pass). Without the
    // short-circuit each would spend a revision token and start a second fetch
    // of the same stylesheet.
    expect(source).toContain('if (url.searchParams.has("ts")) return mapped;');
  });

  it("wraps inline script in CDATA only for a document parsed as XML", () => {
    const html = previewInlineScript("if (a < b && c) {}", false);
    const xml = previewInlineScript("if (a < b && c) {}", true);
    expect(html).toBe("<script>if (a < b && c) {}</script>");
    expect(xml).toBe("<script>//<![CDATA[\nif (a < b && c) {}\n//]]></script>");
    // A `]]>` in the code (or in an app-controlled chunk base) would otherwise end
    // the section early and break the page.
    expect(previewInlineScript("const x = ']]>';", true)).toContain("]]]]><![CDATA[>");
    // Closing tags cannot appear raw in either form.
    expect(previewInlineScript("</script>", false)).toContain("<\\/script>");
  });

  it("never returns script text whose own tag could close early", () => {
    // previewCompatScript is exported and may be interpolated by a caller that
    // forgets to wrap it, so the guard lives in the producer as well as the
    // wrapper. Escaping twice is inert: a rewritten sequence no longer matches.
    const code = previewCompatScript("http://127.0.0.1:3000", "</script><script>alert(1)</script>");
    expect(code).not.toMatch(/<\/script/i);
    expect(previewInlineScript(code, false)).toMatch(/^<script>.*<\/script>$/s);
  });
});

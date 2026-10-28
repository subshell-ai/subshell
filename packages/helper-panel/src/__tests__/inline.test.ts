import { describe, expect, test } from "bun:test";
import { inlineInto } from "../../inline";

/**
 * The white panel this exists to prevent: a `file://` document has an opaque
 * origin, so vite's `crossorigin` script and stylesheet are refused and the
 * window paints nothing. The build therefore has to leave a document that
 * references no file at all, and these are the ways that can fail.
 */
const VITE_HTML = `<!doctype html>
<html lang="en"><head>
<title>Subshell virtual display helper</title>
<script type="module" crossorigin src="./assets/index-B9KQlPKf.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-DRFjKshr.css">
</head><body><main id="panel"></main></body></html>`;

describe("inlineInto", () => {
  test("carries both the behaviour and the palette inside the document", () => {
    const doc = inlineInto(VITE_HTML, "document.body.dataset.ready = 1;", ":root { --background: oklch(0.2 0 0); }");
    expect(doc).toContain("document.body.dataset.ready");
    expect(doc).toContain("--background");
    expect(doc).not.toContain("./assets/");
    expect(doc).not.toContain("crossorigin");
  });

  test("leaves the markup the page renders into alone", () => {
    const doc = inlineInto(VITE_HTML, "void 0;", "body{}");
    expect(doc).toContain('<main id="panel"></main>');
    expect(doc).toContain("<title>");
  });

  test("escapes closing tags regardless of HTML casing", async () => {
    const doc = inlineInto(VITE_HTML, 'const note = "</ScRiPt><script>unexpected()</script>";', "/* </StYlE> */");
    let scripts = 0;
    await new HTMLRewriter()
      .on("script", {
        element: () => {
          scripts++;
        },
      })
      .transform(new Response(doc))
      .text();
    expect(scripts).toBe(1);
    expect(doc.match(/<\/script\s*>/gi)?.length).toBe(1);
    expect(doc.match(/<\/style\s*>/gi)?.length).toBe(1);
    expect(doc).toContain("<\\/ScRiPt>");
    expect(doc).toContain("<\\/StYlE>");
  });

  test("preserves replacement tokens in script and stylesheet contents", () => {
    const js = `const tokens = ["$&", "$'", "$` + "`" + `", "$$"];`;
    const css = `/* $& $' $` + "`" + ` $$ */`;
    const doc = inlineInto(VITE_HTML, js, css);
    expect(doc).toContain(`<script>${js}</script>`);
    expect(doc).toContain(`<style>${css}</style>`);
  });

  test("refuses a document whose tags it no longer recognizes", () => {
    // The failure this guards is a quiet one: vite changes its output, the
    // plugin matches nothing, and the build still "succeeds" into a blank panel.
    expect(() => inlineInto("<html><body></body></html>", "void 0;", "body{}")).toThrow(
      "no longer carries the script and stylesheet tags",
    );
  });

  test("refuses a bundle that could only run as a module", () => {
    // The fold emits a classic script, so `import.meta` or a top-level export
    // would be a load-time SyntaxError: the same white window by another route.
    expect(() => inlineInto(VITE_HTML, "const u = import.meta.url;", "body{}")).toThrow("classic script");
    expect(() => inlineInto(VITE_HTML, "export const ready = 1;", "body{}")).toThrow("classic script");
  });

  test("refuses a document still fetching anything", () => {
    const withFont = VITE_HTML.replace("</head>", '<link rel="stylesheet" href="./assets/fonts-abc.css"></head>');
    expect(() => inlineInto(withFont, "void 0;", "body{}")).toThrow("still fetches");
  });
});

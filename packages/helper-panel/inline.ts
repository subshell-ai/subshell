import type { Plugin } from "vite";

/**
 * The two tags vite emits for the entry, matched loosely enough to survive a
 * rename of the hashed files but tied to the `./assets/` layout it writes.
 */
const SCRIPT_TAG = /<script\b[^>]*\bsrc="\.\/assets\/[^"]+"[^>]*><\/script>/;
const STYLE_TAG = /<link\b[^>]*\bhref="\.\/assets\/[^"]+\.css"[^>]*>/;

/** Close-tag defense: text that would end the element early is escaped. */
function embed(code: string, closing: string): string {
  return code.split(`</${closing}`).join(`<\\/${closing}`);
}

/**
 * Fold the built stylesheet and script into the document, so the panel is one
 * file that fetches nothing.
 *
 * This is not a size optimization. The helper loads the page with
 * `loadFileURL`, and a `file://` document gets an opaque origin, so vite's
 * `crossorigin` module script and stylesheet are CORS requests from a `null`
 * origin and WebKit refuses both. The result was a white window: the document
 * existed, and neither its type nor its behaviour could arrive. Inlined, the
 * page needs no fetch at all, and the consent surface is one signed file.
 *
 * Throws rather than returning the document untouched: a tag vite stops
 * emitting would otherwise rebuild "successfully" into a blank panel again.
 */
export function inlineInto(html: string, js: string, css: string): string {
  if (!SCRIPT_TAG.test(html) || !STYLE_TAG.test(html)) {
    throw new Error("the panel document no longer carries the script and stylesheet tags this build emits");
  }
  // The fold puts the bundle in a classic script. Module-only syntax there is a
  // SyntaxError at load, which is the same white window by another route, so it
  // is refused here rather than discovered on the Mac.
  if (/\bimport\.meta\b/.test(js) || /^\s*(?:export|import)\s/m.test(js)) {
    throw new Error("the panel bundle uses module-only syntax and cannot be inlined as a classic script");
  }
  const inlined = html
    .replace(SCRIPT_TAG, `<script>${embed(js, "script")}</script>`)
    .replace(STYLE_TAG, `<style>${embed(css, "style")}</style>`);
  // Anything still pointing at ./assets/ escaped the fold, and would be
  // refused by WebKit exactly as the two that this function handles.
  const leftover = /(?:src|href)="\.\/assets\/[^"]+"/.exec(inlined);
  if (leftover !== null) {
    throw new Error(`the panel document still fetches ${leftover[0]}; inlineInto does not handle it`);
  }
  return inlined;
}

/** A vite plugin that leaves `dist/` holding nothing but `index.html`. */
export function panelSingleFile(): Plugin {
  return {
    name: "helper-panel-single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle);
      const script = entries.find((chunk) => chunk.type === "chunk");
      const style = entries.find((chunk) => chunk.type === "asset" && chunk.fileName.endsWith(".css"));
      const document = entries.find((chunk) => chunk.type === "asset" && chunk.fileName.endsWith(".html"));
      if (script?.type !== "chunk" || style?.type !== "asset" || document?.type !== "asset") {
        this.error("the panel build emitted something other than one script, one stylesheet and one document");
      }
      document.source = inlineInto(String(document.source), script.code, String(style.source));
      delete bundle[script.fileName];
      delete bundle[style.fileName];
    },
  };
}

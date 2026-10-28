import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { init, parse } from "es-module-lexer";
import valueParser from "postcss-value-parser";
import { HttpError } from "@/shared/errors.js";
import { previewCompatScript } from "./browser-compat.js";
import { previewSrcset, previewUrl } from "./preview-url.js";

const MAX_TRANSFORM_BYTES = 16 * 1024 * 1024;
// Charge decoded bytes as they arrive, rather than refusing a cold-start burst
// of tiny modules merely because their upstream streams are still open.
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
let bufferedBytes = 0;

/** Quote a JS literal that can also safely appear inside an HTML script. */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
function cssUnescape(value: string): string {
  return value.replace(/\\([\da-f]{1,6}\s?|\r\n|[\s\S])/gi, (_, escaped: string) => {
    if (/^[\da-f]/i.test(escaped)) {
      const point = Number.parseInt(escaped.trim(), 16);
      return point === 0 || point > 0x10ffff ? "\ufffd" : String.fromCodePoint(point);
    }
    return /[\r\n\f]/.test(escaped) ? "" : escaped;
  });
}
export function rewriteCss(source: string, map: (url: string) => string): string {
  const parsed = valueParser(source);
  const rewrite = (node: valueParser.Node) => {
    if (node.type !== "word" && node.type !== "string") return;
    const next = map(cssUnescape(node.value));
    if (next === cssUnescape(node.value)) return;
    Object.assign(node, {
      type: "string",
      quote: '"',
      value: next.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a "),
    });
  };
  parsed.walk((node) => {
    if (node.type === "function" && node.value.toLowerCase() === "url") {
      for (const child of node.nodes) rewrite(child);
      return false;
    }
  });
  for (let i = 0; i < parsed.nodes.length; i++) {
    if (parsed.nodes[i]?.value.toLowerCase() !== "@import") continue;
    let next = i + 1;
    while (parsed.nodes[next]?.type === "space" || parsed.nodes[next]?.type === "comment") next++;
    if (parsed.nodes[next]?.type === "string") rewrite(parsed.nodes[next]);
  }
  return parsed.toString();
}
export async function rewriteModule(source: string, map: (url: string) => string, base?: string): Promise<string> {
  await init;
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(source);
  } catch {
    // The browser owns syntax errors in the app's code; don't turn them into
    // proxy failures, or rewrite only part of an invalid module.
    return source;
  }
  const edits: { start: number; end: number; text: string }[] = [];
  let expansion = 0;
  const add = (start: number, end: number, text: string) => {
    expansion += Math.max(0, text.length - (end - start));
    if (expansion > MAX_TRANSFORM_BYTES)
      throw new HttpError(
        502,
        "This app module expands too much to rewrite. Turn off Rewrite app URLs in Configure preview.",
      );
    edits.push({ start, end, text });
  };
  for (const item of imports) {
    if (!("specifier" in item)) continue;
    if (item.type === "dynamic" && (!item.specifier || item.glob)) {
      if (base) {
        // Wrap only the argument, keeping options and nested imports intact.
        // Worker realms without the document shim retain their own behavior.
        add(
          item.start,
          item.start,
          `((v)=>globalThis.__subshellPreviewMap?globalThis.__subshellPreviewMap(v,${scriptString(base)}):v)(`,
        );
        add(item.end, item.end, ")");
      }
      continue;
    }
    if (!item.specifier || !/^(?:\.{0,2}\/|https?:\/\/)/.test(item.specifier)) continue;
    const mapped = map(item.specifier);
    if (mapped === item.specifier) continue;
    add(
      item.type === "dynamic" ? item.start : item.start - 1,
      item.type === "dynamic" ? item.end : item.end + 1,
      scriptString(mapped),
    );
  }
  // A single assembly keeps attacker-controlled import counts from making
  // response rewriting quadratic in the length of the module.
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    parts.push(source.slice(offset, edit.start), edit.text);
    offset = edit.end;
  }
  parts.push(source.slice(offset));
  return parts.join("");
}
async function boundedText(body: ReadableStream<Uint8Array>, charge: (bytes: number) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      charge(value.length);
      bytes += value.length;
      if (bytes > MAX_TRANSFORM_BYTES)
        throw new HttpError(
          502,
          "This app response is too large to rewrite. Turn off Rewrite app URLs in Configure preview.",
        );
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** Only text resources are buffered. Fetch/SSE/binary bodies retain their stream. */
export async function transformPreviewResponse(
  response: Response,
  target: string,
  proxy: string,
  path: string,
): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  const html = /^text\/html\b/i.test(type);
  const css = /^text\/css\b/i.test(type);
  const js = /^(?:text|application)\/(?:javascript|ecmascript)\b/i.test(type);
  if (!response.body || (!html && !css && !js)) return response;
  if (response.status === 206) {
    await response.body.cancel();
    throw new HttpError(
      502,
      "This app returned a partial resource that cannot be rewritten. Turn off Rewrite app URLs in Configure preview.",
    );
  }
  let retainedBytes = 0;
  const charge = (bytes: number) => {
    if (bufferedBytes + bytes > MAX_BUFFERED_BYTES)
      throw new HttpError(503, "Too much app content is being rewritten. Refresh the preview shortly.");
    bufferedBytes += bytes;
    retainedBytes += bytes;
  };
  try {
    const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(type)?.[1]?.toLowerCase();
    if (charset && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") {
      await response.body.cancel();
      throw new HttpError(
        502,
        "This app uses an unsupported text encoding. Turn off Rewrite app URLs in Configure preview.",
      );
    }
    let body = response.body;
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      const decoder =
        encoding === "gzip"
          ? createGunzip()
          : encoding === "deflate"
            ? createInflate()
            : encoding === "br"
              ? createBrotliDecompress()
              : null;
      if (!decoder) {
        await body.cancel();
        throw new HttpError(
          502,
          "This app uses unsupported compression. Turn off Rewrite app URLs in Configure preview.",
        );
      }
      const input = Readable.fromWeb(body as never);
      pipeline(input, decoder, () => {
        /* The web reader observes errors; pipeline tears down both ends. */
      });
      body = Readable.toWeb(decoder) as ReadableStream<Uint8Array>;
    }
    const source = await boundedText(body, charge);
    const base = new URL(path, target).href;
    let effectiveBase = base;
    let expansion = 0;
    const map = (value: string) => {
      const mapped = previewUrl(value, effectiveBase, target, proxy);
      expansion += Math.max(0, mapped.length - value.length);
      if (expansion > MAX_TRANSFORM_BYTES)
        throw new HttpError(
          502,
          "This app response expands too much to rewrite. Turn off Rewrite app URLs in Configure preview.",
        );
      return mapped;
    };
    let output: string;
    if (css) output = rewriteCss(source, map);
    else if (js) output = await rewriteModule(source, map, base);
    else {
      const script = `<script>${previewCompatScript(target, proxy)}</script>`;
      let injected = false;
      let baseSeen = false;
      await new HTMLRewriter()
        .on("base[href]", {
          element(el) {
            if (!baseSeen) {
              try {
                effectiveBase = new URL(el.getAttribute("href") ?? "", base).href;
              } catch {}
              baseSeen = true;
            }
          },
        })
        .transform(new Response(source))
        .text();
      const rewriter = new HTMLRewriter()
        .on("head", {
          element(el) {
            el.prepend(script, { html: true });
            injected = true;
          },
        })
        .on("*", {
          element(el) {
            if (!injected && el.tagName === "script") {
              el.before(script, { html: true });
              injected = true;
            }
            for (const name of ["src", "href", "action", "formaction", "poster", "data"]) {
              const value = el.getAttribute(name);
              if (value === null) continue;
              const mapped =
                el.tagName === "base" && name === "href" ? previewUrl(value, base, target, proxy) : map(value);
              el.setAttribute(name, mapped);
              if (mapped !== value && (el.tagName === "script" || el.tagName === "link"))
                el.removeAttribute("integrity");
            }
            const srcset = el.getAttribute("srcset");
            if (srcset !== null) el.setAttribute("srcset", previewSrcset(srcset, map));
            const style = el.getAttribute("style");
            if (style !== null) el.setAttribute("style", rewriteCss(style, map));
          },
        });
      for (const selector of ["style", 'script[type="module"]', 'script[type="importmap"]']) {
        let text = "";
        rewriter.on(selector, {
          text(chunk) {
            text += chunk.text;
            chunk.remove();
          },
          element(el) {
            text = "";
            el.onEndTag(async (end) => {
              let changed: string;
              if (selector === 'script[type="importmap"]') {
                try {
                  const importMap = JSON.parse(text);
                  const mapEntries = (entries: Record<string, string | null>) =>
                    Object.fromEntries(
                      Object.entries(entries).map(([key, value]) => [
                        /^(?:\.{0,2}\/|https?:\/\/)/.test(key) ? map(key) : key,
                        typeof value === "string" ? map(value) : value,
                      ]),
                    );
                  if (importMap.imports) importMap.imports = mapEntries(importMap.imports);
                  if (importMap.scopes)
                    importMap.scopes = Object.fromEntries(
                      Object.entries(importMap.scopes).map(([key, value]) => [
                        map(key),
                        mapEntries(value as Record<string, string | null>),
                      ]),
                    );
                  changed = JSON.stringify(importMap).replace(/</g, "\\u003c");
                } catch (error) {
                  if (error instanceof HttpError) throw error;
                  // Browsers ignore malformed import maps. Preserve that behavior
                  // without turning otherwise usable HTML into a proxy error.
                  changed = text;
                }
              } else
                changed = selector === "style" ? rewriteCss(text, map) : await rewriteModule(text, map, effectiveBase);
              end.before(changed, { html: true });
            });
          },
        });
      }
      output = await rewriter.transform(new Response(source)).text();
      if (!injected) output = script + output;
    }
    const headers = new Headers(response.headers);
    for (const name of [
      "content-length",
      "content-encoding",
      "etag",
      "content-md5",
      "digest",
      "content-digest",
      "repr-digest",
      "accept-ranges",
    ])
      headers.delete(name);
    headers.set("content-type", `${html ? "text/html" : css ? "text/css" : "text/javascript"}; charset=utf-8`);
    return new Response(output, { status: response.status, statusText: response.statusText, headers });
  } finally {
    bufferedBytes -= retainedBytes;
  }
}

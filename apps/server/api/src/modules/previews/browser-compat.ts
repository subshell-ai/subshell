import { previewSrcset, previewUrl } from "./preview-url.js";

// Executed only inside the sandbox; kept as source to avoid importing browser globals into server types.
const browserCompatSource = `function installPreviewCompat(target, proxy, mapUrl, mapSrcset) {
  const map = (value) => mapUrl(value, document.baseURI, target, proxy);
  Object.defineProperty(globalThis, "__subshellPreviewMap", { value: (value, base) => {
    const text = "" + value;
    return text.startsWith("/") || text.startsWith("./") || text.startsWith("../") || text.startsWith("http://") || text.startsWith("https://")
      ? mapUrl(text, base, target, proxy) : text;
  } });
  let stylesheetRevision = 0;
  // Chromium can reuse an active stylesheet inside the opaque-origin frame, even
  // with no-store. Turbopack already uses ts for this on Safari/Firefox, so the
  // revision only applies to its own chunks: the base is a page-owned global, an
  // app that blanks it would make the prefix test pass for anything, and a URL
  // that will not parse is left exactly as the app asked for it.
  const stylesheetBump = (element, mapped) => {
    if (typeof globalThis.TURBOPACK_CHUNK_BASE_PATH !== "string"
      || !mapped.startsWith(globalThis.TURBOPACK_CHUNK_BASE_PATH)) return mapped;
    let url;
    try {
      url = new URL(mapped);
    } catch {
      return mapped;
    }
    if (!url.pathname.endsWith(".css")) return mapped;
    url.searchParams.delete("ts");
    for (const previous of document.querySelectorAll("link[rel][href]")) {
      // The attribute selector is case-sensitive and rel is whatever the app
      // wrote, so compare the value rather than trusting the selector, and read
      // it as the token list it is: a twin declared "preload stylesheet" is
      // still the active stylesheet this new link would otherwise reuse.
      if (previous === element || !isStylesheetRel(previous.getAttribute("rel"))) continue;
      if (!previous.href.startsWith(globalThis.TURBOPACK_CHUNK_BASE_PATH)) continue;
      const existing = new URL(previous.href);
      existing.searchParams.delete("ts");
      if (existing.href !== url.href) continue;
      url.searchParams.set("ts", Date.now() + "." + ++stylesheetRevision);
      return url.href;
    }
    return mapped;
  };
  // rel is a space-separated token list, so "Stylesheet", "stylesheet preload"
  // and "preload stylesheet" all mean a stylesheet is involved.
  const isStylesheetRel = (rel) => String(rel).toLowerCase().split(/\\s+/).includes("stylesheet");
  const mapAttribute = (element, name, value) => {
    // rel is not a URL and never reaches the mapper: an app writing
    // rel="noopener" or rel="modulepreload" must get exactly that back, or the
    // token turns into a proxied path and the link silently stops working.
    if (name === "rel") {
      // A link built as createElement, then href, then rel is the ordinary order,
      // and the reuse problem is keyed on that pair: an href set while rel was
      // still empty got no revision, so the rel that arrives later re-runs the
      // bump for the href the element already holds. Only once it is in the
      // document, though: an unconnected link fetches nothing, and bumping it here
      // as well would have the observer below bump the same element again when it
      // is appended, spending a second revision token on one stylesheet.
      if (element instanceof HTMLLinkElement && isStylesheetRel(value) && element.isConnected) {
        const held = element.getAttribute("href");
        if (held !== null) {
          const bumped = stylesheetBump(element, map(held));
          if (bumped !== held) attribute.call(element, "href", bumped);
        }
      }
      return String(value);
    }
    const mapped = map(String(value));
    if (name !== "href" || !(element instanceof HTMLLinkElement) || !isStylesheetRel(element.rel)) return mapped;
    return stylesheetBump(element, mapped);
  };
  const attributes = new Set(["src", "href", "rel", "action", "formaction", "poster", "data"]);
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = name.toLowerCase();
    return attribute.call(this, name, key === "srcset" ? mapSrcset(String(value), map) : attributes.has(key) ? mapAttribute(this, key, value) : value);
  };
  for (const [constructor, properties] of [
    [HTMLScriptElement, ["src"]],
    [HTMLImageElement, ["src", "srcset"]],
    [HTMLLinkElement, ["href", "rel"]],
    [HTMLAnchorElement, ["href"]],
    [HTMLFormElement, ["action"]],
    [HTMLInputElement, ["src", "formAction"]],
    [HTMLButtonElement, ["formAction"]],
    [HTMLSourceElement, ["src", "srcset"]],
    [HTMLMediaElement, ["src"]],
    [HTMLVideoElement, ["poster"]],
    [HTMLIFrameElement, ["src"]]
  ]) {
    for (const property of properties) {
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, property);
      if (!descriptor?.set)
        continue;
      Object.defineProperty(constructor.prototype, property, { ...descriptor, set(value) {
        descriptor.set.call(this, property === "srcset" ? mapSrcset(String(value), map) : mapAttribute(this, property, value));
      } });
    }
  }
  const nativeFetch = window.fetch;
  window.fetch = function(input, init) {
    if (input instanceof Request) {
      const url = map(input.url);
      if (url !== input.url)
        input = new Request(url, input);
    } else
      input = map(String(input));
    return nativeFetch.call(this, input, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    args[1] = map(String(args[1]));
    return Reflect.apply(open, this, args);
  };
  // A socket URL always wants the ws spelling of the proxy path. map() answers
  // with http(s), and a runtime that reduced its own HMR URL to a pathname
  // carries no scheme for us to read, so the conversion happens here, where the
  // call itself says what it is. Handing new WebSocket an http: URL throws.
  const mapSocket = (value) => map(value).replace(/^http/i, "ws");
  for (const [name, rewrite] of [["WebSocket", mapSocket], ["EventSource", map]]) {
    const Original = window[name];
    if (!Original)
      continue;
    // EventSource takes an http(s) URL by spec, so it gets the plain mapper:
    // converting it the way sockets are would throw on every SSE stream.
    Object.defineProperty(window, name, { configurable: true, writable: true, value: new Proxy(Original, {
      construct(ctor, args, newTarget) {
        args[0] = rewrite(String(args[0]));
        return Reflect.construct(ctor, args, newTarget);
      }
    }) });
  }
  new MutationObserver((changes) => {
    const fix = (element) => {
      for (const name of [...attributes, "srcset"]) {
        const old = element.getAttribute(name);
        if (old === null)
          continue;
        // href and rel go through mapAttribute, not just map: a link built as
        // createElement + href + rel and appended afterwards (the order most code
        // writes it in) still needs its cache-busting revision, and rel is a value,
        // not a URL, so it must never reach the plain mapper.
        const next =
          name === "srcset" ? mapSrcset(old, map) : name === "href" || name === "rel" ? mapAttribute(element, name, old) : map(old);
        if (old !== next)
          attribute.call(element, name, next);
      }
    };
    for (const change of changes)
      for (const node of change.addedNodes) {
        if (!(node instanceof Element))
          continue;
        fix(node);
        for (const child of node.querySelectorAll("[src],[href],[action],[formaction],[poster],[srcset]"))
          fix(child);
      }
  }).observe(document, { childList: true, subtree: true });
}`;

/**
 * The shim's JavaScript, ready to be run.
 *
 * The `</script` guard is applied here as well as in {@link previewInlineScript},
 * so a caller that interpolates this into markup by hand cannot produce a page
 * whose script ends early. Escaping twice is inert: once rewritten the sequence no
 * longer matches the pattern.
 */
export function previewCompatScript(target: string, proxy: string): string {
  return `(${browserCompatSource})(${JSON.stringify(target)},${JSON.stringify(proxy)},${previewUrl.toString()},${previewSrcset.toString()});`.replace(
    /<\/script/gi,
    "<\\/script",
  );
}

/**
 * One inline script, as markup the document's own parser will accept.
 *
 * A page served as `application/xhtml+xml` is parsed as strict XML, where inline
 * script content is markup rather than text: the raw `<` and `&&` every runtime
 * emits there are a fatal error, not JavaScript. CDATA is what XHTML authors use
 * for exactly this reason, and the `//` on each marker keeps it an ordinary
 * comment for the HTML parsers that never see the wrapper. `]]>` would close the
 * section early, so the sequence is split the way CDATA prescribes; the app-
 * controlled chunk base can carry it, and an ampersand is inert inside.
 */
export function previewInlineScript(code: string, xml: boolean): string {
  const safe = code.replace(/<\/script/gi, "<\\/script");
  if (!xml) return `<script>${safe}</script>`;
  const body = safe.includes("]]>") ? safe.replace(/\]\]>/g, "]]]]><![CDATA[>") : safe;
  return `<script>//<![CDATA[\n${body}\n//]]></script>`;
}

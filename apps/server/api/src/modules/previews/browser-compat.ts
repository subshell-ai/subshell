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
  const mapAttribute = (element, name, value) => {
    const mapped = map(String(value));
    // Chromium can reuse an active stylesheet inside the opaque-origin frame,
    // even with no-store. Turbopack already uses ts for this on Safari/Firefox.
    // rel is compared as the app wrote it, so a stylesheet declared "Stylesheet"
    // gets the same treatment; and when an app sets href before rel, the observer
    // below re-runs this for the finished element.
    if (name !== "href" || !(element instanceof HTMLLinkElement) || String(element.rel).toLowerCase() !== "stylesheet"
      || typeof globalThis.TURBOPACK_CHUNK_BASE_PATH !== "string"
      || !mapped.startsWith(globalThis.TURBOPACK_CHUNK_BASE_PATH)) return mapped;
    // The base is a page-owned global, so an app that blanks it makes the
    // prefix test above pass for anything. A URL that will not parse is not
    // our business: leave the href exactly as the app asked for it.
    let url;
    try {
      url = new URL(mapped);
    } catch {
      return mapped;
    }
    if (!url.pathname.endsWith(".css")) return mapped;
    url.searchParams.delete("ts");
    for (const previous of document.querySelectorAll('link[rel="stylesheet"][href]')) {
      if (previous === element || !previous.href.startsWith(globalThis.TURBOPACK_CHUNK_BASE_PATH)) continue;
      const existing = new URL(previous.href);
      existing.searchParams.delete("ts");
      if (existing.href !== url.href) continue;
      url.searchParams.set("ts", Date.now() + "." + ++stylesheetRevision);
      return url.href;
    }
    return mapped;
  };
  const attributes = new Set(["src", "href", "action", "formaction", "poster", "data"]);
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = name.toLowerCase();
    return attribute.call(this, name, key === "srcset" ? mapSrcset(String(value), map) : attributes.has(key) ? mapAttribute(this, key, value) : value);
  };
  for (const [constructor, properties] of [
    [HTMLScriptElement, ["src"]],
    [HTMLImageElement, ["src", "srcset"]],
    [HTMLLinkElement, ["href"]],
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
  for (const name of ["WebSocket", "EventSource"]) {
    const Original = window[name];
    if (!Original)
      continue;
    Object.defineProperty(window, name, { configurable: true, writable: true, value: new Proxy(Original, {
      construct(ctor, args, newTarget) {
        args[0] = map(String(args[0]));
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
        // href goes through mapAttribute, not just map, so a link built as
        // createElement + href + rel (the order most code writes it in) still gets
        // the cache-busting revision: by the time it is in the document, rel is set.
        const next = name === "srcset" ? mapSrcset(old, map) : name === "href" ? mapAttribute(element, name, old) : map(old);
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

export function previewCompatScript(target: string, proxy: string, xml = false): string {
  const code =
    `(${browserCompatSource})(${JSON.stringify(target)},${JSON.stringify(proxy)},${previewUrl.toString()},${previewSrcset.toString()});`.replace(
      /<\/script/gi,
      "<\\/script",
    );
  // A document the browser parses as strict XML reads inline script as markup,
  // so the raw `<` and `&&` the shim contains are a fatal error there rather
  // than JavaScript. Wrapping in CDATA is what XHTML authors do for exactly this
  // reason, and the `//` on each marker keeps it an ordinary comment for the HTML
  // parsers that never see the wrapper.
  if (!xml) return code;
  // The one sequence that would end the section early, split the way CDATA
  // prescribes. Nothing in the shim contains it today; this keeps a future edit
  // from quietly producing a page the browser refuses to parse.
  const body = code.includes("]]>") ? code.replace(/\]\]>/g, "]]]]><![CDATA[>") : code;
  return `//<![CDATA[\n${body}\n//]]>`;
}

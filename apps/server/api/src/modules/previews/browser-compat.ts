import { previewSrcset, previewUrl } from "./preview-url.js";

// Executed only inside the sandbox; kept as source to avoid importing browser globals into server types.
const browserCompatSource = `function installPreviewCompat(target, proxy, mapUrl, mapSrcset) {
  const map = (value) => mapUrl(value, document.baseURI, target, proxy);
  Object.defineProperty(globalThis, "__subshellPreviewMap", { value: (value, base) => {
    const text = "" + value;
    return text.startsWith("/") || text.startsWith("./") || text.startsWith("../") || text.startsWith("http://") || text.startsWith("https://")
      ? mapUrl(text, base, target, proxy) : text;
  } });
  const attributes = new Set(["src", "href", "action", "formaction", "poster", "data"]);
  const attribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = name.toLowerCase();
    return attribute.call(this, name, key === "srcset" ? mapSrcset(String(value), map) : attributes.has(key) ? map(String(value)) : value);
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
        descriptor.set.call(this, property === "srcset" ? mapSrcset(String(value), map) : map(String(value)));
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
        const next = name === "srcset" ? mapSrcset(old, map) : map(old);
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

export function previewCompatScript(target: string, proxy: string): string {
  return `(${browserCompatSource})(${JSON.stringify(target)},${JSON.stringify(proxy)},${previewUrl.toString()},${previewSrcset.toString()});`.replace(
    /<\/script/gi,
    "<\\/script",
  );
}

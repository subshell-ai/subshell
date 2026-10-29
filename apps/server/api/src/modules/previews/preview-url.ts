/** Also serialized into the preview shim: keep this function closure-free. */
export function previewUrl(value: string, base: string, target: string, proxy: string): string {
  if (!value || value.startsWith("#")) return value;
  try {
    // Server rewrites omit the scheme so TLS termination cannot downgrade assets.
    // The browser shim resolves this base before using the mapper at runtime.
    const inheritProtocol = proxy.startsWith("//");
    const proxyUrl = new URL(proxy, "http://preview.invalid");
    const browserUrl = (url: URL) => (inheritProtocol ? url.href.slice(url.protocol.length) : url.href);
    // App runtimes sometimes reduce an already-mapped URL to its pathname.
    // Recognize this before resolving against the upstream document base.
    if (value.startsWith(proxyUrl.pathname)) {
      const mapped = new URL(value, proxyUrl.origin);
      if (mapped.pathname.startsWith(proxyUrl.pathname)) return browserUrl(mapped);
    }
    const logicalBase = new URL(base);
    if (logicalBase.origin === proxyUrl.origin && logicalBase.pathname.startsWith(proxyUrl.pathname)) {
      base = target + logicalBase.pathname.slice(proxyUrl.pathname.length - 1) + logicalBase.search;
    }
    const resolved = new URL(value, base);
    if (!["http:", "https:", "ws:", "wss:"].includes(resolved.protocol) || resolved.username || resolved.password)
      return value;
    const websocket = resolved.protocol === "ws:" || resolved.protocol === "wss:";
    const origin = resolved.origin.replace(/^ws/, "http");
    if (origin === proxyUrl.origin && resolved.pathname.startsWith(proxyUrl.pathname)) return browserUrl(resolved);
    if (origin !== new URL(target).origin && origin !== proxyUrl.origin) return value;
    const output = new URL(proxyUrl);
    if (websocket) output.protocol = output.protocol === "https:" ? "wss:" : "ws:";
    return browserUrl(output) + resolved.pathname.slice(1) + resolved.search + resolved.hash;
  } catch {
    return value;
  }
}

/** The URL token ends at whitespace, not at a data URL's embedded commas. */
export function previewSrcset(value: string, map: (url: string) => string): string {
  let index = 0;
  const candidates: string[] = [];
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    const url = value.slice(start, index);
    if (!url) break;
    if (url.endsWith(",")) {
      candidates.push(map(url.replace(/,+$/, "")));
      continue;
    }
    const descriptorStart = index;
    let depth = 0;
    while (index < value.length) {
      const char = value[index];
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) break;
      index++;
    }
    candidates.push(map(url) + value.slice(descriptorStart, index));
    index++;
  }
  return candidates.join(", ");
}

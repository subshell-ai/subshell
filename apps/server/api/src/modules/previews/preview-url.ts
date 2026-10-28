/** Also serialized into the preview shim: keep this function closure-free. */
export function previewUrl(value: string, base: string, target: string, proxy: string): string {
  if (!value || value.startsWith("#")) return value;
  try {
    const proxyUrl = new URL(proxy);
    const logicalBase = new URL(base);
    if (logicalBase.origin === proxyUrl.origin && logicalBase.pathname.startsWith(proxyUrl.pathname)) {
      base = target + logicalBase.pathname.slice(proxyUrl.pathname.length - 1) + logicalBase.search;
    }
    const resolved = new URL(value, base);
    if (!["http:", "https:", "ws:", "wss:"].includes(resolved.protocol) || resolved.username || resolved.password)
      return value;
    const websocket = resolved.protocol === "ws:" || resolved.protocol === "wss:";
    const origin = resolved.origin.replace(/^ws/, "http");
    if (origin === proxyUrl.origin && resolved.pathname.startsWith(proxyUrl.pathname)) return resolved.href;
    if (origin !== new URL(target).origin && origin !== proxyUrl.origin) return value;
    const output = new URL(proxy);
    if (websocket) output.protocol = output.protocol === "https:" ? "wss:" : "ws:";
    return output.href + resolved.pathname.slice(1) + resolved.search + resolved.hash;
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

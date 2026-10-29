/** A browser service is dialled by the node, never by the control plane. */
export interface ServiceTarget {
  host: string;
  protocol: "http" | "https";
  /** Explicit per-service opt-out; omission keeps certificate validation enabled. */
  ignoreCertificateErrors?: boolean;
}

/** Accept a hostname or IP, never a URL, credentials, path, or header text. */
export function normalizeServiceHost(value: string): string | null {
  if (!value || value.length > 253 || /[\s/\\@?#%]/.test(value)) return null;
  if (value.startsWith("[") && !value.endsWith("]")) return null;
  try {
    const bracketed = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
    const url = new URL(`http://${bracketed}`);
    if (url.port || url.username || url.password || url.pathname !== "/") return null;
    const host = url.hostname.toLowerCase();
    if (!host.startsWith("[") && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
    return host.startsWith("[") ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

export function serviceAuthority(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

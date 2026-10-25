/** Bundled display choices. Add implementations to pane-runtime's registry too. */
export const VIRTUAL_DISPLAY_PROVIDERS = [
  { id: "xvfb-x11vnc", name: "Xvfb + VNC", description: "Private Linux displays using Xvfb and x11vnc." },
] as const;
export const DEFAULT_VIRTUAL_DISPLAY_PROVIDER = "xvfb-x11vnc";

/** Identifiers are bounded on the wire so older nodes can refuse unknown providers. */
export function isDisplayProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

/** A launch request may use the node default; persisted subshells pin provider. */
export type VirtualDisplayRequest = { width: number; height: number; provider?: string };
export function parseVirtualDisplayRequest(value: unknown): VirtualDisplayRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (![v.width, v.height].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 320 && n <= 4096))
    return null;
  if (v.provider !== undefined && !isDisplayProviderId(v.provider)) return null;
  return {
    width: v.width as number,
    height: v.height as number,
    ...(v.provider === undefined ? {} : { provider: v.provider as string }),
  };
}
export function parseDisplayProviderIds(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= 32 &&
    value.every(isDisplayProviderId) &&
    new Set(value).size === value.length
    ? [...value]
    : null;
}
/** Stored policy is fail-closed; absent fields use the initial bundled provider. */
export function storedDisplayProviderIds(value: string | null | undefined): string[] {
  if (value === undefined || value === null) return [DEFAULT_VIRTUAL_DISPLAY_PROVIDER];
  try {
    return parseDisplayProviderIds(JSON.parse(value)) ?? [];
  } catch {
    return [];
  }
}

export function parseStoredVirtualDisplayRequest(value: string | null | undefined): VirtualDisplayRequest | null {
  if (!value) return null;
  try {
    return parseVirtualDisplayRequest(JSON.parse(value));
  } catch {
    return null;
  }
}

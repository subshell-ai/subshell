/**
 * The operating system one bundled provider can drive. It sits in the catalog
 * rather than in each surface that asks, because the answer is a fact about the
 * provider: Xvfb is Linux's display server and BetterDisplay is macOS's, and a
 * picker that offers the other one is offering a choice the machine refuses. The
 * catalog `satisfies` it, so a provider added without a platform is a compile
 * error rather than an entry that silently matches no OS.
 */
export type DisplayProviderPlatform = "linux" | "darwin";

/** One row of the catalog. `platform` is the type's whole point: see above. */
export interface DisplayProviderCatalogEntry {
  id: string;
  name: string;
  description: string;
  platform: DisplayProviderPlatform;
}

/** Bundled display choices. Add implementations to pane-runtime's registry too. */
export const VIRTUAL_DISPLAY_PROVIDERS = [
  {
    id: "xvfb-x11vnc",
    name: "Xvfb + VNC",
    description: "Private Linux displays using Xvfb and x11vnc.",
    platform: "linux",
  },
  {
    id: "betterdisplay",
    name: "BetterDisplay",
    description: "macOS virtual screens using BetterDisplay and the opt-in Subshell Display Helper.",
    platform: "darwin",
  },
] as const satisfies readonly DisplayProviderCatalogEntry[];
export const DEFAULT_VIRTUAL_DISPLAY_PROVIDER = "xvfb-x11vnc";

/**
 * What a node's `os` field carries when nothing has classified the machine: an
 * agent on a platform outside `linux|darwin` says this (`mapOs` in
 * `apps/node/agent/src/enroll.ts`), and so does a row that enrolled before the
 * field was reported. It is not a platform, and reading it as one would have the
 * plane guess at a machine it holds no fact about. Every reader here treats it as
 * the absence of an answer, which is also what a null means. The node is the
 * authority on what runs there: it looks for the programs, and it refuses a
 * provider it cannot drive, by name (`preview-display-unsupported`, from
 * `xvfbDisplayReadiness` and the provider's own platform check, which is stricter
 * than anything the catalog could say from an unclassified `os`). What
 * no-verdict preserves is the owner's path on a node that enrolled and never came
 * ready: the provider rows stay visible so they can be enabled at all.
 */
export const NODE_OS_UNKNOWN = "unknown";

/**
 * Whether an `os` value says anything about what can run on this machine.
 * See {@link NODE_OS_UNKNOWN} for why the protocol's own `unknown` is not an answer.
 */
export function displayOsAnswered(os: string | null | undefined): boolean {
  return os !== null && os !== undefined && os !== NODE_OS_UNKNOWN;
}

/**
 * The bundled providers a machine may be offered.
 *
 * A named platform that no provider supports matches NOTHING: the honest answer
 * there is no choice rather than the Linux default handed to a Mac. A machine
 * that has not named its platform gets the whole catalog, because nothing has
 * ruled any of it out, and an owner must still be able to pre-enable a provider
 * on a node that enrolled and never came ready.
 */
export function displayProvidersForOs(
  os: string | null | undefined,
): readonly (typeof VIRTUAL_DISPLAY_PROVIDERS)[number][] {
  if (!displayOsAnswered(os)) return VIRTUAL_DISPLAY_PROVIDERS;
  return VIRTUAL_DISPLAY_PROVIDERS.filter((provider) => provider.platform === os);
}

/**
 * Whether one id from a node's stored provider list may be offered for that OS.
 * A bundled provider answers from the catalog. An id this package does not ship
 * belongs to the node itself, and no surface here has a fact about its platform,
 * so it stays on the list and the node's own readiness answer rules it in or
 * out: refusing what we cannot place would hide a provider the machine has.
 */
export function displayProviderRunsOnOs(id: string, os: string | null | undefined): boolean {
  const bundled = VIRTUAL_DISPLAY_PROVIDERS.find((provider) => provider.id === id);
  if (!bundled) return true;
  return displayOsAnswered(os) ? bundled.platform === os : true;
}

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

import { isLoopbackUrl } from "@/lib/loopback";
import { isAndroid, isIOS } from "@/lib/platform";

/**
 * Which set of install steps the dialog shows. Three because they are three
 * different gestures, not three brandings: a desktop browser installs from its
 * address bar, iOS from the share sheet, Android from the overflow menu.
 */
export type InstallPlatform = "browser" | "apple" | "android";

/** One address a phone could be pointed at. */
export interface InstallAddress {
  /** The canonical origin (scheme + host + port), which is what a QR encodes */
  url: string;
  /** False for loopback: the far end would dial itself, so it cannot be used */
  reachable: boolean;
  /** This browser is on it right now — proof it works from somewhere */
  here: boolean;
  /** The server's own APP_BASE_URL, which is what passkeys bind to */
  baseUrl: boolean;
}

/** Where the candidate addresses come from — three sources that mostly overlap. */
export interface InstallAddressSources {
  /** `window.location.origin`: where this browser demonstrably reached the plane */
  here: string;
  /** `appBaseUrl` from public settings; absent on a server that predates it */
  baseUrl: string | undefined;
  /** `trustedOrigins` from public settings; absent on a server that predates it */
  trustedOrigins: string[] | undefined;
}

/**
 * The addresses to offer, best first.
 *
 * `appBaseUrl` alone is ONE spelling and usually the wrong one to hand a
 * phone: a laptop browsing `http://localhost:3080` and a phone on the tailnet
 * need different answers, and only the allowlist knows both. So all three
 * sources are merged, normalized to origins (two spellings of one address are
 * one row) and ordered:
 *
 * 1. **Reachable before loopback.** Loopback is kept and marked rather than
 *    dropped — the address a person is looking at vanishing from the list is
 *    its own confusion — but it can never be the default.
 * 2. **Within each group, insertion order**: this browser's address, then the
 *    base URL, then the rest of the allowlist. An address this browser is
 *    already talking to is the one address proven to work from a device on
 *    this network, which is the best available guess for the phone beside it.
 *
 * An entry that is not a parseable URL is dropped rather than rendered. The
 * server canonicalizes the list, but a cached PWA can be talking to an older
 * one and a hand-edited config.env never passes the validator at all.
 */
export function installAddresses({ here, baseUrl, trustedOrigins }: InstallAddressSources): InstallAddress[] {
  const byUrl = new Map<string, InstallAddress>();
  const add = (raw: string | undefined, mark: Partial<InstallAddress>): void => {
    if (!raw) return;
    let url: string;
    try {
      url = new URL(raw).origin;
    } catch {
      return;
    }
    // "null" is what URL.origin serializes an opaque origin to (a `file:` or
    // `data:` URL parses happily and lands here); it is not an address.
    if (url === "null") return;
    const existing = byUrl.get(url);
    if (existing) {
      // The MARKS accumulate, not the rows: one address that happens to be all
      // three facts is still one address.
      Object.assign(existing, mark);
      return;
    }
    byUrl.set(url, { url, reachable: !isLoopbackUrl(url), here: false, baseUrl: false, ...mark });
  };

  add(here, { here: true });
  add(baseUrl, { baseUrl: true });
  for (const origin of trustedOrigins ?? []) add(origin, {});

  const list = [...byUrl.values()];
  // Stable partition rather than a comparator: insertion order IS rule 2, and
  // a sort that merely returns 0 for ties is not promised to preserve it in
  // every engine.
  return [...list.filter((a) => a.reachable), ...list.filter((a) => !a.reachable)];
}

/**
 * The tab to open on — the steps for the device actually reading the dialog.
 *
 * A guess, and always overridable: someone at a desktop looking up what their
 * phone should do is a normal reason to be here, which is why every tab stays
 * one click away rather than the other two being hidden.
 */
export function installPlatformFor(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  // `?? 0` is not belt and braces: a default parameter applies only to a
  // MISSING argument, and this expression can itself evaluate to undefined
  // (an old WebView, a test DOM) while its type says `number` — so the
  // coalesce is what makes the annotation true.
  touchPoints: number = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0),
): InstallPlatform {
  if (isIOS(ua, touchPoints)) return "apple";
  if (isAndroid(ua)) return "android";
  return "browser";
}

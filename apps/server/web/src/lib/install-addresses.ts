import { isLoopbackUrl } from "@/lib/loopback";

/** One address another device can be pointed at. */
export interface InstallAddress {
  /** The canonical origin (scheme + host + port), which is what a QR encodes and what install.sh bakes */
  url: string;
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
 * The addresses to offer a device that is NOT this browser — the phone in
 * the mobile dialog, the new machine in the Add-node dialog — best first.
 *
 * `appBaseUrl` alone is ONE spelling and usually the wrong one to hand out:
 * a laptop browsing `http://localhost:3080` and a phone on the LAN need
 * different answers, and only the allowlist knows both. So all three sources
 * are merged, normalized to origins (two spellings of one address are one
 * row) and ordered:
 *
 * 1. **Loopback is dropped.** It used to be kept and labelled "this device
 *    only", because on a stock instance every address looked loopback and a
 *    vanishing address is its own confusion. The server now derives its own
 *    LAN interfaces into the allowlist, so that case reads real rows instead;
 *    what survives to be labelled was only ever a row the OTHER machine
 *    cannot dial — and these pickers are FOR the other machine. What an
 *    EMPTY list means is the caller's: the Add-node dialog falls back to
 *    naming `appBaseUrl` alone (a loopback bind on a server older than the
 *    LAN derivation still has to render a command, and that command is what
 *    it always was), while the mobile dialog renders its refusal state
 *    instead — a QR of the wrong machine's localhost is a lie you can scan.
 * 2. **Insertion order**: this browser's address, then the base URL, then the
 *    rest of the allowlist (the server's LAN addresses first among those).
 *    An address this browser is already talking to is the one address proven
 *    to work from a device on this network — the best available guess for
 *    the device beside it.
 *
 * An entry that is not a parseable URL is dropped rather than rendered. The
 * server canonicalizes the list, but a cached PWA can be talking to an older
 * one and a hand-edited config.env never passes the validator at all.
 *
 * The list is the trusted-origin allowlist the server answers from, so a
 * chosen row is one `install.sh` will accept as its `server` param — the
 * dialog and the route read the same registry, one through
 * `GET /api/settings/public` and one live — with the one exception the route
 * owns: a hand-edited registry entry whose spelling bash could expand is
 * refused by its bake guard, which falls back to `APP_BASE_URL` and says so
 * in the script's own "enrolling with" line.
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
    if (isLoopbackUrl(url)) return;
    const existing = byUrl.get(url);
    if (existing) {
      // The MARKS accumulate, not the rows: one address that happens to be all
      // three facts is still one address.
      Object.assign(existing, mark);
      return;
    }
    byUrl.set(url, { url, here: false, baseUrl: false, ...mark });
  };

  add(here, { here: true });
  add(baseUrl, { baseUrl: true });
  for (const origin of trustedOrigins ?? []) add(origin, {});

  return [...byUrl.values()];
}

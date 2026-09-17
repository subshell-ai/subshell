import os from "node:os";

/**
 * The origins this machine's OWN network interfaces answer on — the fourth
 * derived source of the trusted-origin list (`services/trusted-origins.ts`).
 *
 * It exists because of one measured failure, repeated: the "Subshell for
 * Mobile" QR picker can only offer addresses sign-in will ACCEPT, and on the
 * default `0.0.0.0` bind the derived set is the two loopback spellings plus
 * the dev ports. The phone scans a code that resolves to itself, or — if the
 * operator already knew to add the address under Service — types an IP because
 * no picker could know it either. `docs/security.md` §8 calls this exact set
 * of rows "a listen address, not one anyone visits" and leaves them out; what
 * it cannot leave out is the machine's own LAN address, which IS one anyone
 * visits and is the answer `HOST` cannot spell (a wildcard names no interface).
 *
 * This does not cross the DNS-rebinding line the §8 rule draws: an entry here
 * is a fact about THIS host read off the kernel, never off a request's
 * `Host`/`Origin`, and a rebinding attack's Origin is always the attacker's
 * HOSTNAME STRING, which can never equal a literal-IP entry.
 */

/** The slice of `os.networkInterfaces()` this reads — enough for fixtures to name one fact, not three unused fields. */
export interface LanInterfaceAddress {
  address: string;
  family: string;
  internal: boolean;
}

export type LanInterfaces = Record<string, readonly LanInterfaceAddress[] | undefined>;

/** The wildcard bind spellings: the server answers on every interface, so the LAN addresses are served, not merely held. */
function isWildcardBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";
}

/**
 * The LAN origins to trust for a browser on this machine's networks.
 *
 * Empty unless the bind is a wildcard: a concrete `HOST` already contributes
 * its own origin via `localOriginsFor`, and a loopback bind would put rows in
 * the picker that connect to nothing. Non-internal IPv4 only: IPv6 is skipped
 * whole, because the `fe80` link-locals need a scope id nobody can type and no
 * phone has been observed preferring a ULA enough to buy a second address
 * family for. `169.254/16` is what an interface with no network self-assigns
 * and `0.0.0.0` is "this host on this network": both are the dead row the
 * picker's rules exist to prevent. A Tailscale `100.64/10` address is KEPT —
 * it is dialable from any device on the tailnet whether or not the plugin is
 * installed, and when it is, the registry dedupes the identical entry.
 *
 * Every entry serializes through `URL.origin` like `localOriginsFor` does:
 * an `http://x:80`-shaped entry matches no `Origin` a browser sends, which
 * is the silently-inert bug that file records.
 */
export function lanOriginsFor(port: number, host: string, interfaces: LanInterfaces): string[] {
  if (!isWildcardBind(host)) return [];
  const origins = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== "IPv4") continue;
      if (info.address.startsWith("169.254.") || info.address === "0.0.0.0") continue;
      try {
        origins.add(new URL(`http://${info.address}:${port}`).origin);
      } catch {}
    }
  }
  return [...origins];
}

const liveInterfaces = (): LanInterfaces => os.networkInterfaces() as LanInterfaces;

let probe: () => LanInterfaces = liveInterfaces;

/** {@link lanOriginsFor} over THIS machine's live interfaces. Cheap — a `getifaddrs` per call, which is why the registry re-asks it rather than freezing it. */
export function lanOrigins(port: number, host: string): string[] {
  return lanOriginsFor(port, host, probe());
}

/**
 * Swaps the interface probe (null restores the live one) so a route test can
 * simulate a Wi-Fi switch. Test-only by construction, like
 * `setPluginsRegistryUrlForTests`.
 * @internal
 */
export function setLanProbeForTests(fn: (() => LanInterfaces) | null): void {
  probe = fn ?? liveInterfaces;
}

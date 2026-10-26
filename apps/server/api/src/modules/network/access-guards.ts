import type { RequestGuardSpec } from "@internal/pane-runtime";

/** The guard set, plus the lookup built from it. Replaced wholesale, never mutated. */
interface ActiveGuards {
  /** As {@link setAccessGuards} was given them, for {@link activeAccessGuards}. */
  specs: readonly OwnedGuard[];
  /** Normalised hostname → spec, the per-request lookup. */
  byHost: ReadonlyMap<string, RequestGuardSpec>;
}
/**
 * One guard, tagged with the plugin the HOST resolved it from.
 *
 * The tag is not part of {@link RequestGuardSpec} and must not become one: a
 * field a plugin filled in would be a field one plugin could use to claim
 * another's guard. This is the host's own bookkeeping, attached where the host
 * already knows the answer.
 */
export interface OwnedGuard {
  /** The plugin whose `requestGuard` produced this. */
  pluginId: string;
  /** What that plugin declared. */
  spec: RequestGuardSpec;
}
let active: ActiveGuards = { specs: [], byHost: new Map() };
/**
 * Replaces the ACTIVE guard set.
 *
 * Wholesale, never incremental: publish and unpublish both compute the set
 * they want and hand it over, so there is no window in which half of one
 * plugin's guard is installed. A hostname appearing twice keeps the LAST
 * entry, which is what makes "filter this hostname out, then append" the
 * idiomatic re-publish.
 *
 * Arming a guard is what makes a tunnel safe, so a caller arms BEFORE the
 * tunnel exists and disarms AFTER it is gone (spec § 5.3).
 */
export function setAccessGuards(guards: OwnedGuard[]): void {
  const byHost = new Map<string, RequestGuardSpec>();
  for (const { spec } of guards) byHost.set(normalizeHost(spec.hostname), spec);
  active = { specs: [...guards], byHost };
}
/** The guard set currently applied, in the order it was installed. */
export function activeAccessGuards(): OwnedGuard[] {
  return [...active.specs];
}
/**
 * Replaces the guards owned by ONE plugin, leaving every other plugin's alone.
 *
 * Ownership is the HOST's record — the plugin id it looked the plugin up by —
 * and never anything the plugin supplied. That is what makes removal work at
 * all: identifying a guard by recomputing it and comparing values meant a
 * settings change while published left the installed guard unremovable, since
 * the plugin now describes a different hostname or audience than the one
 * standing. It also keeps the property the value-identity approach was
 * protecting: a plugin still cannot name another plugin's guard, because it
 * never names an owner.
 * @param pluginId - whose guards these are
 * @param specs - the guards that plugin declares now; empty removes its own
 */
export function setPluginGuards(pluginId: string, specs: RequestGuardSpec[]): void {
  setAccessGuards([
    ...activeAccessGuards().filter((owned) => owned.pluginId !== pluginId),
    ...specs.map((spec) => ({ pluginId, spec })),
  ]);
}
/**
 * A `Host` header reduced to what a guard's `hostname` is compared against.
 *
 * Every step here closes a way of naming the SAME host that a plain
 * lowercase-and-strip-the-port comparison would miss, and a miss means the
 * guard skips itself on a hostname it was installed for. Measured against a
 * Bun 1.4.2 listener:
 *
 * | sent | `headers.get("host")` | without this |
 * |---|---|---|
 * | `Host: guarded.example.com.` | `guarded.example.com.` | missed |
 * | `Host: a` and `Host: b` | `a, b` | missed |
 *
 * - **A duplicate Host header** is joined by the Headers API into `a, b`, which
 *   matches nothing. There is no honest reading of two Host headers, so the
 *   first is taken and compared: a request that names a guarded host at all is
 *   a request that guard must see. (A request naming it SECOND is still
 *   caught, because the whole value matches no guard and the caller then
 *   refuses anything containing a guarded name — see {@link hostMatches}.)
 * - **A trailing dot** is the fully-qualified spelling of the same name and
 *   resolves identically, so `example.com.` and `example.com` are one host.
 * - An IPv6 literal keeps its brackets, the only form a Host header may carry
 *   one in.
 */
export function normalizeHost(value: string): string {
  // The first of several, not the joined string: see the docstring.
  const first = value.split(",")[0] ?? "";
  const host = first.trim();
  // **The URL parser does the normalizing**, and hand-rolling it was a
  // measured bypass: `Host: 127%2E0.0.1` reached a guarded listener with a
  // 200, because nothing here percent-decoded, so neither the map lookup nor
  // the comma refusal fired and the loopback belt was never consulted. Any
  // character can be encoded, so that was a FAMILY of spellings rather than
  // one. Bun itself disagreed with the hand-rolled version — it builds
  // `request.url` from the decoded host — so the runtime serving the request
  // and the guard in front of it named different hosts.
  //
  // Parsing also subsumes the three things this used to do by hand:
  // lowercasing, stripping the port, and keeping an IPv6 literal's brackets.
  const parsed = (() => {
    try {
      return new URL(`http://${host}`).hostname;
    } catch {
      // Not a host the parser will accept, so it is not one a guard can match
      // either. Returned lowercased so the comparison is still total, and it
      // simply will not equal anything in the map.
      return host.toLowerCase();
    }
  })();
  // The root label. `example.com.` and `example.com` name the same host.
  return parsed.replace(/\.+$/, "");
}

/** Snapshot of the guard set used for one request. */
export function accessGuardSnapshot(): ActiveGuards {
  return active;
}

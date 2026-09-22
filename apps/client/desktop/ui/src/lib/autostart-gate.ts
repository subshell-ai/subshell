/**
 * The run-at-login switch's version gate, pure (round two, 2026-09-22).
 *
 * The Service section's switch writes through `service autostart on|off`, a
 * verb the node CLI gained in 0.15.0. An older agent can still READ the
 * state — `autostart` on new agents, `enabled` as the fallback older ones
 * always answered — but has nothing to WRITE it with, so the switch shows
 * the answer greyed with the update that unlocks it, exactly the server's
 * `autostartSupported` pattern rather than a press that would come back a
 * usage error.
 */
import type { Probe } from "@/lib/ipc";

/**
 * The first node CLI whose `service autostart on|off` can carry the switch's
 * answer. This wave's `@internal/node` minor is what ships the verb, and the
 * gate names it because the hint line promises the exact update.
 */
export const MIN_AUTOSTART_NODE_VERSION = "0.15.0";

/**
 * Whether the resolved agent is new enough to control start-at-login.
 *
 * Unknown version assumes capable, exactly as the server's twin argues: a
 * control disabled by a string this side could not parse is worse than the
 * CLI's own refusal, which arrives with its words. `nodeBinary.version` is
 * the resolved rung's answer — the binary the service definition and this
 * app would actually run — not the bundled one.
 */
export function autostartSupported(probe: Probe | undefined): boolean {
  const found = probe?.nodeBinary?.version;
  if (!found) return true;
  return !isOlder(found, MIN_AUTOSTART_NODE_VERSION);
}

/** Numeric semver compare — `1.10.0` is newer than `1.9.0`, which a string compare denies. */
function isOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

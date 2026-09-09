import type { DetectionReason } from "./binary-lookup.js";
import { allHarnesses, type HarnessPlugin } from "./index.js";

/** One row of a node's harness inventory (spec 2026-08-31 §3.3, extended 2026-09-09 §7). */
export interface HarnessInventoryEntry {
  /** Harness plugin id */
  harnessId: string;
  /** CLI binary found and executable from this machine's perspective */
  installed: boolean;
  /** `<binary> --version` output when installed and readable */
  version?: string;
  /** Resolved binary path when installed */
  binaryPath?: string;
  /**
   * Why the binary was not found. Absent when installed, and absent from
   * entries reported by an agent older than this field, so a reader treats
   * absence as "unknown" rather than as a default that asserts something.
   */
  reason?: DetectionReason;
  /** ISO 8601 stamp of when this entry was probed. Absent from older agents. */
  checkedAt?: string;
}

/**
 * Probe ONE harness, defensively: any throwing probe (a plugin whose
 * `detect`/`getVersion` rejects on a weird filesystem)
 * degrades to `{ harnessId, installed: false }` — one broken plugin must
 * never fail an entire inventory scan (the agent reports "not installed"
 * rather than losing the whole harness list).
 * @param h - the plugin to probe
 * @returns one inventory entry; never rejects
 */
export async function scanOne(h: HarnessPlugin, now: Date = new Date()): Promise<HarnessInventoryEntry> {
  const checkedAt = now.toISOString();
  try {
    // ONE detect() call, where this used to run isInstalled() and then
    // findBinary(): both walk the whole ladder, so the old shape paid for the
    // PATH scan, the known locations and the version-manager globs twice per
    // harness per scan.
    const found = await h.detect();
    if (found.path === null) return { harnessId: h.id, installed: false, reason: found.reason, checkedAt };
    const version = await h.getVersion();
    return {
      harnessId: h.id,
      installed: true,
      binaryPath: found.path,
      ...(version ? { version } : {}),
      checkedAt,
    };
  } catch {
    // No reason is reported here on purpose: we do not have one. The probe
    // itself failed, which is different from having looked and not found it.
    return { harnessId: h.id, installed: false, checkedAt };
  }
}

/**
 * Probe every built-in harness ON THIS MACHINE. Detection is process-local
 * by construction (spec §1, harnesses/binary-lookup.ts) — which is precisely
 * why the agent imports this package: control plane and node run identical
 * plugin code against their own filesystems. Per-plugin failures are
 * contained by {@link scanOne}; the scan itself always completes.
 */
export async function scanHarnesses(now: Date = new Date()): Promise<HarnessInventoryEntry[]> {
  // One stamp for the batch: the entries were probed together and a reader
  // comparing them should not see them drift by milliseconds.
  return Promise.all(allHarnesses().map((h) => scanOne(h, now)));
}

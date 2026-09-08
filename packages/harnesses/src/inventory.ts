import { ALL_HARNESSES, type HarnessPlugin } from "./index.js";

/** One row of a node's harness inventory (spec 2026-08-31 §3.3). */
export interface HarnessInventoryEntry {
  /** Harness plugin id */
  harnessId: string;
  /** CLI binary found and executable from this machine's perspective */
  installed: boolean;
  /** `<binary> --version` output when installed and readable */
  version?: string;
  /** Resolved binary path when installed */
  binaryPath?: string;
}

/**
 * Probe ONE harness, defensively: any throwing probe (a plugin whose
 * `isInstalled`/`findBinary`/`getVersion` rejects on a weird filesystem)
 * degrades to `{ harnessId, installed: false }` — one broken plugin must
 * never fail an entire inventory scan (the agent reports "not installed"
 * rather than losing the whole harness list).
 * @param h - the plugin to probe
 * @returns one inventory entry; never rejects
 */
export async function scanOne(h: HarnessPlugin): Promise<HarnessInventoryEntry> {
  try {
    const installed = await h.isInstalled();
    if (!installed) return { harnessId: h.id, installed: false };
    const [binaryPath, version] = await Promise.all([h.findBinary(), h.getVersion()]);
    return {
      harnessId: h.id,
      installed: true,
      ...(binaryPath ? { binaryPath } : {}),
      ...(version ? { version } : {}),
    };
  } catch {
    return { harnessId: h.id, installed: false };
  }
}

/**
 * Probe every built-in harness ON THIS MACHINE. Detection is process-local
 * by construction (spec §1, harnesses/binary-lookup.ts) — which is precisely
 * why the agent imports this package: control plane and node run identical
 * plugin code against their own filesystems. Per-plugin failures are
 * contained by {@link scanOne}; the scan itself always completes.
 */
export async function scanHarnesses(): Promise<HarnessInventoryEntry[]> {
  return Promise.all(ALL_HARNESSES.map((h) => scanOne(h)));
}

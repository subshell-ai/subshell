/**
 * The node-side MACHINE pin store for the SSH agent relay (spec 2026-10-08
 * §4.4). Each side pins BOTH of a peer's public keys - the ES256 signing key
 * (§4.1) and the ECDH-ES encryption key sealing uses - as the raw public JWK
 * strings the plane brokered at first pairing, and thereafter enforces
 * byte equality on each, mirroring `pin-store.ts`'s comparison rule.
 *
 * Always strict, deliberately: this store NEVER reads `SUBSHELL_CHANNEL_PIN`.
 * The channel escape hatch ("trust") relaxes the pane channels' peer TOFU in
 * `packages/mcp-core/src/pin-store.ts`; reusing it here would let one env var
 * silently unpin every machine relationship, which §4.4 forbids ("never its
 * escape hatch"). Pinning the encryption half is what makes the plane's
 * blindness (§5.5) real: a plane that could substitute a peer's encryption
 * key would read every relay seal, and this byte-equality block refuses it.
 *
 * The file is `<nodeDataDir>/ssh-machine-pins.json` (0600) - a DISTINCT file
 * from the pane channels' `peers.json`, which lives under the MCP data dir
 * and is written by code this store must not touch. `dataDir` is the agent's
 * configured data dir (the same value `identity.ts` stores its keypairs in),
 * supplied by the caller from `loadConfig()`; nothing here re-derives it.
 *
 * Corruption is fail-closed like the sibling stores: a PRESENT-but-unreadable
 * file is moved aside and throws - an unreadable pin set never silently
 * becomes "no pins".
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A peer's pinned public halves, stored as the exact raw JWK strings. */
export interface MachinePin {
  /** Public JWK JSON (P-256 / ES256) - the peer's machine signing identity. */
  signing: string;
  /** Public JWK JSON (P-256 / ECDH-ES) - the key relay seals to. */
  encryption: string;
}

/** Result of comparing a candidate against the stored pin. */
export type MachinePinVerdict = "ok" | "changed";

/** The store's file name inside the node data dir (never `peers.json`). */
const PIN_FILE_NAME = "ssh-machine-pins.json";

/** Absolute path of the machine pin file inside a node data dir. */
export function machinePinPath(dataDir: string): string {
  return join(dataDir, PIN_FILE_NAME);
}

/** Reads a `MachinePin` out of parsed JSON, or null when the shape is junk. */
function isMachinePin(value: unknown): value is MachinePin {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.signing === "string" && typeof entry.encryption === "string";
}

/**
 * Byte-equality pins for relay peers, one JSON map per node data dir. Every
 * method reads the file fresh, so a re-pair written by another process is
 * visible without restarting the agent.
 */
export class MachinePinStore {
  /** The node data dir holding `ssh-machine-pins.json` (config `dataDir`). */
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * The stored pin for a peer, or `null` when the peer has never been pinned.
   * @throws Error when the pin file exists but cannot be read or parsed.
   */
  get(nodeId: string): MachinePin | null {
    return this.loadAll()[nodeId] ?? null;
  }

  /**
   * Store (or REPLACE) a peer's pin - the write of a first pairing and of
   * §4.5's re-pair alike. Other peers' entries ride through untouched.
   */
  pin(nodeId: string, pin: MachinePin): void {
    const all = this.loadAll();
    all[nodeId] = { signing: pin.signing, encryption: pin.encryption };
    this.saveAll(all);
  }

  /**
   * Compare a candidate against the stored pin, BYTE-FOR-BYTE on both raw
   * public strings (fingerprints are display, not trust). Any difference in
   * either half is `"changed"`, and so is a peer that has no pin at all: the
   * store fails closed, it never blesses a stranger.
   * @throws Error on an unreadable pin file (fail closed, never "changed").
   */
  check(nodeId: string, candidate: MachinePin): MachinePinVerdict {
    const pinned = this.get(nodeId);
    if (pinned === null) return "changed";
    return pinned.signing === candidate.signing && pinned.encryption === candidate.encryption ? "ok" : "changed";
  }

  /**
   * Read the whole map. ENOENT (first run) is the one legitimate empty set;
   * any other failure quarantines the file and throws - the pin set is never
   * silently reset (the pin-store.ts doctrine).
   */
  private loadAll(): Record<string, MachinePin> {
    const file = machinePinPath(this.dataDir);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`machine pin file ${file} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw this.quarantine(file, err);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw this.quarantine(file, new Error("top level is not a JSON object"));
    }
    const all: Record<string, MachinePin> = {};
    for (const [peerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isMachinePin(value)) {
        throw this.quarantine(file, new Error(`entry '${peerId}' is not a {signing, encryption} pin object`));
      }
      all[peerId] = { signing: value.signing, encryption: value.encryption };
    }
    return all;
  }

  /** Write the whole map, keys sorted for stable diffs, then force 0600. */
  private saveAll(all: Record<string, MachinePin>): void {
    const file = machinePinPath(this.dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    const sorted: Record<string, MachinePin> = {};
    for (const peerId of Object.keys(all).sort()) {
      sorted[peerId] = all[peerId];
    }
    // The mode option covers O_CREAT only, is masked by the umask, and is
    // ignored for a file that already exists - chmod after write is the part
    // that actually guarantees 0600 (same posture as identity.ts).
    writeFileSync(file, JSON.stringify(sorted, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** Moves an unparseable pin file aside and throws (fails the read closed). */
  private quarantine(file: string, cause: unknown): never {
    let aside = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch {
      aside = `${file} (could not move aside)`;
    }
    throw new Error(
      `machine pin file is corrupt (${cause instanceof Error ? cause.message : String(cause)}); ` +
        `refusing to treat the pin set as empty. The file (${aside}) was NOT reset; ` +
        "restore it by hand or re-pair each peer after verifying out-of-band.",
    );
  }
}

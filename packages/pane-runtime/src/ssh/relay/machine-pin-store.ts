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
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * A fresh peer-keyed map with NO prototype. A plain `{}` would let
 * `get("__proto__")` or `get("toString")` read back inherited members
 * instead of "never pinned", breaking the null contract Tasks 6 and 8
 * branch on; prototype-free, those ids are ordinary missing keys.
 */
function emptyPinMap(): Record<string, MachinePin> {
  return Object.create(null) as Record<string, MachinePin>;
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
   * Store a peer's pin at FIRST pairing (spec 2026-10-08 §4.4: the
   * plane-delivered keys become the pin). Refuses when an entry for that
   * peer already exists: a changed peer is a block, not a re-pin, and §4.5
   * makes {@link repair} the ONLY sanctioned replace route. The two relay
   * branches already check the null-pinned case before calling this (and
   * hard-block on a moved one); the refusal here is the structural guard
   * beneath that call-site discipline, so no ordering bug can ever
   * silently overwrite a pinned peer. The error names the peer id and the
   * cause, never key bytes.
   */
  pin(nodeId: string, pin: MachinePin): void {
    if (this.loadAll()[nodeId] !== undefined) {
      throw new Error(`machine pin exists for ${nodeId}: a changed peer is a block, not a re-pin`);
    }
    this.repair(nodeId, pin);
  }

  /**
   * §4.5's re-pair write: replace the stored entry for THAT peer byte-for-byte
   * with the delivered pair - the ONLY sanctioned way a pinned entry ever
   * changes. Normal pairing checks stay byte-strict ({@link check}): nothing
   * here relaxes or consults a comparison, and an UN-repaired peer's block
   * persists until its owner acts. When the store holds no entry for the peer
   * the write adds one (a re-pair after a lost store is the same act). Other
   * peers' entries ride through untouched; the atomic tmp+rename 0600
   * discipline and the corrupt-file fail-closed read are the store's own,
   * unchanged. Validating the delivered JWKs (public-only, no `d`) is the
   * CALLER's duty before this write - the `ssh_machine_pin_repair` handler
   * re-runs `bytesOfJwk` on both halves - which keeps the store's job one
   * thing: byte-faithful persistence.
   */
  repair(nodeId: string, pin: MachinePin): void {
    const all = this.loadAll();
    all[nodeId] = { signing: pin.signing, encryption: pin.encryption };
    this.saveAll(all);
  }

  /**
   * Every pinned peer as `{ nodeId, pin }` pairs, id ascending: the source of
   * the §4.6 trust block the `ready` report and the loopback dashboard render
   * (fingerprints are computed from these raw strings by the caller, never
   * stored). The empty array is the honest "no peers yet"; a corrupt file
   * throws like every other read, it never lists as empty.
   */
  entries(): { nodeId: string; pin: MachinePin }[] {
    const all = this.loadAll();
    return Object.keys(all)
      .sort()
      .map((nodeId) => ({ nodeId, pin: { signing: all[nodeId].signing, encryption: all[nodeId].encryption } }));
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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Quarantine is a refusal, never a new TOFU opportunity on the next request or restart.
        let names: string[];
        try {
          names = readdirSync(this.dataDir);
        } catch (dirError) {
          if ((dirError as NodeJS.ErrnoException).code === "ENOENT") return emptyPinMap();
          throw dirError;
        }
        if (names.some((name) => name.startsWith(`${PIN_FILE_NAME}.corrupt-`)))
          throw new Error("machine pin file remains quarantined; restore its verified pins before pairing");
        return emptyPinMap();
      }
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
    const all = emptyPinMap();
    for (const [peerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isMachinePin(value)) {
        throw this.quarantine(file, new Error(`entry '${peerId}' is not a {signing, encryption} pin object`));
      }
      all[peerId] = { signing: value.signing, encryption: value.encryption };
    }
    return all;
  }

  /**
   * Write the whole map, keys sorted for stable diffs: a full tmp-then-rename
   * (rename is atomic within a directory, so a crash mid-write leaves the
   * previous file intact, never a truncated pin set), then force 0600.
   */
  private saveAll(all: Record<string, MachinePin>): void {
    const file = machinePinPath(this.dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    const sorted = emptyPinMap();
    for (const peerId of Object.keys(all).sort()) {
      sorted[peerId] = all[peerId];
    }
    // The mode option covers O_CREAT only, is masked by the umask, and is
    // ignored for a file that already exists - chmod after the rename is the
    // part that actually guarantees 0600 on the final file (same posture as
    // identity.ts).
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(sorted, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
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
        "restore the verified pin file from backup before pairing again. Peer repair cannot recover a quarantined store.",
    );
  }
}

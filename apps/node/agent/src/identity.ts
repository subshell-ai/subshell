/**
 * Port of backend mcp/identity-store.ts (spec 2026-08-31, task 12): the same
 * fail-closed rules and quarantine wording, simplified to one keypair FILE per
 * role (a node has no principal-per-file; it IS the principal). Deliberately a
 * copy: the dependency direction is agent -> packages, never agent -> backend.
 *
 * Two keypairs, one file each, for the protocol-18 SSH relay (spec 2026-10-08 §4.1): the
 * ECDH-ES encryption pair in `identity.json` (sealed delivery) and the ES256
 * signing pair in the sibling `node-signing-identity.json` (SSH relay payloads,
 * M2). The signing pair is generated at the same moment and posture as the
 * encryption pair and follows the exact same discipline below.
 *
 * Fail-closed: ONLY a genuinely missing file (ENOENT) generates a fresh key.
 * Any other read/parse failure on a PRESENT file means key material exists we
 * cannot read - the file is moved aside (best-effort) and the call throws,
 * never silently rotating over the old key and orphaning sealed history.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";

/**
 * The node's persisted keypairs. JWKs as JSON strings, mirroring the backend
 * store; each pair lives in its own file, so one file's corruption can only
 * ever rotate its own key.
 */
export interface NodeIdentity {
  /** Public JWK JSON (P-256 / ECDH-ES) - sent at enroll, registered for sealed delivery. */
  publicJwk: string;
  /** Private JWK JSON - never leaves this file. */
  privateJwk: string;
  /**
   * Public JWK JSON (P-256 / ES256) - the machine's signing identity for the
   * SSH agent relay (spec 2026-10-08 §4.1); sent at enroll, registered beside
   * the encryption key in the same `node:` identities record (§4.2).
   */
  signingPublicJwk: string;
  /** Signing private JWK JSON - never leaves this machine; signs relay payloads only. */
  signingPrivateJwk: string;
}

/** The on-disk shape of one keypair file; both files share it. */
interface KeypairFile {
  publicJwk: string;
  privateJwk: string;
}

/** Absolute path of the encryption identity file inside a data dir. */
export function identityPath(dataDir: string): string {
  return join(dataDir, "identity.json");
}

/** Absolute path of the ES256 signing identity file inside a data dir. */
export function signingIdentityPath(dataDir: string): string {
  return join(dataDir, "node-signing-identity.json");
}

/**
 * Loads the node's keypairs (encryption + signing), generating and persisting
 * any missing one on first run. An existing ECDH file is never rewritten by
 * this call, so a pre-M2 node upgrades into a fresh signing pair without its
 * encryption identity moving.
 */
export async function loadOrCreateIdentity(dataDir: string): Promise<NodeIdentity> {
  // The dir will hold the private key material, so a dir WE create gets 0700 -
  // unconditionally chmod'd, because mkdir's `mode` option is masked by the
  // umask and cannot guarantee it. A dir that already exists is left alone:
  // whoever created it chose its mode (shared mount, pre-seeded permissions,
  // a deliberate ACL), and silently re-modding an operator's directory is
  // not this function's business.
  const weCreated = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true });
  if (weCreated) chmodSync(dataDir, 0o700);
  const encryption = await loadOrCreateKeypair(identityPath(dataDir), "ECDH-ES");
  const signing = await loadOrCreateKeypair(signingIdentityPath(dataDir), "ES256");
  return {
    publicJwk: encryption.publicJwk,
    privateJwk: encryption.privateJwk,
    signingPublicJwk: signing.publicJwk,
    signingPrivateJwk: signing.privateJwk,
  };
}

/**
 * Load one keypair file, minting it on ENOENT only. Any other failure on a
 * PRESENT file quarantines that file and throws - the refusal names the file,
 * so an operator sees WHICH half they are about to lose.
 */
async function loadOrCreateKeypair(file: string, alg: "ECDH-ES" | "ES256"): Promise<KeypairFile> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    // Valid JSON that is not a usable keypair is corruption of a PRESENT file,
    // not a first run - the SyntaxError routes it into quarantine below.
    if (!isKeypairFile(parsed)) throw new SyntaxError("identity file is valid JSON but not an identity object");
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return await writeFresh(file, alg);
    const reason = err instanceof SyntaxError ? "parse" : ((err as NodeJS.ErrnoException).code ?? "read");
    let aside = `${file}.corrupt-${reason}`;
    if (existsSync(aside)) aside = `${aside}-${Date.now()}`;
    let quarantined: string | null = null;
    try {
      renameSync(file, aside);
      quarantined = aside;
    } catch {
      // Best-effort quarantine; the refusal below stands either way.
    }
    throw new Error(
      `identity file '${file}' is unreadable (${reason}); refusing to overwrite existing key material` +
        (quarantined ? `; moved it aside to '${quarantined}'` : "; could not move it aside"),
    );
  }
}

function isKeypairFile(v: unknown): v is KeypairFile {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as KeypairFile).publicJwk === "string" &&
    typeof (v as KeypairFile).privateJwk === "string"
  );
}

async function writeFresh(file: string, alg: "ECDH-ES" | "ES256"): Promise<KeypairFile> {
  // Bun's crypto.subtle lacks ECDH generateKey; jose falls back to node:crypto
  // internally (same path @internal/mcp-core's crypto.ts documents). ES256
  // rides the same generator - both are P-256, the algorithm is the purpose.
  const { publicKey, privateKey } = await generateKeyPair(alg, { crv: "P-256", extractable: true });
  const keypair: KeypairFile = {
    publicJwk: JSON.stringify(await exportJWK(publicKey)),
    privateJwk: JSON.stringify(await exportJWK(privateKey)),
  };
  writeFileSync(file, JSON.stringify(keypair, null, 2), { mode: 0o600 });
  return keypair;
}

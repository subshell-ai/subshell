/**
 * Port of backend mcp/identity-store.ts (spec 2026-08-31, task 12) — the same
 * fail-closed rules and quarantine wording, simplified to ONE keypair per data
 * dir (a node has no principal-per-file; it IS the principal). Deliberately a
 * copy: the dependency direction is agent → packages, never agent → backend.
 *
 * Fail-closed: ONLY a genuinely missing file (ENOENT) generates a fresh key.
 * Any other read/parse failure on a PRESENT file means key material exists we
 * cannot read — the file is moved aside (best-effort) and the call throws,
 * never silently rotating over the old key and orphaning sealed history.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";

/** The node's persisted keypair (JWKs as JSON strings, mirroring the backend store). */
export interface AgentIdentity {
  /** Public JWK JSON (P-256 / ECDH-ES) — sent at enroll, registered for sealed delivery. */
  publicJwk: string;
  /** Private JWK JSON — never leaves this file. */
  privateJwk: string;
}

/** Absolute path of the identity file inside a data dir. */
export function identityPath(dataDir: string): string {
  return join(dataDir, "identity.json");
}

/** Loads the node's keypair, generating and persisting one on first run. */
export async function loadOrCreateIdentity(dataDir: string): Promise<AgentIdentity> {
  // The dir will hold the private key material, so a dir WE create gets 0700 —
  // unconditionally chmod'd, because mkdir's `mode` option is masked by the
  // umask and cannot guarantee it. A dir that already exists is left alone:
  // whoever created it chose its mode (shared mount, pre-seeded permissions,
  // a deliberate ACL), and silently re-modding an operator's directory is
  // not this function's business.
  const weCreated = !existsSync(dataDir);
  mkdirSync(dataDir, { recursive: true });
  if (weCreated) chmodSync(dataDir, 0o700);
  const file = identityPath(dataDir);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    // Valid JSON that is not a usable identity is corruption of a PRESENT file,
    // not a first run — the SyntaxError routes it into quarantine below.
    if (!isIdentity(parsed)) throw new SyntaxError("identity file is valid JSON but not an identity object");
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return await writeFresh(file);
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
      `identity file '${file}' is unreadable (${reason}) — refusing to overwrite existing key material` +
        (quarantined ? `; moved it aside to '${quarantined}'` : "; could not move it aside"),
    );
  }
}

function isIdentity(v: unknown): v is AgentIdentity {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as AgentIdentity).publicJwk === "string" &&
    typeof (v as AgentIdentity).privateJwk === "string"
  );
}

async function writeFresh(file: string): Promise<AgentIdentity> {
  // Bun's crypto.subtle lacks ECDH generateKey; jose falls back to node:crypto
  // internally (same path @internal/mcp-core's crypto.ts documents).
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  const identity: AgentIdentity = {
    publicJwk: JSON.stringify(await exportJWK(publicKey)),
    privateJwk: JSON.stringify(await exportJWK(privateKey)),
  };
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

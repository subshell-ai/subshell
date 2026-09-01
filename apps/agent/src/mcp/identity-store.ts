import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeypair, type IdentityKeyPair } from "./crypto.js";

/**
 * File-backed persistence for the local `mote mcp` process's keypair, so a
 * session keeps the SAME principal identity across MCP restarts (the channel
 * roster addresses it by `sess:<id>`, and sealed posts must stay readable).
 *
 * Lives under <dataDir>/identities/<principal>.json with mode 0600. The file
 * stamps its principal; a path/principal mismatch is refused rather than
 * silently overwritten (losing the key would orphan the session's history).
 *
 * Fail-closed: ONLY a genuinely missing file (ENOENT) triggers fresh key
 * generation. Any other read/parse failure on a PRESENT file means key
 * material exists that we cannot read — the file is moved aside (best-effort)
 * and the call throws, never silently rotating over the old key and orphaning
 * message history.
 */
/** Thrown when an existing identity file belongs to a DIFFERENT principal. */
export class IdentityPrincipalMismatchError extends Error {}

export async function loadOrCreateIdentity(dataDir: string, principalId: string): Promise<IdentityKeyPair> {
  const dir = join(dataDir, "identities");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${principalId.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`);
  let stored: IdentityKeyPair;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    // Valid JSON that is not an object (e.g. the literal `null`) is
    // corruption of a PRESENT file, not a first run — a SyntaxError routes it
    // into the quarantine path below with reason "parse" (final review M-3;
    // before this it died on `stored.principalId` with a bare TypeError).
    if (typeof parsed !== "object" || parsed === null) {
      throw new SyntaxError("identity file is valid JSON but not an object");
    }
    stored = parsed as IdentityKeyPair;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No file at all — this is a first run for the principal; generating a
      // fresh keypair is exactly right.
      return await writeFresh(file, principalId);
    }
    // EACCES/EIO/corrupt JSON on a file that IS there: quarantine and refuse.
    const reason = err instanceof SyntaxError ? "parse" : ((err as NodeJS.ErrnoException).code ?? "read");
    let aside = `${file}.corrupt-${reason}`;
    if (existsSync(aside)) aside = `${aside}-${Date.now()}`;
    let quarantined: string | null = null;
    try {
      renameSync(file, aside);
      quarantined = aside;
    } catch {
      // Best-effort quarantine; the refusal below stands either way and we
      // still never write over the unreadable file.
    }
    throw new Error(
      `identity file '${file}' is unreadable (${reason}) — refusing to overwrite existing key material` +
        (quarantined ? `; moved it aside to '${quarantined}'` : "; could not move it aside"),
    );
  }
  if (stored.principalId !== principalId) {
    throw new IdentityPrincipalMismatchError(
      `identity file for '${file}' belongs to principal '${stored.principalId}', not '${principalId}'`,
    );
  }
  return stored;
}

/** Generates and persists a fresh keypair for a principal with no file. */
async function writeFresh(file: string, principalId: string): Promise<IdentityKeyPair> {
  const generated = await generateKeypair();
  const identity: IdentityKeyPair = { principalId, ...generated };
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

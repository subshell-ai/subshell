import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodeSshIdentity } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { loadOrCreateIdentity, signingIdentityPath } from "../identity.js";

/**
 * `ssh_register_identity` (spec 2026-10-08 §4.3): the machine answers its
 * SIGNING PUBLIC JWK and nothing else. Driven through `dispatchCommand`
 * exactly as the daemon drives it (the commands-ssh.test.ts posture).
 *
 * What this file owns:
 * - the answer IS `identity.signingPublicJwk`, byte for byte, stable across
 *   asks (a re-report after rotation must not read as a mismatch);
 * - the private half NEVER rides out: no `d` in the answer's JWK, and the
 *   serialized result never contains the stored private JWK;
 * - NO ssh-enabled gate: registration is the machine's own act, not an SSH
 *   act, and a pre-M2 node hits it while its mirror still says off;
 * - a corrupt signing file fails closed through dispatch's whole-switch wrap
 *   (identity.ts quarantines and throws; the plane learns `ok:false`).
 */

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-ssh-id-")));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeCtx(dataDir: string): CommandContext {
  return { config: { dataDir } } as unknown as CommandContext;
}

function freshDir(tag: string): string {
  const dir = join(base, tag, "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ssh_register_identity", () => {
  it("answers the signing PUBLIC jwk byte-for-byte, stable across asks", async () => {
    const dir = freshDir("basic");
    const identity = await loadOrCreateIdentity(dir);
    const first = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(first.ok).toBe(true);
    const parsed = parseNodeSshIdentity(first.ok ? first.data : null);
    expect(parsed?.signingPublicKey).toBe(identity.signingPublicJwk);
    // The §4.3 guard compares BYTES: a second ask must answer the same string.
    const second = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(second.ok && second.data).toEqual(first.ok ? first.data : null);
  });

  it("the private half never leaves: no d member in the answer, no private jwk in the frame", async () => {
    const dir = freshDir("private");
    const identity = await loadOrCreateIdentity(dir);
    const result = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(result.ok).toBe(true);
    const answer = parseNodeSshIdentity(result.ok ? result.data : null);
    if (!answer) throw new Error("identity answer did not validate");
    const jwk = JSON.parse(answer.signingPublicKey) as Record<string, unknown>;
    expect("d" in jwk).toBe(false);
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    // The whole wire frame, serialized, must not carry the stored private JWK.
    expect(JSON.stringify(result)).not.toContain(identity.signingPrivateJwk);
  });

  it("ignores the ssh-enabled gate: an un-mirrored (fail-closed OFF) machine still registers", async () => {
    // Deliberately NO ssh-enabled.json here: the mirror is absent, which the
    // gate reads as OFF. Registration precedes the gate; a node that never
    // turned SSH on must still be able to file its identity (§4.3).
    const dir = freshDir("gate-off");
    expect(readdirSync(dir).length).toBe(0);
    const result = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(result.ok).toBe(true);
    // The pair the loader minted on this ask is exactly what the answer names.
    const identity = await loadOrCreateIdentity(dir);
    const parsed = parseNodeSshIdentity(result.ok ? result.data : null);
    expect(parsed?.signingPublicKey).toBe(identity.signingPublicJwk);
  });

  it("a corrupt signing file fails closed: quarantine throw surfaces as ok:false", async () => {
    const dir = freshDir("corrupt");
    writeFileSync(signingIdentityPath(dir), "not a keypair", { mode: 0o600 });
    // The handler may create the encryption pair, but the signing pair's
    // quarantine throw must reach dispatch's whole-switch wrap as a refusal.
    const result = await dispatchCommand(makeCtx(dir), { type: "ssh_register_identity" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("refusing to overwrite existing key material");
    // The corrupt file was moved aside, not answered over.
    const quarantined = readdirSync(dir).filter((f) => f.includes("corrupt-"));
    expect(quarantined.length).toBe(1);
    expect(readdirSync(dir)).not.toContain("node-signing-identity.json");
  });
});

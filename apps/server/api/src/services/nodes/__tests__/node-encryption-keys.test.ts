import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { ensureSodium } from "@internal/subshell-protocol/node-link-crypto";
import { IS_TEST, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import {
  loadNodeEncryptionKeys,
  nodeEncryptionPublicKeysJson,
  resetNodeEncryptionKeysForTests,
} from "../node-encryption-keys.js";

/** Where the store persists; mirrors the module-internal KEY_PATH. */
const KEY_PATH = `${SUBSHELL_SERVER_DATA_DIR}/node-encryption.json`;

/** Decode a stored base64 half and assert its byte length (32 = an X25519 key). */
async function decodedLength(value: string): Promise<number> {
  const sodium = await ensureSodium();
  return sodium.from_base64(value).length;
}

describe("node-link encryption keypair store (spec 2026-09-24 §3)", () => {
  beforeAll(() => {
    if (!IS_TEST) throw new Error("test-only: SUBSHELL_SERVER_DATA_DIR must be the per-process temp dir");
  });

  beforeEach(() => {
    rmSync(KEY_PATH, { force: true });
    resetNodeEncryptionKeysForTests();
  });

  it("generates once, persists at 0600, and reuses the same keypair", async () => {
    const a = await loadNodeEncryptionKeys();
    const b = await loadNodeEncryptionKeys();
    expect(a).toEqual(b);

    expect(await decodedLength(a.publicKey)).toBe(32);
    expect(await decodedLength(a.privateKey)).toBe(32);
    expect(a.publicKey).not.toBe(a.privateKey);

    expect(statSync(KEY_PATH).mode & 0o077).toBe(0); // owner read/write only
  });

  it("corrupt file fails closed (never silently regenerates)", async () => {
    const original = await loadNodeEncryptionKeys(); // create

    writeFileSync(KEY_PATH, "garbage");
    resetNodeEncryptionKeysForTests();
    await expect(loadNodeEncryptionKeys()).rejects.toThrow(/node-encryption/);
    // fail closed means the garbage is still there — not replaced by a fresh pair
    expect((await Bun.file(KEY_PATH).text()).trim()).toBe("garbage");
    expect(await decodedLength(original.publicKey)).toBe(32); // a real key was minted before the corruption
  });

  it("valid JSON with the wrong shape fails closed, and a deleted file regenerates", async () => {
    writeFileSync(KEY_PATH, JSON.stringify({ nope: true }));
    resetNodeEncryptionKeysForTests();
    await expect(loadNodeEncryptionKeys()).rejects.toThrow(/node-encryption/);

    // halves present but not 32-byte base64 — the kx gate is about the bytes
    writeFileSync(KEY_PATH, JSON.stringify({ publicKey: "c2hvcnQ=", privateKey: "c2hvcnQ=" }));
    resetNodeEncryptionKeysForTests();
    await expect(loadNodeEncryptionKeys()).rejects.toThrow(/unexpected shape/);

    // non-canonical base64 must refuse, not throw from the gate
    writeFileSync(KEY_PATH, JSON.stringify({ publicKey: "!!!", privateKey: "!!!" }));
    resetNodeEncryptionKeysForTests();
    await expect(loadNodeEncryptionKeys()).rejects.toThrow(/unexpected shape/);

    // restore: with the file gone, the next load mints a fresh pair (suite-order safe)
    rmSync(KEY_PATH, { force: true });
    resetNodeEncryptionKeysForTests();
    const fresh = await loadNodeEncryptionKeys();
    expect(await decodedLength(fresh.privateKey)).toBe(32);
  });

  it("a missing file after reset mints a NEW keypair (no stale cache)", async () => {
    const first = await loadNodeEncryptionKeys();
    rmSync(KEY_PATH, { force: true });
    resetNodeEncryptionKeysForTests();
    const second = await loadNodeEncryptionKeys();
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(statSync(KEY_PATH).mode & 0o077).toBe(0);
  });

  it("publicKeysJson answers the stored public half, as base64 (not a JWK)", async () => {
    const keys = await loadNodeEncryptionKeys();
    const json = await nodeEncryptionPublicKeysJson();
    expect(json).toBe(keys.publicKey);
    // it is the base64 string itself, not a JSON document around it: a real
    // JSON object would parse, raw base64 is not even parseable
    expect(json.startsWith("{")).toBe(false);
    expect(() => JSON.parse(json)).toThrow();
    expect(await decodedLength(json)).toBe(32);
  });
});

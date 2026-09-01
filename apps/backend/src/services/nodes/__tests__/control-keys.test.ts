import { beforeAll, describe, expect, it } from "bun:test";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { IS_TEST, SESSION_DATA_DIR } from "@/constants.js";
import { controlPublicJwkJson, loadControlKeys, resetControlKeysForTests } from "../control-keys.js";

/** Where the store persists; mirrors the module-internal KEY_PATH. */
const KEY_PATH = `${SESSION_DATA_DIR}/node-signing.json`;

describe("control keys store (spec 2026-08-31 §4)", () => {
  beforeAll(() => {
    if (!IS_TEST) throw new Error("test-only: SESSION_DATA_DIR must be the per-process temp dir");
  });

  it("generates once, persists at 0600, and reuses the same keypair", async () => {
    rmSync(KEY_PATH, { force: true });
    resetControlKeysForTests();

    const a = await loadControlKeys();
    const b = await loadControlKeys();
    expect(a.publicJwk).toEqual(b.publicJwk);

    expect(a.privateJwk.kty).toBe("EC");
    expect(typeof a.privateJwk.d).toBe("string");
    expect(a.publicJwk.d).toBeUndefined(); // public half never leaks d

    expect(statSync(KEY_PATH).mode & 0o077).toBe(0); // owner read/write only

    const json = await controlPublicJwkJson();
    const parsed = JSON.parse(json) as { kty?: string; d?: string };
    expect(parsed.kty).toBe("EC");
    expect(parsed.d).toBeUndefined();
  });

  it("corrupt file fails closed (never silently regenerates)", async () => {
    rmSync(KEY_PATH, { force: true });
    resetControlKeysForTests();
    const original = await loadControlKeys(); // create

    writeFileSync(KEY_PATH, "garbage");
    resetControlKeysForTests();
    await expect(loadControlKeys()).rejects.toThrow(/node-signing/);
    // fail closed means the garbage is still there — not replaced by a fresh pair
    expect((await Bun.file(KEY_PATH).text()).trim()).toBe("garbage");
    expect(original.publicJwk.kty).toBe("EC");
  });

  it("valid JSON with the wrong shape also fails closed, and a deleted file regenerates", async () => {
    writeFileSync(KEY_PATH, JSON.stringify({ nope: true }));
    resetControlKeysForTests();
    await expect(loadControlKeys()).rejects.toThrow(/node-signing/);

    // restore: with the file gone, the next load mints a fresh pair (suite-order safe)
    rmSync(KEY_PATH, { force: true });
    resetControlKeysForTests();
    const fresh = await loadControlKeys();
    expect(typeof fresh.privateJwk.d).toBe("string");
  });

  it("a missing file after reset mints a NEW keypair (no stale cache)", async () => {
    const first = await loadControlKeys();
    rmSync(KEY_PATH, { force: true });
    resetControlKeysForTests();
    const second = await loadControlKeys();
    expect(second.publicJwk).not.toEqual(first.publicJwk);
    expect(statSync(KEY_PATH).mode & 0o077).toBe(0);
  });
});

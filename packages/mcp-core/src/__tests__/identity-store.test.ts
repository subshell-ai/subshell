import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../identity-store.js";

/** The local process persists its keypair so identity survives restarts. */
describe("identity-store", () => {
  it("creates then reloads the same keypair for a principal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mote-identity-"));
    const first = await loadOrCreateIdentity(dir, "sess:abc-123");
    expect(first.publicJwk).toBeTruthy();
    const second = await loadOrCreateIdentity(dir, "sess:abc-123");
    expect(second.privateJwk).toBe(first.privateJwk);
    expect(second.publicJwk).toBe(first.publicJwk);
  });

  it("stores the file mode 0600 under identities/<safe-id>.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mote-identity-"));
    await loadOrCreateIdentity(dir, "sess:xyz");
    const file = join(dir, "identities", "sess-xyz.json"); // ':' sanitized for the filesystem
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { principalId: string };
    expect(raw.principalId).toBe("sess:xyz");
  });

  it("refuses to reuse a file stamped for a different principal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mote-identity-"));
    mkdirSync(join(dir, "identities"), { recursive: true });
    writeFileSync(
      join(dir, "identities", "sess-two.json"),
      JSON.stringify({ principalId: "sess:OTHER", publicJwk: "{}", privateJwk: "{}" }),
    );
    await expect(loadOrCreateIdentity(dir, "sess:two")).rejects.toThrow(/principal/i);
  });

  it("fail-closed on a corrupt (unreadable) identity file: throws, never clobbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mote-identity-"));
    mkdirSync(join(dir, "identities"), { recursive: true });
    const file = join(dir, "identities", "sess-bad.json");
    writeFileSync(file, "{ not json");
    // Must name the file path so the operator can recover the quarantined key.
    await expect(loadOrCreateIdentity(dir, "sess:bad")).rejects.toThrow(file);
    // The garbage is preserved aside (key material is never silently rotated)…
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.corrupt-parse`, "utf8")).toBe("{ not json");
    // …and no fresh keypair was written at the identity path.
  });

  it("fail-closed on a present-but-non-object JSON file (e.g. `null`)", async () => {
    // M-3 (final review): `null` is valid JSON, so it passed the parse
    // try/catch and died on `stored.principalId` with a bare TypeError. It is
    // corruption of a PRESENT file: same quarantine path, actionable message,
    // and never an overwrite.
    const dir = mkdtempSync(join(tmpdir(), "mote-identity-"));
    mkdirSync(join(dir, "identities"), { recursive: true });
    const file = join(dir, "identities", "sess-null.json");
    writeFileSync(file, "null");
    await expect(loadOrCreateIdentity(dir, "sess:null")).rejects.toThrow(/unreadable \(parse\)/);
    expect(existsSync(file)).toBe(false); // quarantined…
    expect(readFileSync(`${file}.corrupt-parse`, "utf8")).toBe("null"); // …verbatim…
    expect(existsSync(file)).toBe(false); // …and no fresh key written over it
  });

  it("still generates a fresh keypair on ENOENT (no file at all)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mote-identity-"));
    const fresh = await loadOrCreateIdentity(dir, "sess-missing");
    expect(JSON.parse(fresh.publicJwk).kty).toBe("EC");
  });
});

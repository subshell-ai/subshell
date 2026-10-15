import { describe, expect, spyOn, test } from "bun:test";
import { readEnvelope } from "../ssh-browser-signer/envelope";
import { base64, concat, decode64, field, Reader, u32 } from "../ssh-browser-signer/wire";
import { createBrowserSshSigner, inspectBrowserSshKey } from "../ssh-browser-signer-core";
import { browserSignerFixtures } from "./ssh-browser-signer-test-context";

const { host, fixture, create } = browserSignerFixtures();

function rewrittenEnvelope(
  name: string,
  changes: {
    cipher?: string;
    kdf?: string;
    options?: Uint8Array;
    publicKey?: Uint8Array;
    privateBlock?: Uint8Array;
    count?: number;
    trailing?: Uint8Array;
  },
) {
  const envelope = readEnvelope(fixture(name).bytes);
  const encrypted = name.endsWith("-encrypted");
  const out = concat(
    new TextEncoder().encode("openssh-key-v1\0"),
    field(changes.cipher ?? (encrypted ? "aes256-ctr" : "none")),
    field(changes.kdf ?? (encrypted ? "bcrypt" : "none")),
    field(changes.options ?? (encrypted ? concat(field(envelope.salt), u32(envelope.rounds)) : new Uint8Array())),
    u32(changes.count ?? 1),
    field(changes.publicKey ?? envelope.publicKey),
    field(changes.privateBlock ?? envelope.privateBlock),
    changes.trailing ?? new Uint8Array(),
  );
  envelope.buffer.fill(0);
  const encoded = new TextEncoder().encode(
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64(out)}\n-----END OPENSSH PRIVATE KEY-----\n`,
  );
  out.fill(0);
  return encoded;
}

describe("key parsing and secret cleanup", () => {
  test("wrong or missing passphrases fail with fixed errors and scrub inputs", async () => {
    const bytes = fixture("ed25519-encrypted").bytes.slice();
    const passphrase = new TextEncoder().encode("wrong secret which must not appear in errors");
    await expect(create("ed25519-encrypted", { bytes, passphrase })).rejects.toThrow("passphrase");
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(passphrase.every((byte) => byte === 0)).toBe(true);
    await expect(
      createBrowserSshSigner({
        user: "alice",
        hostKey: host.encoded,
        expiresAt: Date.now() + 89_000,
        bytes: fixture("ed25519-encrypted").bytes.slice(),
      }),
    ).rejects.toThrow("passphrase");
  });

  test("plaintext input buffers are scrubbed on success and invalid scope", async () => {
    const bytes = fixture().bytes.slice();
    const signer = await create("ed25519", { bytes });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    signer.close();
    for (const expiresAt of [Date.now() - 1, Date.now() + 91_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = fixture().bytes.slice();
      await expect(create("ed25519", { bytes: invalid, expiresAt })).rejects.toThrow("expired");
      expect(invalid.every((byte) => byte === 0)).toBe(true);
    }
  });

  test("key import that crosses the deadline is discarded and scrubbed", async () => {
    const bytes = fixture().bytes.slice();
    const initial = Date.now();
    let reads = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => initial + (reads++ ? 90_000 : 0));
    try {
      await expect(create("ed25519", { bytes, expiresAt: initial + 89_000 })).rejects.toThrow("expired");
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  test("limits, legacy formats, unsupported encryption and KDF work are rejected before decryption", async () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(65_537),
      new TextEncoder().encode("-----BEGIN RSA PRIVATE KEY-----\n"),
      new TextEncoder().encode("not an SSH key"),
    ]) {
      expect(() => inspectBrowserSshKey(bytes)).toThrow();
    }
    for (const changes of [
      { cipher: "aes256-cbc" },
      { kdf: "unknown" },
      { count: 2 },
      { trailing: new Uint8Array([0]) },
      { options: concat(field(new Uint8Array(16)), u32(1025)) },
      { options: concat(field(new Uint8Array(16)), u32(0)) },
      { options: concat(field(new Uint8Array(65)), u32(1)) },
    ])
      expect(() => inspectBrowserSshKey(rewrittenEnvelope("ed25519-encrypted", changes))).toThrow();
    await expect(create("rsa-small")).rejects.toThrow("2,048");
    const tooLargeModulus = new Uint8Array(1025).fill(255);
    await expect(
      create("ed25519", {
        bytes: rewrittenEnvelope("ed25519", {
          publicKey: concat(
            field("ssh-rsa"),
            field(new Uint8Array([1, 0, 1])),
            field(concat(new Uint8Array([0]), tooLargeModulus)),
          ),
        }),
      }),
    ).rejects.toThrow();
    await expect(
      create("ed25519", { bytes: rewrittenEnvelope("ed25519", { publicKey: concat(field("ssh-dss")) }) }),
    ).rejects.toThrow("DSA");
    await expect(
      create("ed25519", { bytes: rewrittenEnvelope("ed25519", { publicKey: field("sk-ssh-ed25519@openssh.com") }) }),
    ).rejects.toThrow("Hardware");
  });

  test("checksums, padding, private components and public identities must agree", async () => {
    const envelope = readEnvelope(fixture().bytes);
    const original = envelope.privateBlock.slice();
    envelope.buffer.fill(0);
    const check = original.slice();
    check[0] ^= 1;
    const padding = original.slice();
    padding[padding.length - 1] = 0;
    const seed = original.slice();
    const reader = new Reader(seed);
    reader.u32();
    reader.u32();
    reader.string();
    reader.string();
    reader.string()[0] ^= 1;
    for (const block of [check, padding, seed]) {
      await expect(
        create("ed25519", { bytes: rewrittenEnvelope("ed25519", { privateBlock: block }) }),
      ).rejects.toThrow();
    }
    await expect(
      create("ed25519", { bytes: rewrittenEnvelope("ed25519", { publicKey: decode64(fixture("p256").publicKey) }) }),
    ).rejects.toThrow("don't match");
    original.fill(0);
    check.fill(0);
    padding.fill(0);
    seed.fill(0);
  });

  test("ECDSA scalars and RSA factors must match the advertised public key", async () => {
    for (const name of ["p256", "rsa"]) {
      const envelope = readEnvelope(fixture(name).bytes);
      const block = envelope.privateBlock.slice();
      envelope.buffer.fill(0);
      const reader = new Reader(block);
      reader.u32();
      reader.u32();
      reader.string();
      if (name === "p256") {
        reader.string();
        reader.string();
      } else {
        // n, e, d and iqmp precede the first RSA factor.
        reader.string();
        reader.string();
        reader.string();
        reader.string();
      }
      const component = reader.string();
      component[component.length - 1] ^= 2;
      await expect(create(name, { bytes: rewrittenEnvelope(name, { privateBlock: block }) })).rejects.toThrow();
      block.fill(0);
    }
  });
});

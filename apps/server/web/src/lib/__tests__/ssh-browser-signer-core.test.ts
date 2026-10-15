import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { base64, concat, decode64, field, Reader } from "../ssh-browser-signer/wire";
import { browserHostFingerprint, inspectBrowserSshKey } from "../ssh-browser-signer-core";
import {
  authData,
  bindingPacket,
  generateFixture,
  hostFixture,
  PASSWORD,
  signingPacket,
  verifyResponse,
} from "./ssh-browser-signer-fixtures";
import { browserSignerFixtures, variants } from "./ssh-browser-signer-test-context";

const { host, fixture, create, directory } = browserSignerFixtures();

describe("OpenSSH browser imports and independent signature verification", () => {
  for (const [name] of variants) {
    for (const encrypted of [false, true]) {
      const variant = `${name}${encrypted ? "-encrypted" : ""}`;
      test(`${variant}: inspect, import, bind, sign and consume`, async () => {
        expect(inspectBrowserSshKey(fixture(variant).bytes)).toEqual({ encrypted });
        const signer = await create(variant);
        expect(signer.publicKey).toBe(fixture(variant).publicKey);
        const identities = new Reader(decode64((await signer.request("Cw==")).response));
        expect(identities.byte()).toBe(12);
        expect(identities.u32()).toBe(1);
        expect(base64(identities.string())).toBe(signer.publicKey);
        identities.string();
        identities.end();
        expect(await signer.request(base64(bindingPacket(host)))).toEqual({ response: "Bg==", done: false });
        const algorithm = name === "rsa" ? "rsa-sha2-256" : undefined;
        const data = authData(signer.publicKey, host, { algorithm });
        const packet = base64(signingPacket(signer.publicKey, data, name === "rsa" ? 2 : 0));
        const reply = await signer.request(packet);
        expect(reply.done).toBe(true);
        expect(verifyResponse(signer.publicKey, data, reply.response)).toBe(true);
        expect(await signer.request(packet)).toEqual({ response: "BQ==", done: true });
      });
    }
  }

  test("RSA SHA-512 works and SHA-1 or mismatched flags fail", async () => {
    const signer = await create("rsa");
    await signer.request(base64(bindingPacket(host)));
    for (const [algorithm, flags] of [
      ["ssh-rsa", 0],
      ["rsa-sha2-512", 2],
      ["rsa-sha2-256", 4],
    ]) {
      const data = authData(signer.publicKey, host, { algorithm: String(algorithm) });
      expect(await signer.request(base64(signingPacket(signer.publicKey, data, Number(flags))))).toEqual({
        response: "BQ==",
        done: false,
      });
    }
    const data = authData(signer.publicKey, host, { algorithm: "rsa-sha2-512" });
    const reply = await signer.request(base64(signingPacket(signer.publicKey, data, 4)));
    expect(verifyResponse(signer.publicKey, data, reply.response)).toBe(true);
  });

  test("RSA and every ECDSA curve can prove the approved host", async () => {
    for (const [kind, curve] of [
      ["rsa", undefined],
      ["ec", "prime256v1"],
      ["ec", "secp384r1"],
      ["ec", "secp521r1"],
    ] as const) {
      const otherHost = hostFixture(kind, curve);
      const signer = await create("ed25519", { hostKey: otherHost.encoded });
      expect(await signer.request(base64(bindingPacket(otherHost)))).toEqual({ response: "Bg==", done: false });
      const data = authData(signer.publicKey, otherHost);
      const reply = await signer.request(base64(signingPacket(signer.publicKey, data)));
      expect(verifyResponse(signer.publicKey, data, reply.response)).toBe(true);
    }
  });

  test("AES-128 and AES-192 encrypted files interoperate with ssh-keygen", async () => {
    for (const cipher of ["aes128-ctr", "aes192-ctr"]) {
      const item = generateFixture(directory(), cipher, "ed25519", undefined, true, cipher);
      const signer = await create("ed25519", { bytes: item.bytes, passphrase: new TextEncoder().encode(PASSWORD) });
      expect(signer.publicKey).toBe(item.publicKey);
      signer.close();
    }
  });

  test("the default ssh-keygen encrypted format and bcrypt rounds are supported", async () => {
    const item = generateFixture(directory(), "default-encryption", "ed25519", undefined, true, undefined, null);
    const signer = await create("ed25519", { bytes: item.bytes, passphrase: new TextEncoder().encode(PASSWORD) });
    expect(signer.publicKey).toBe(item.publicKey);
    await signer.request(base64(bindingPacket(host)));
    const data = authData(signer.publicKey, host);
    expect(
      verifyResponse(
        signer.publicKey,
        data,
        (await signer.request(base64(signingPacket(signer.publicKey, data)))).response,
      ),
    ).toBe(true);
  });

  test("fingerprints match OpenSSH SHA-256 and invalid or trailing host blobs fail", async () => {
    expect(await browserHostFingerprint(host.encoded)).toBe(
      `SHA256:${createHash("sha256").update(host.blob).digest("base64").replace(/=+$/, "")}`,
    );
    await expect(browserHostFingerprint(base64(concat(host.blob, new Uint8Array([0]))))).rejects.toThrow("host key");
    await expect(browserHostFingerprint(`${host.encoded}\n`)).rejects.toThrow("host key");
  });
});

describe("authorization and lifecycle", () => {
  test("forged, wrong-host, forwarded, malformed and trailing bindings don't arm the signer", async () => {
    const signer = await create();
    const forged = bindingPacket(host);
    forged[forged.length - 2] ^= 1;
    for (const packet of [
      forged,
      bindingPacket(hostFixture()),
      bindingPacket(host, { forwarding: 1 }),
      concat(bindingPacket(host), new Uint8Array([0])),
      bindingPacket(host, { session: new Uint8Array(15) }),
      bindingPacket(host, { session: new Uint8Array(129) }),
      bindingPacket(host, { signature: concat(field("ssh-ed25519"), field(new Uint8Array(64)), new Uint8Array([0])) }),
    ]) {
      expect(await signer.request(base64(packet))).toEqual({ response: "BQ==", done: false });
    }
    const data = authData(signer.publicKey, host);
    expect(await signer.request(base64(signingPacket(signer.publicKey, data)))).toEqual({
      response: "BQ==",
      done: false,
    });
    expect(await signer.request(base64(bindingPacket(host)))).toEqual({ response: "Bg==", done: false });
    expect(await signer.request(base64(bindingPacket(host, { session: new Uint8Array(32).fill(2) })))).toEqual({
      response: "BQ==",
      done: false,
    });
    signer.close();
  });

  test("only exact host-bound public-key userauth is accepted", async () => {
    const signer = await create();
    await signer.request(base64(bindingPacket(host)));
    const data = authData(signer.publicKey, host);
    for (const bad of [
      authData(signer.publicKey, host, { user: "bob" }),
      authData(signer.publicKey, host, { session: new Uint8Array(32) }),
      authData(signer.publicKey, host, { method: "publickey" }),
      authData(signer.publicKey, host, { service: "other" }),
      authData(signer.publicKey, host, { boolean: 0 }),
      authData(signer.publicKey, host, { algorithm: "ssh-rsa" }),
      authData(signer.publicKey, host, { publicKey: fixture("p256").publicKey }),
      authData(signer.publicKey, host, { hostKey: hostFixture().blob }),
      concat(data, new Uint8Array([0])),
      new TextEncoder().encode("arbitrary unbound challenge"),
    ])
      expect(await signer.request(base64(signingPacket(signer.publicKey, bad)))).toEqual({
        response: "BQ==",
        done: false,
      });
    for (const packet of [
      signingPacket(fixture("p256").publicKey, data),
      signingPacket(signer.publicKey, data, 2),
      concat(signingPacket(signer.publicKey, data), new Uint8Array([0])),
    ]) {
      expect(await signer.request(base64(packet))).toEqual({ response: "BQ==", done: false });
    }
    const reply = await signer.request(base64(signingPacket(signer.publicKey, data)));
    expect(verifyResponse(signer.publicKey, data, reply.response)).toBe(true);
  });

  test("unknown commands and noncanonical, oversized or malformed packets are denied", async () => {
    const signer = await create();
    for (const payload of [
      "",
      "!!!",
      "Cx==",
      "Cw",
      "Cw==\n",
      base64(new Uint8Array(65_537)),
      base64(new Uint8Array([13, 255, 255, 255, 255])),
      "Ew==",
      "CwA=",
      "Gw==",
      "DQ==",
    ]) {
      expect(await signer.request(payload)).toEqual({ response: "BQ==", done: false });
    }
    signer.close();
    expect(await signer.request("Cw==")).toEqual({ response: "BQ==", done: true });
  });

  test("concurrent binding requests can't overwrite an approved session", async () => {
    const signer = await create();
    const replies = await Promise.all([
      signer.request(base64(bindingPacket(host))),
      signer.request(base64(bindingPacket(host, { session: new Uint8Array(32).fill(7) }))),
    ]);
    expect(replies.filter((reply) => reply.response === "Bg==").length).toBe(1);
    const data = authData(signer.publicKey, host);
    expect(
      verifyResponse(
        signer.publicKey,
        data,
        (await signer.request(base64(signingPacket(signer.publicKey, data)))).response,
      ),
    ).toBe(true);
  });

  test("concurrent signing has exactly one winner", async () => {
    const signer = await create();
    await signer.request(base64(bindingPacket(host)));
    const data = authData(signer.publicKey, host);
    const packet = base64(signingPacket(signer.publicKey, data));
    const replies = await Promise.all(Array.from({ length: 8 }, () => signer.request(packet)));
    expect(replies.filter((reply) => reply.response !== "BQ==").length).toBe(1);
    expect(replies.every((reply) => reply.done)).toBe(true);
  });

  test("close during crypto discards the pending signature", async () => {
    const signer = await create();
    await signer.request(base64(bindingPacket(host)));
    const data = authData(signer.publicKey, host);
    const pending = signer.request(base64(signingPacket(signer.publicKey, data)));
    signer.close();
    expect(await pending).toEqual({ response: "BQ==", done: true });
  });

  test("failed signing still consumes the private key and returns only agent failure", async () => {
    const signer = await create();
    await signer.request(base64(bindingPacket(host)));
    const data = authData(signer.publicKey, host);
    const packet = base64(signingPacket(signer.publicKey, data));
    const failure = spyOn(crypto.subtle, "sign").mockRejectedValueOnce(new Error("private engine diagnostic"));
    try {
      expect(await signer.request(packet)).toEqual({ response: "BQ==", done: true });
      expect(await signer.request(packet)).toEqual({ response: "BQ==", done: true });
    } finally {
      failure.mockRestore();
    }
  });

  test("binding verification that crosses the deadline is discarded", async () => {
    const signer = await create();
    const pending = signer.request(base64(bindingPacket(host)));
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);
    try {
      expect(await pending).toEqual({ response: "BQ==", done: true });
    } finally {
      clock.mockRestore();
    }
  });

  test("expiration is enforced before and after crypto, even if the wall clock moves backward", async () => {
    const signer = await create();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);
    try {
      expect(await signer.request("Cw==")).toEqual({ response: "BQ==", done: true });
    } finally {
      clock.mockRestore();
    }
    const other = await create();
    await other.request(base64(bindingPacket(host)));
    const data = authData(other.publicKey, host);
    const pending = other.request(base64(signingPacket(other.publicKey, data)));
    const later = spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);
    try {
      expect(await pending).toEqual({ response: "BQ==", done: true });
    } finally {
      later.mockRestore();
    }
    const bounded = await create();
    const monotonic = spyOn(performance, "now").mockReturnValue(performance.now() + 90_000);
    const backward = spyOn(Date, "now").mockReturnValue(Date.now() - 90_000);
    try {
      expect(await bounded.request("Cw==")).toEqual({ response: "BQ==", done: true });
    } finally {
      monotonic.mockRestore();
      backward.mockRestore();
    }
  });
});

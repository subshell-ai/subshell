import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { exportJWK, flattenedDecrypt, GeneralEncrypt, generateKeyPair, importJWK, SignJWT } from "jose";
import { BASE64_RE } from "../guards.js";
import { SSH_RELAY_FRAME_MAX_BYTES } from "../ssh-limits.js";
import { base64UrlNoPad, base64UrlToBytes } from "../ssh-pin-store.js";
import {
  bindNonces,
  canonicalizeRelayMessage,
  newNonce,
  openRelayEnvelope,
  RELAY_SIG_ISSUER,
  type RelayInnerMessage,
  type RelayOwnIdentity,
  type RelaySealFn,
  type SealRelayEnvelopeInput,
  SeqGate,
  sealRelayEnvelope,
  signRelayEnvelope,
  verifyRelayEnvelope,
} from "../ssh-relay.js";

/**
 * The relay envelope codec (spec 2026-10-08 §5.6): canonicalization binds the
 * fields, the ES256 signature carries origin, the seal carries confidentiality,
 * and the SeqGate carries anti-replay. The seal/open pair is INJECTED (the
 * production one is `packages/mcp-core/src/crypto.ts`; this package must not
 * import it, or the workspace cycle would break the build order and Metro).
 * The doubles below mirror crypto.ts's jose recipe verbatim so the codec is
 * exercised against the real wire shape: GeneralEncrypt ECDH-ES+A256KW /
 * A256GCM with a plaintext recipient `kid`, and the flattened-slot open.
 */

/* ---------------------------- key material ---------------------------- */

async function es256Jwks(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    privateJwk: (await exportJWK(privateKey)) as unknown as JsonWebKey,
    publicJwk: (await exportJWK(publicKey)) as unknown as JsonWebKey,
  };
}

async function ecdhStrings(): Promise<{ publicJwk: string; privateJwk: string }> {
  // Same recipe as mcp-core's generateKeypair: P-256 ECDH-ES, JWK JSON strings.
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  return {
    publicJwk: JSON.stringify(await exportJWK(publicKey)),
    privateJwk: JSON.stringify(await exportJWK(privateKey)),
  };
}

/* ------------------------- seal/open doubles -------------------------- */

const sealImpl: RelaySealFn = async (text, recipients) => {
  if (recipients.length === 0) throw new Error("seal requires at least one recipient");
  const ge = new GeneralEncrypt(new TextEncoder().encode(text));
  ge.setProtectedHeader({ alg: "ECDH-ES+A256KW", enc: "A256GCM" });
  for (const r of recipients) {
    ge.addRecipient(await importJWK(JSON.parse(r.publicJwk), "ECDH-ES")).setUnprotectedHeader({ kid: r.principalId });
  }
  const envelope = await ge.encrypt();
  return { envelope: JSON.stringify(envelope), recipientIds: recipients.map((r) => r.principalId) };
};

const openImpl = async (envelope: string, own: RelayOwnIdentity): Promise<string> => {
  const env = JSON.parse(envelope) as {
    protected?: string;
    iv: string;
    ciphertext: string;
    tag: string;
    recipients: { header?: { kid?: string }; encrypted_key: string }[];
  };
  const mine = (env.recipients ?? []).find((r) => r.header?.kid === own.principalId);
  if (!mine) throw new Error(`envelope has no recipient slot for principal: ${own.principalId}`);
  const { plaintext } = await flattenedDecrypt(
    {
      protected: env.protected,
      header: mine.header,
      encrypted_key: mine.encrypted_key,
      iv: env.iv,
      tag: env.tag,
      ciphertext: env.ciphertext,
    },
    await importJWK(JSON.parse(own.privateJwk), "ECDH-ES"),
  );
  return new TextDecoder().decode(plaintext);
};

/* ----------------------------- a message ------------------------------ */

const NB = base64UrlNoPad(Uint8Array.from({ length: 16 }, (_, i) => i));
const NA = base64UrlNoPad(Uint8Array.from({ length: 16 }, (_, i) => i + 16));
const AGENT = base64UrlNoPad(Uint8Array.from([0x00, 0x00, 0x00, 0x0d]));

function relayMessage(overrides: Partial<RelayInnerMessage> = {}): RelayInnerMessage {
  return {
    relaySessionId: "relay-7d21",
    routingRef: "rt-04a1",
    direction: "B2A",
    seq: 0,
    nB: NB,
    agentBytesB64: AGENT,
    ...overrides,
  };
}

/* ------------------------------ canonicalize -------------------------- */

describe("canonicalizeRelayMessage", () => {
  it("is insertion-order independent (same logical message, two field orders)", () => {
    const ordered = {
      agentBytesB64: AGENT,
      direction: "B2A",
      nA: NA,
      nB: NB,
      relaySessionId: "relay-7d21",
      routingRef: "rt-04a1",
      seq: 3,
    } satisfies RelayInnerMessage;
    const shuffled = {
      seq: 3,
      routingRef: "rt-04a1",
      nB: NB,
      relaySessionId: "relay-7d21",
      direction: "B2A",
      agentBytesB64: AGENT,
      nA: NA,
    } satisfies RelayInnerMessage;
    expect(canonicalizeRelayMessage(ordered)).toBe(canonicalizeRelayMessage(shuffled));
    // And the same again through a JSON round trip of the object itself.
    expect(canonicalizeRelayMessage(JSON.parse(JSON.stringify(shuffled)))).toBe(canonicalizeRelayMessage(ordered));
  });

  it("emits sorted-key JSON (the canonical spelling is fixed, not incidental)", () => {
    const s = canonicalizeRelayMessage(relayMessage({ nA: NA, seq: 42 }));
    expect(Object.keys(JSON.parse(s) as Record<string, unknown>)).toEqual([
      "agentBytesB64",
      "direction",
      "nA",
      "nB",
      "relaySessionId",
      "routingRef",
      "seq",
    ]);
    // Fixed number formatting: an integer spells as itself, no exponent form.
    expect(s).toContain('"seq":42');
  });

  it("is change-sensitive on EVERY bound field", () => {
    const base = canonicalizeRelayMessage(relayMessage());
    const variants: RelayInnerMessage[] = [
      relayMessage({ relaySessionId: "relay-7d22" }),
      relayMessage({ routingRef: "rt-04a2" }),
      relayMessage({ direction: "A2B" }),
      relayMessage({ seq: 1 }),
      relayMessage({ nB: NA }), // swapped nonce value
      relayMessage({ nA: NA }), // nonce added (was absent)
      relayMessage({ agentBytesB64: base64UrlNoPad(Uint8Array.from([0x00, 0x00, 0x00, 0x0b])) }),
      relayMessage({ agentBytesB64: "" }), // empty is its own message
    ];
    const strings = variants.map((v) => canonicalizeRelayMessage(v));
    for (const s of strings) expect(s).not.toBe(base);
    // Pairwise distinct too - two mutations never collide.
    const set = new Set([base, ...strings]);
    expect(set.size).toBe(strings.length + 1);
  });

  it("binds nonce PRESENCE: nB-only, both, and neither are three different strings", () => {
    const nBOnly = canonicalizeRelayMessage(relayMessage());
    const both = canonicalizeRelayMessage(relayMessage({ nA: NA }));
    const neither = canonicalizeRelayMessage(relayMessage({ nB: undefined }));
    expect(new Set([nBOnly, both, neither]).size).toBe(3);
    expect(Object.keys(JSON.parse(neither) as Record<string, unknown>)).not.toContain("nA");
  });

  it("refuses malformed messages rather than canonicalizing junk into a signature", () => {
    expect(() => canonicalizeRelayMessage(relayMessage({ direction: "C2D" as "B2A" }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ seq: 1.5 }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ seq: -1 }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ seq: Number.NaN }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ seq: 2 ** 53 }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ relaySessionId: "" }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ routingRef: "" }))).toThrow();
    // Standard-base64 spellings are NOT base64url: refused, not repaired.
    expect(() => canonicalizeRelayMessage(relayMessage({ agentBytesB64: "ab+cd/ef==" }))).toThrow();
    expect(() => canonicalizeRelayMessage(relayMessage({ nB: NB.slice(0, 21) }))).toThrow(); // 15.75 bytes
    expect(() => canonicalizeRelayMessage(relayMessage({ nA: `${NB}=` }))).toThrow(); // stray padding
  });
});

/* ------------------------------ bindNonces ---------------------------- */

describe("bindNonces", () => {
  it("passes the present nonces through and omits the absent", () => {
    expect(bindNonces()).toEqual({});
    expect(bindNonces(undefined, NB)).toEqual({ nB: NB });
    expect(bindNonces(NA, NB)).toEqual({ nA: NA, nB: NB });
  });
  it("refuses anything that is not a 128-bit base64url nonce", () => {
    expect(() => bindNonces("short")).toThrow(); // too short to be 16 bytes
    expect(() => bindNonces(`${NA}A`)).toThrow(); // 23 chars: no byte string is 16 and spells 23
    expect(() => bindNonces(undefined, `${NA.slice(0, 20)}+/`)).toThrow(); // standard-base64 chars
  });
});

/* -------------------------------- nonces ------------------------------ */

describe("newNonce", () => {
  it("mints distinct 128-bit base64url nonces", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const n = newNonce();
      expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(base64UrlToBytes(n)).toHaveLength(16);
      seen.add(n);
    }
    expect(seen.size).toBe(64);
  });
});

/* --------------------------- sign and verify -------------------------- */

describe("signRelayEnvelope / verifyRelayEnvelope", () => {
  it("a message signed by A verifies against A's pinned public key and yields the message back", async () => {
    const a = await es256Jwks();
    const m = relayMessage();
    const jws = await signRelayEnvelope({ privateJwk: a.privateJwk, message: m });
    expect(jws.split(".")).toHaveLength(3); // compact JWS
    const got = await verifyRelayEnvelope({
      jws,
      publicJwk: a.publicJwk,
      expect: { routingRef: m.routingRef, direction: m.direction, seq: m.seq },
    });
    expect(got).toEqual(m);
  });

  it("FAILS against a different pinned key (a swapped machine key is a refused origin)", async () => {
    const a = await es256Jwks();
    const b = await es256Jwks();
    const jws = await signRelayEnvelope({ privateJwk: a.privateJwk, message: relayMessage() });
    await expect(
      verifyRelayEnvelope({
        jws,
        publicJwk: b.publicJwk,
        expect: { routingRef: "rt-04a1", direction: "B2A", seq: 0 },
      }),
    ).rejects.toThrow();
  });

  it("flipping a bound field AFTER signing fails verify (signature covers the canonical string)", async () => {
    const a = await es256Jwks();
    const jws = await signRelayEnvelope({ privateJwk: a.privateJwk, message: relayMessage() });
    const [header, payload, signature] = jws.split(".");
    // Flip the last payload character to another alphabet character: the
    // segment still base64url-decodes, but the canonical string inside the
    // signed bytes changes, so the signature no longer covers the message.
    const last = payload[payload.length - 1];
    const tamperedPayload = `${payload.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    await expect(
      verifyRelayEnvelope({
        jws: tampered,
        publicJwk: a.publicJwk,
        expect: { routingRef: "rt-04a1", direction: "B2A", seq: 0 },
      }),
    ).rejects.toThrow();
    // And a wrapper claiming the UNtampered routing triple fails the bind:
    // verify must refuse a JWS whose canonical fields differ from the wrapper's.
    const m2 = relayMessage({ seq: 5 });
    const jws2 = await signRelayEnvelope({ privateJwk: a.privateJwk, message: m2 });
    await expect(
      verifyRelayEnvelope({
        jws: jws2,
        publicJwk: a.publicJwk,
        expect: { routingRef: "rt-04a1", direction: "B2A", seq: 0 },
      }),
    ).rejects.toThrow();
  });

  it("requires the relay issuer claim and the ES256 alg (header/claim swaps refused)", async () => {
    const a = await es256Jwks();
    const m = relayMessage();
    // A well-signed JWS WITHOUT our iss claim: right crypto, wrong document.
    const key = (await importJWK(
      { ...(a.privateJwk as object), kty: "EC", crv: "P-256" } as never,
      "ES256",
    )) as CryptoKey;
    const noIss = await new SignJWT({ msg: canonicalizeRelayMessage(m) })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .sign(key);
    await expect(
      verifyRelayEnvelope({
        jws: noIss,
        publicJwk: a.publicJwk,
        expect: { routingRef: m.routingRef, direction: m.direction, seq: m.seq },
      }),
    ).rejects.toThrow();
    // A valid EdDSA signature over the same claims, presented to the ES256 pin:
    // the alg allow-list refuses it before the key is even consulted.
    const ed = await generateKeyPair("EdDSA", { extractable: true });
    const edPrivate = ed.privateKey as unknown as CryptoKey;
    const swappedAlg = await new SignJWT({ iss: RELAY_SIG_ISSUER, msg: canonicalizeRelayMessage(m) })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .sign(edPrivate);
    await expect(
      verifyRelayEnvelope({
        jws: swappedAlg,
        publicJwk: a.publicJwk,
        expect: { routingRef: m.routingRef, direction: m.direction, seq: m.seq },
      }),
    ).rejects.toThrow();
  });

  it("refuses malformed JWS input without throwing anything uncatchable", async () => {
    const a = await es256Jwks();
    for (const junk of ["", "not.a.jws", "a.b.c", `${"x".repeat(8)}.${"y".repeat(8)}.${"z".repeat(8)}`]) {
      await expect(
        verifyRelayEnvelope({
          jws: junk,
          publicJwk: a.publicJwk,
          expect: { routingRef: "r", direction: "B2A", seq: 0 },
        }),
      ).rejects.toThrow();
    }
  });
});

/* -------------------------------- SeqGate ----------------------------- */

describe("SeqGate", () => {
  it("accepts 0,1,2 per direction and rejects an equal or lower seq", () => {
    const gate = new SeqGate();
    expect(gate.accept("B2A", 0)).toBe(true); // the first accepted value may be 0
    expect(gate.accept("B2A", 1)).toBe(true);
    expect(gate.accept("B2A", 2)).toBe(true);
    expect(gate.accept("B2A", 2)).toBe(false); // resend
    expect(gate.accept("B2A", 1)).toBe(false); // rewind
    expect(gate.accept("B2A", 0)).toBe(false);
  });

  it("gaps are legal (the gate is monotonic, not contiguous)", () => {
    const gate = new SeqGate();
    expect(gate.accept("A2B", 0)).toBe(true);
    expect(gate.accept("A2B", 7)).toBe(true);
    expect(gate.accept("A2B", 6)).toBe(false);
  });

  it("tracks the two directions independently", () => {
    const gate = new SeqGate();
    expect(gate.accept("B2A", 0)).toBe(true);
    expect(gate.accept("B2A", 1)).toBe(true);
    expect(gate.accept("A2B", 0)).toBe(true); // A2B starts fresh at 0 though B2A is at 1
    expect(gate.accept("A2B", 1)).toBe(true);
    expect(gate.accept("B2A", 0)).toBe(false); // B2A's own history still refuses
    expect(gate.accept("A2B", 2)).toBe(true);
  });

  it("rejects non-integers and negatives outright", () => {
    const gate = new SeqGate();
    expect(gate.accept("B2A", -1)).toBe(false);
    expect(gate.accept("B2A", 0.5)).toBe(false);
    expect(gate.accept("B2A", Number.NaN)).toBe(false);
    expect(gate.accept("B2A", Number.POSITIVE_INFINITY)).toBe(false);
    expect(gate.accept("B2A", 0)).toBe(true); // and the gate still works afterwards
  });
});

/* --------------------------- sealed envelope -------------------------- */

describe("sealRelayEnvelope / openRelayEnvelope", () => {
  it("round-trips: open yields the JWS + routing fields, and it verifies to the original message", async () => {
    const signer = await es256Jwks(); // B's signing key
    const recipient = await ecdhStrings(); // A's pinned encryption key
    const m = relayMessage({ nA: NA, seq: 2 }); // both nonces, a later message
    const blob = await sealRelayEnvelope({
      message: m,
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
      seal: sealImpl,
    });
    expect(blob).toMatch(BASE64_RE); // what RelayFrame.blob requires
    const opened = await openRelayEnvelope({
      blob,
      own: { principalId: "node:A", ...recipient },
      open: openImpl,
      expect: { ref: m.routingRef, direction: m.direction },
    });
    expect(opened.routingRef).toBe(m.routingRef);
    expect(opened.direction).toBe(m.direction);
    expect(opened.seq).toBe(m.seq);
    const got = await verifyRelayEnvelope({
      jws: opened.jws,
      publicJwk: signer.publicJwk,
      expect: { routingRef: opened.routingRef, direction: opened.direction, seq: opened.seq },
    });
    expect(got).toEqual(m);
  });

  it("opening with the WRONG recipient key throws (same label, foreign keypair)", async () => {
    const signer = await es256Jwks();
    const right = await ecdhStrings();
    const wrong = await ecdhStrings();
    const m = relayMessage();
    const blob = await sealRelayEnvelope({
      message: m,
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: right.publicJwk },
      seal: sealImpl,
    });
    await expect(
      openRelayEnvelope({
        blob,
        own: { principalId: "node:A", publicJwk: wrong.publicJwk, privateJwk: wrong.privateJwk },
        open: openImpl,
      }),
    ).rejects.toThrow();
  });

  it("opening under the WRONG principal label throws even with the right key (no slot)", async () => {
    const signer = await es256Jwks();
    const recipient = await ecdhStrings();
    const m = relayMessage();
    const blob = await sealRelayEnvelope({
      message: m,
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
      seal: sealImpl,
    });
    await expect(
      openRelayEnvelope({ blob, own: { principalId: "node:B", ...recipient }, open: openImpl }),
    ).rejects.toThrow();
  });

  it("a tampered sealed blob throws", async () => {
    const signer = await es256Jwks();
    const recipient = await ecdhStrings();
    const m = relayMessage();
    const blob = await sealRelayEnvelope({
      message: m,
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
      seal: sealImpl,
    });
    // Flip one alphabet character mid-blob (past the headers, inside the
    // ciphertext region): base64 stays valid, the AEAD tag check must refuse.
    const at = Math.floor(blob.length / 2);
    const c = blob[at] === "A" ? "B" : "A";
    const tampered = `${blob.slice(0, at)}${c}${blob.slice(at + 1)}`;
    await expect(
      openRelayEnvelope({ blob: tampered, own: { principalId: "node:A", ...recipient }, open: openImpl }),
    ).rejects.toThrow();
  });

  it("refuses a blob that is not base64, and base64 that is not an envelope", async () => {
    const recipient = await ecdhStrings();
    const own = { principalId: "node:A", ...recipient };
    await expect(openRelayEnvelope({ blob: "not base64!", own, open: openImpl })).rejects.toThrow();
    await expect(openRelayEnvelope({ blob: "", own, open: openImpl })).rejects.toThrow();
    await expect(openRelayEnvelope({ blob: base64OfText("hello"), own, open: openImpl })).rejects.toThrow();
  });

  it("the sender refuses an envelope over SSH_RELAY_FRAME_MAX_BYTES (cap is law, both directions)", async () => {
    const signer = await es256Jwks();
    const recipient = await ecdhStrings();
    const fat = relayMessage({ agentBytesB64: "A".repeat(SSH_RELAY_FRAME_MAX_BYTES) });
    await expect(
      sealRelayEnvelope({
        message: fat,
        privateJwk: signer.privateJwk,
        recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
        seal: sealImpl,
      }),
    ).rejects.toThrow(/cap|SSH_RELAY_FRAME_MAX_BYTES|too large|over/i);
  });

  it("open cross-checks the wrapper against the frame it rode (ref/direction swap refused)", async () => {
    const signer = await es256Jwks();
    const recipient = await ecdhStrings();
    const m = relayMessage();
    const blob = await sealRelayEnvelope({
      message: m,
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
      seal: sealImpl,
    });
    await expect(
      openRelayEnvelope({
        blob,
        own: { principalId: "node:A", ...recipient },
        open: openImpl,
        expect: { ref: "rt-EVIL", direction: "B2A" },
      }),
    ).rejects.toThrow();
    await expect(
      openRelayEnvelope({
        blob,
        own: { principalId: "node:A", ...recipient },
        open: openImpl,
        expect: { ref: m.routingRef, direction: "A2B" },
      }),
    ).rejects.toThrow();
  });

  it("the sealed wire blob carries no plaintext of the agent bytes or the JWS", async () => {
    const signer = await es256Jwks();
    const recipient = await ecdhStrings();
    const m = relayMessage();
    const blob = await sealRelayEnvelope({
      message: m,
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
      seal: sealImpl,
    });
    expect(blob).not.toContain(m.agentBytesB64);
    expect(atob(blob)).not.toContain("routingRef");
  });

  it("sealRelayEnvelope refuses a malformed message before any crypto runs", async () => {
    const signer = await es256Jwks();
    const recipient = await ecdhStrings();
    let sealCalls = 0;
    const input: SealRelayEnvelopeInput = {
      message: relayMessage({ seq: -1 }),
      privateJwk: signer.privateJwk,
      recipient: { principalId: "node:A", publicJwk: recipient.publicJwk },
      seal: async () => {
        sealCalls += 1;
        return { envelope: "", recipientIds: [] };
      },
    };
    await expect(sealRelayEnvelope(input)).rejects.toThrow(/non-negative safe integer/);
    expect(sealCalls).toBe(0);
  });
});

/* ------------------------------ Metro purity -------------------------- */

describe("ssh-relay.ts is Metro-safe", () => {
  it("has no node: builtin import in CODE", () => {
    // Same pin as ssh-pin-store.test.ts: comments carry "node:" as prose, so
    // the scanned text is the code with comments stripped.
    const source = readFileSync(new URL("../ssh-relay.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/import\s*\(?\s*["']node:/);
    expect(source).not.toMatch(/require\(\s*["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/await\s+import\(/);
  });
});

/** Standard base64 of text, for the junk-blob test (kept out of the codec). */
function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
  }
  return out;
}

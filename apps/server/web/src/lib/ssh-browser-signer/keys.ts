import { base64url, concat, equal, field, mpint, padded, positive, Reader, SignerError } from "./wire";

const CURVES = {
  nistp256: { name: "P-256", size: 32, hash: "SHA-256" },
  nistp384: { name: "P-384", size: 48, hash: "SHA-384" },
  nistp521: { name: "P-521", size: 66, hash: "SHA-512" },
} as const;

type Curve = (typeof CURVES)[keyof typeof CURVES];
type PublicParts =
  | { kind: "ed25519"; algorithm: string; raw: Uint8Array }
  | { kind: "rsa"; algorithm: string; n: Uint8Array; e: Uint8Array }
  | { kind: "ecdsa"; algorithm: string; raw: Uint8Array; curve: Curve };

/** Public identity and verifier for the approved host or selected private key. */
export interface PublicIdentity {
  /** Canonical SSH public key wire bytes. */
  blob: Uint8Array;
  /** Verify a complete, bounded SSH signature frame. */
  verify(data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/** Imported, nonextractable private key and its narrowly selected algorithms. */
export interface PrivateIdentity {
  /** The public identity advertised by the private file. */
  publicKey: Uint8Array;
  /** Whether the requested SSH algorithm and agent flags match this key. */
  accepts(algorithm: string, flags: number): boolean;
  /** Sign authorized host-bound data, returning a complete SSH signature. */
  sign(data: Uint8Array, algorithm: string): Promise<Uint8Array>;
}

function readPublic(blob: Uint8Array): PublicParts {
  const reader = new Reader(blob);
  const algorithm = reader.text();
  let parts: PublicParts;
  if (algorithm === "ssh-ed25519") {
    const raw = reader.string();
    if (raw.length !== 32) throw new SignerError("The Ed25519 public key isn't valid.");
    parts = { kind: "ed25519", algorithm, raw };
  } else if (algorithm === "ssh-rsa") {
    const e = positive(reader, 8);
    const n = positive(reader);
    const bits = n.length * 8 - Math.clz32(n[0]) + 24;
    if (bits < 2048 || bits > 8192 || integer(e) < 3n || (e[e.length - 1] & 1) === 0 || (n[n.length - 1] & 1) === 0) {
      throw new SignerError("Choose an RSA SSH key with 2,048 to 8,192 bits and a valid public exponent.");
    }
    parts = { kind: "rsa", algorithm, n, e };
  } else if (algorithm.startsWith("ecdsa-sha2-")) {
    const name = reader.text();
    const curve = CURVES[name as keyof typeof CURVES];
    const raw = reader.string();
    if (!curve || algorithm !== `ecdsa-sha2-${name}` || raw.length !== curve.size * 2 + 1 || raw[0] !== 4) {
      throw new SignerError("Choose an ECDSA SSH key using P-256, P-384, or P-521.");
    }
    parts = { kind: "ecdsa", algorithm, raw, curve };
  } else {
    throw new SignerError(
      "Choose an Ed25519, ECDSA, or RSA SSH key. Hardware-backed and DSA keys aren't supported here.",
    );
  }
  reader.end();
  return parts;
}

function rsaJwk(parts: Extract<PublicParts, { kind: "rsa" }>): JsonWebKey {
  return { kty: "RSA", n: base64url(parts.n), e: base64url(parts.e), ext: false };
}

function ecJwk(parts: Extract<PublicParts, { kind: "ecdsa" }>): JsonWebKey {
  return {
    kty: "EC",
    crv: parts.curve.name,
    x: base64url(parts.raw.subarray(1, 1 + parts.curve.size)),
    y: base64url(parts.raw.subarray(1 + parts.curve.size)),
    ext: false,
  };
}

function integer(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function integerBytes(value: bigint): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 255n));
    value >>= 8n;
  }
  const result = Uint8Array.from(bytes.reverse());
  bytes.fill(0);
  return result;
}

function ecdsaRaw(signature: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const reader = new Reader(signature);
  const r = positive(reader, size);
  const s = positive(reader, size);
  reader.end();
  return concat(padded(r, size), padded(s, size));
}

function ecdsaWire(signature: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (signature.length !== size * 2) throw new SignerError("Your browser returned an unsupported ECDSA signature.");
  return concat(mpint(signature.subarray(0, size)), mpint(signature.subarray(size)));
}

/** Import and validate a canonical supported public key using Web Crypto. */
export async function importPublic(blob: Uint8Array): Promise<PublicIdentity> {
  const parts = readPublic(blob);
  const keys = new Map<string, CryptoKey>();
  if (parts.kind === "ed25519") {
    keys.set(parts.algorithm, await crypto.subtle.importKey("raw", concat(parts.raw), "Ed25519", false, ["verify"]));
  } else if (parts.kind === "ecdsa") {
    keys.set(
      parts.algorithm,
      await crypto.subtle.importKey("jwk", ecJwk(parts), { name: "ECDSA", namedCurve: parts.curve.name }, false, [
        "verify",
      ]),
    );
  } else {
    for (const [algorithm, hash] of [
      ["rsa-sha2-256", "SHA-256"],
      ["rsa-sha2-512", "SHA-512"],
    ]) {
      keys.set(
        algorithm,
        await crypto.subtle.importKey("jwk", rsaJwk(parts), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]),
      );
    }
  }
  return {
    blob,
    async verify(data, signature) {
      try {
        const reader = new Reader(signature);
        const algorithm = reader.text();
        const raw = reader.string();
        reader.end();
        const key = keys.get(algorithm);
        if (!key) return false;
        if (parts.kind === "ecdsa") {
          return await crypto.subtle.verify(
            { name: "ECDSA", hash: parts.curve.hash },
            key,
            ecdsaRaw(raw, parts.curve.size),
            concat(data),
          );
        }
        if (parts.kind === "ed25519" && raw.length !== 64) return false;
        if (parts.kind === "rsa" && raw.length !== parts.n.length) return false;
        return await crypto.subtle.verify(key.algorithm.name, key, concat(raw), concat(data));
      } catch {
        return false;
      }
    },
  };
}

/** Validate OpenSSH's checks, components and padding before importing a key. */
export async function importPrivate(
  block: Uint8Array,
  publicKey: Uint8Array,
  blockSize: number,
): Promise<PrivateIdentity> {
  const reader = new Reader(block);
  const check = reader.u32();
  if (check !== reader.u32())
    throw new SignerError("Couldn't unlock that SSH key. Check its passphrase and try again.");
  const algorithm = reader.text();
  const parts = readPublic(publicKey);
  if (algorithm !== parts.algorithm) throw new SignerError("The SSH key's public and private identities don't match.");
  let jwk: JsonWebKey | undefined;
  let seed: Uint8Array<ArrayBuffer> | undefined;
  const temporary: Uint8Array[] = [];
  try {
    if (parts.kind === "ed25519") {
      const raw = reader.string();
      const secret = reader.string();
      if (secret.length !== 64 || !equal(raw, parts.raw) || !equal(secret.subarray(32), parts.raw)) {
        throw new SignerError("The SSH key's public and private identities don't match.");
      }
      seed = concat(new Uint8Array([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]), secret.subarray(0, 32));
      temporary.push(seed);
    } else if (parts.kind === "ecdsa") {
      const name = reader.text();
      const raw = reader.string();
      const d = padded(positive(reader, parts.curve.size), parts.curve.size);
      temporary.push(d);
      if (algorithm !== `ecdsa-sha2-${name}` || !equal(raw, parts.raw)) {
        throw new SignerError("The SSH key's public and private identities don't match.");
      }
      jwk = { ...ecJwk(parts), d: base64url(d) };
    } else {
      const n = positive(reader);
      const e = positive(reader, 8);
      const d = positive(reader);
      const qi = positive(reader);
      const p = positive(reader);
      const q = positive(reader);
      const pNumber = integer(p);
      const qNumber = integer(q);
      if (
        !equal(n, parts.n) ||
        !equal(e, parts.e) ||
        pNumber < 3n ||
        qNumber < 3n ||
        pNumber * qNumber !== integer(n) ||
        (qNumber * integer(qi)) % pNumber !== 1n
      ) {
        throw new SignerError("The SSH key's public and private identities don't match.");
      }
      const dp = integerBytes(integer(d) % (pNumber - 1n));
      const dq = integerBytes(integer(d) % (qNumber - 1n));
      temporary.push(dp, dq);
      jwk = {
        ...rsaJwk(parts),
        d: base64url(d),
        p: base64url(p),
        q: base64url(q),
        qi: base64url(qi),
        dp: base64url(dp),
        dq: base64url(dq),
      };
    }
    reader.string(); // Comments are display data, never part of the authorization.
    if (reader.remaining >= blockSize) throw new SignerError("The SSH key's padding isn't valid.");
    let padding = 1;
    while (reader.remaining) {
      if (reader.byte() !== padding++) throw new SignerError("The SSH key's padding isn't valid.");
    }
    const keys = new Map<string, CryptoKey>();
    if (parts.kind === "ed25519" && seed) {
      keys.set(algorithm, await crypto.subtle.importKey("pkcs8", seed, "Ed25519", false, ["sign"]));
    } else if (parts.kind === "ecdsa" && jwk) {
      keys.set(
        algorithm,
        await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: parts.curve.name }, false, ["sign"]),
      );
    } else if (parts.kind === "rsa" && jwk) {
      for (const [name, hash] of [
        ["rsa-sha2-256", "SHA-256"],
        ["rsa-sha2-512", "SHA-512"],
      ]) {
        keys.set(name, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["sign"]));
      }
    }
    const identity: PrivateIdentity = {
      publicKey,
      accepts(name, flags) {
        return parts.kind === "rsa"
          ? (flags === 2 && name === "rsa-sha2-256") || (flags === 4 && name === "rsa-sha2-512")
          : flags === 0 && name === algorithm;
      },
      async sign(data, name) {
        const key = keys.get(name);
        if (!key) throw new SignerError("The SSH signature algorithm isn't supported.");
        const parameters = parts.kind === "ecdsa" ? { name: "ECDSA", hash: parts.curve.hash } : key.algorithm.name;
        const raw = new Uint8Array(await crypto.subtle.sign(parameters, key, concat(data)));
        return concat(field(name), field(parts.kind === "ecdsa" ? ecdsaWire(raw, parts.curve.size) : raw));
      },
    };
    // Importing a JWK isn't enough: some engines accept inconsistent public
    // fields. Prove the private component matches the advertised identity.
    const verifier = await importPublic(publicKey);
    const challenge = new TextEncoder().encode("Subshell SSH private-key consistency check");
    const testAlgorithm = parts.kind === "rsa" ? "rsa-sha2-256" : algorithm;
    if (!(await verifier.verify(challenge, await identity.sign(challenge, testAlgorithm)))) {
      throw new SignerError("The SSH key's public and private identities don't match.");
    }
    return identity;
  } finally {
    for (const bytes of temporary) bytes.fill(0);
    // JWK strings and CryptoKeys are managed by the engine and can't be erased.
    jwk = undefined;
    seed = undefined;
  }
}

/**
 * Fingerprint helpers for the SSH agent relay's machine pins and agent keys
 * (docs/superpowers/specs/2026-10-08-ssh-agent-relay-design.md §4.5).
 *
 * A fingerprint is `SHA256:` + base64url(SHA-256(DER SubjectPublicKeyInfo))
 * with the padding stripped - the OpenSSH display notation. The preimage is
 * pinned to the DER encoding, NEVER a JSON-JWK serialization: JWK member
 * order is not canonical, so a JSON hash would make the trust card's honest
 * comparison (§4.6) ill-posed. Both machine keys (ES256 signing, ECDH-ES
 * encryption) are EC P-256, which is why one fixed DER structure covers the
 * pair: a P-256 public key's SPKI is the constant 27-byte AlgorithmIdentifier
 * header below plus the 64-byte uncompressed point X||Y, so the DER is BUILT
 * from the coordinates rather than asked of a key import. That is also why
 * this module does not go through `crypto.subtle.importKey`: Bun's WebCrypto
 * does not implement EC import at all (the same gap identity.ts papers over
 * with jose's node:crypto fallback), and this package runs there. `digest` is
 * a WebCrypto global in Bun and the browser both, so the hash stays on the
 * standard primitive.
 *
 * PURE and Metro-safe: no `node:` builtin import anywhere (pinned by test);
 * it rides the package barrel consumed by apps/client/mobile. The node-side
 * pin STORE (byte equality on the raw strings) is a separate concern and
 * lives in apps/node/agent/src/machine-pin-store.ts.
 */

/** The base64url alphabet (RFC 4648 §5): `-` and `_` in place of `+` and `/`. */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The reverse lookup for the alphabet above; -1 marks a non-alphabet byte. */
const BASE64URL_VALUES: number[] = (() => {
  const values = new Array<number>(128).fill(-1);
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    values[BASE64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return values;
})();

/**
 * The constant head of every EC P-256 public key's DER SubjectPublicKeyInfo:
 * SEQUENCE { AlgorithmIdentifier(id-ecPublicKey, prime256v1), BIT STRING(66) },
 * ending at the `04` that opens the uncompressed point. 27 bytes; the point's
 * X and Y follow. Independent encoders (node:crypto, browsers) produce
 * byte-identical output - pinned by test.
 */
const SPKI_P256_HEAD = Uint8Array.of(
  0x30,
  0x59,
  0x30,
  0x13,
  0x06,
  0x07,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x02,
  0x01,
  0x06,
  0x08,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x03,
  0x01,
  0x07,
  0x03,
  0x42,
  0x00,
  0x04,
);

/** A public JWK as the wire carries it: a JSON string, or its parsed shape. */
export type PublicJwkInput = string | Record<string, unknown>;

/**
 * Encodes bytes as base64url WITHOUT `=` padding. A small pure loop over the
 * bytes - deliberately not Buffer (a `node:` builtin Metro cannot resolve)
 * and not `btoa` (which wants a binary string glued together first).
 */
export function base64UrlNoPad(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64URL_ALPHABET[(n >> 18) & 63];
    out += BASE64URL_ALPHABET[(n >> 12) & 63];
    if (remaining > 1) out += BASE64URL_ALPHABET[(n >> 6) & 63];
    if (remaining > 2) out += BASE64URL_ALPHABET[n & 63];
  }
  return out;
}

/**
 * Decodes unpadded base64url text into bytes (the inverse of
 * {@link base64UrlNoPad}). Non-alphabet characters, stray `=` padding, and
 * impossible trailing-bit spellings throw - a coordinate is not trimmable
 * material, so junk is refused rather than repaired.
 */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (/[^A-Za-z0-9_-]/.test(text)) {
    throw new TypeError(`ssh-pin-store: not base64url text: ${JSON.stringify(text.slice(0, 12))}`);
  }
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of text) {
    value = (value << 6) | BASE64URL_VALUES[ch.charCodeAt(0)];
    bits += 6;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (bits >= 4) {
    // 4 or 5 leftover bits mean an encoding whose last character carried data
    // beyond the byte stream - not canonical, so not accepted.
    throw new TypeError("ssh-pin-store: base64url text has non-canonical trailing bits");
  }
  return out;
}

/**
 * The canonical fingerprint preimage of a PUBLIC EC P-256 JWK: its DER
 * SubjectPublicKeyInfo bytes. JWK member order cannot change the result,
 * because the coordinates are read by NAME and re-encoded from the fixed
 * P-256 structure, never hashed from the text.
 *
 * @throws TypeError on private material (a `d` member), a curve other than
 *   P-256 (the check is curve-pinned by NAME, not text-trusting), a wrong coordinate
 *   width, or non-base64url text - a private half must never acquire a
 *   "public" fingerprint.
 */
export function bytesOfJwk(publicJwk: PublicJwkInput): Uint8Array<ArrayBuffer> {
  const parsed: unknown = typeof publicJwk === "string" ? JSON.parse(publicJwk) : publicJwk;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("ssh-pin-store: fingerprint input is not a JWK object");
  }
  const jwk = parsed as Record<string, unknown>;
  if (jwk.d !== undefined) {
    throw new TypeError("ssh-pin-store: refusing to fingerprint private key material");
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new TypeError(
      `ssh-pin-store: fingerprint input is not an EC P-256 public key (kty=${String(jwk.kty)} crv=${String(jwk.crv)})`,
    );
  }
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("ssh-pin-store: EC public JWK is missing its x/y coordinates");
  }
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new TypeError(`ssh-pin-store: P-256 coordinates must be 32 bytes (got ${x.length}/${y.length})`);
  }
  const der = new Uint8Array(SPKI_P256_HEAD.length + 64);
  der.set(SPKI_P256_HEAD);
  der.set(x, SPKI_P256_HEAD.length);
  der.set(y, SPKI_P256_HEAD.length + 32);
  return der;
}

/**
 * The `SHA256:`-prefixed fingerprint of a public EC P-256 JWK (string or
 * object): SHA-256 over {@link bytesOfJwk}, base64url without padding - the
 * same notation OpenSSH prints for host keys, so an operator comparing the
 * trust card (§8) against `ssh-keygen -lf` output reads one alphabet.
 */
export async function fingerprintJwk(publicJwk: PublicJwkInput): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytesOfJwk(publicJwk));
  return `SHA256:${base64UrlNoPad(new Uint8Array(hash))}`;
}

import { importJWK } from "jose";
import { HttpError } from "@/api/auth-guard.js";

/** What importJWK accepts (structural, keeps the DOM-less tsconfig happy). */
type JwkInput = Parameters<typeof importJWK>[0];

/** Base64url charset; coordinate LENGTH is proven by the real import below. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Shared shape gate for both P-256 public-key registrations: an EC/P-256
 * object with base64url coordinates and NO private component - a public-key
 * store that accepted `d` would be storing a private key it was handed. The
 * refusal names the caller's field and nothing else (one generic message, so
 * the answer cannot be probed for WHY the key was refused).
 */
function assertP256PublicJwkShape(parsed: unknown, label: string): Record<string, unknown> {
  const jwk = parsed as Record<string, unknown> | null;
  const structurallyOk =
    typeof parsed === "object" &&
    jwk !== null &&
    !Array.isArray(parsed) &&
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string" &&
    jwk.x.length > 0 &&
    jwk.y.length > 0 &&
    BASE64URL.test(jwk.x) &&
    BASE64URL.test(jwk.y) &&
    // Public-key store: the private component must never be registered.
    !("d" in jwk);
  if (!structurallyOk) throw new HttpError(400, `${label} must be a valid P-256 public JWK`);
  return jwk;
}

/**
 * Proves a parsed JSON value is a PUBLIC P-256 key that jose can actually
 * import for ECDH-ES — the same operation `seal()` performs for every roster
 * key at post time. Registration only ever saw "parses as a JSON object", so
 * a garbage key that passed would make EVERY later `post_channel` throw
 * for EVERY member of every channel the registrant joined (channel-wide DoS).
 * Structural checks are not enough either: only the import round-trip catches
 * coordinates that are well-formed base64url but not a curve point.
 * @throws HttpError 400 with a single generic message on any failure.
 */
export async function assertImportablePublicJwk(parsed: unknown): Promise<void> {
  const jwk = assertP256PublicJwkShape(parsed, "publicKey");
  try {
    await importJWK(jwk as unknown as JwkInput, "ECDH-ES");
  } catch {
    throw new HttpError(400, "publicKey must be a valid P-256 public JWK");
  }
}

/**
 * Proves a parsed JSON value is a PUBLIC P-256 key that jose can import for
 * ES256 verification - the operation the SSH relay performs with a machine's
 * signing key (spec 2026-10-08 §4.1). Same discipline as
 * {@link assertImportablePublicJwk}: shape first, then the real import, which
 * is the only check that refuses well-formed-looking coordinates that are not
 * a curve point. A garbage registration here would poison every later
 * signature check against this machine, so nothing that fails it is stored.
 * @throws HttpError 400 with a single generic message on any failure.
 */
export async function assertImportableSigningJwk(parsed: unknown): Promise<void> {
  const jwk = assertP256PublicJwkShape(parsed, "signingPublicKey");
  try {
    await importJWK(jwk as unknown as JwkInput, "ES256");
  } catch {
    throw new HttpError(400, "signingPublicKey must be a valid P-256 public JWK");
  }
}

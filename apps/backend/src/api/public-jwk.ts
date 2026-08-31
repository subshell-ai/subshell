import { importJWK } from "jose";
import { HttpError } from "@/api/auth-guard.js";

/** What importJWK accepts (structural, keeps the DOM-less tsconfig happy). */
type JwkInput = Parameters<typeof importJWK>[0];

/** Base64url charset; coordinate LENGTH is proven by the real import below. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const INVALID = "publicKey must be a valid P-256 public JWK";

/**
 * Proves a parsed JSON value is a PUBLIC P-256 key that jose can actually
 * import for ECDH-ES — the same operation `seal()` performs for every roster
 * key at post time. Registration only ever saw "parses as a JSON object", so
 * a garbage key that passed would make EVERY later `mote_post_channel` throw
 * for EVERY member of every channel the registrant joined (channel-wide DoS).
 * Structural checks are not enough either: only the import round-trip catches
 * coordinates that are well-formed base64url but not a curve point.
 * @throws HttpError 400 with a single generic message on any failure.
 */
export async function assertImportablePublicJwk(parsed: unknown): Promise<void> {
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
  if (!structurallyOk) throw new HttpError(400, INVALID);
  try {
    await importJWK(jwk as unknown as JwkInput, "ECDH-ES");
  } catch {
    throw new HttpError(400, INVALID);
  }
}

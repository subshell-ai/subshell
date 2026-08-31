import { exportJWK, flattenedDecrypt, GeneralEncrypt, generateKeyPair, importJWK } from "jose";

/**
 * E2E-side mirror of `apps/backend/src/mcp/crypto.ts` (source of truth): the
 * same jose import line, the same header conventions, the same seal/open
 * logic, so the specs produce and consume the exact General-JWE envelopes the
 * backend stores and relays. Keep in sync by hand when the backend changes.
 *
 * Sealed delivery for channel posts, built entirely on jose (no hand-rolled
 * primitives): one random content key encrypts the body with AES-256-GCM, and
 * that key is wrapped to each recipient via ECDH-ES + A256KW — the General JWE
 * serialization's `recipients[]`, exactly the "one ciphertext, N wrapped
 * keys" shape.
 *
 * The per-recipient `kid` (principal label) lives in a plaintext recipient
 * header — deliberately visible metadata so the server can recipient-filter
 * without ever touching ciphertext.
 */

/** A principal's persisted keypair (JWKs as JSON strings). */
export interface IdentityKeyPair {
  /** Principal label this identity acts as ("sess:<id>", "user:<id>", …) */
  principalId: string;
  /** Public JWK JSON (P-256 / ECDH-ES) */
  publicJwk: string;
  /** Private JWK JSON — stays in the local process only */
  privateJwk: string;
}

/** A recipient to seal a post to. */
export interface SealRecipient {
  /** Principal label, embedded as the JWE `kid` */
  principalId: string;
  /** Public JWK JSON from /api/identities */
  publicJwk: string;
}

/** What importJWK accepts (structural, keeps the DOM-less tsconfig happy). */
type JwkInput = Parameters<typeof importJWK>[0];
const asJwk = (json: string): JwkInput => JSON.parse(json) as JwkInput;

/** The jose alg pair used everywhere in mote envelopes. */
const ALG = "ECDH-ES+A256KW" as const;
const ENC = "A256GCM" as const;

/** Generates a fresh P-256 keypair, serialized as JWK JSON strings. */
export async function generateKeypair(): Promise<{ publicJwk: string; privateJwk: string }> {
  // NOTE: alg name for ECDH in jose is "ECDH-ES"; Bun's crypto.subtle lacks
  // generateKeyPair, but jose falls back to node:crypto internally (spike).
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  return {
    publicJwk: JSON.stringify(await exportJWK(publicKey)),
    privateJwk: JSON.stringify(await exportJWK(privateKey)),
  };
}

/**
 * Encrypts `text` to N recipients. Returns the General JWE JSON (what goes
 * into the wire/DB `envelope` field) and the recipient id list (stored
 * alongside so the server can filter reads without parsing the envelope).
 */
export async function seal(
  text: string,
  recipients: SealRecipient[],
): Promise<{ envelope: string; recipientIds: string[] }> {
  if (recipients.length === 0) throw new Error("seal requires at least one recipient");
  const ge = new GeneralEncrypt(new TextEncoder().encode(text));
  ge.setProtectedHeader({ alg: ALG, enc: ENC });
  for (const r of recipients) {
    ge.addRecipient(await importJWK(asJwk(r.publicJwk), "ECDH-ES")).setUnprotectedHeader({
      kid: r.principalId,
    });
  }
  const envelope = await ge.encrypt();
  return { envelope: JSON.stringify(envelope), recipientIds: recipients.map((r) => r.principalId) };
}

/** A General JWE document, minimally typed. */
interface GeneralJwe {
  protected?: string;
  iv: string;
  ciphertext: string;
  tag: string;
  recipients: { header?: { kid?: string }; encrypted_key: string }[];
}

/** Thrown when the envelope holds no slot for `own.principalId`. */
export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

/**
 * Opens an envelope addressed to this principal. Finds the recipient slot by
 * plaintext `kid`, rebuilds the flattened JWE, and decrypts with the private
 * JWK. Fails (never silently mis-decodes) when unaddressed or tampered.
 */
export async function open(envelope: string, own: IdentityKeyPair): Promise<string> {
  let env: GeneralJwe;
  try {
    env = JSON.parse(envelope) as GeneralJwe;
  } catch {
    throw new DecryptError("envelope is not valid JSON");
  }
  const mine = (env.recipients ?? []).find((r) => r.header?.kid === own.principalId);
  if (!mine) throw new DecryptError(`envelope has no recipient slot for principal: ${own.principalId}`);
  let plaintext: Uint8Array;
  try {
    ({ plaintext } = await flattenedDecrypt(
      {
        protected: env.protected,
        header: mine.header,
        encrypted_key: mine.encrypted_key,
        iv: env.iv,
        tag: env.tag,
        ciphertext: env.ciphertext,
      },
      await importJWK(asJwk(own.privateJwk), "ECDH-ES"),
    ));
  } catch (err) {
    // Tampered/corrupt/foreign-key envelopes all land here (jose throws
    // JWEInvalid or JWEDecryptionFailed): one error type for "cannot open
    // this envelope" keeps the read path's accounting simple.
    throw new DecryptError(err instanceof Error ? err.message : String(err));
  }
  return new TextDecoder().decode(plaintext);
}

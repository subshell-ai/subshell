import { compactVerify, exportJWK, generateKeyPair, importJWK, type JWK, type JWTPayload, SignJWT } from "jose";
import { type NodeCommandBody, parseNodeCommandBody } from "./node-frames.js";

/**
 * Command signing for the node link (spec 2026-08-31 §4). The control plane
 * owns one ES256 keypair; every command is a compact JWS bound to ONE node
 * (aud), short-lived (30 s), single-use (jti LRU), with a per-connection
 * ordering hint (seq — the tracker resets on reconnect, it is NOT the replay
 * defense; exp + jti are).
 */

/** `iss` claim every command carries. */
export const NODE_CMD_ISSUER = "mote-control";

/** Default command lifetime in seconds (spec §4: uniform, socket-open-only). */
export const NODE_CMD_TTL_SEC = 30;

/** Tolerated clock skew on the `iat` freshness check, in seconds. */
const IAT_SKEW_SEC = 5;

/** An EC (P-256) JWK as jose's static type wants it. */
type EcJwk = JWK & { kty: "EC"; crv: "P-256" };

/**
 * The control keypair as exportable JWKs (persistence is the caller's job —
 * see `services/nodes/` on the backend, spec §4).
 */
export interface ControlKeyPair {
  /** Public half — handed to agents at enroll (pin-once) */
  publicJwk: JsonWebKey;
  /** Private half — secrets! Store 0600 outside the DB (spec §4) */
  privateJwk: JsonWebKey;
}

/**
 * Generate a fresh control keypair (ES256 / P-256).
 * @returns both halves as JWKs (private carries `d`)
 */
export async function generateControlKeys(): Promise<ControlKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const [privateJwk, publicJwk] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]);
  return {
    publicJwk: publicJwk as unknown as JsonWebKey,
    privateJwk: privateJwk as unknown as JsonWebKey,
  };
}

/** Force a stored JWK into the EC/P-256 shape jose's types demand. */
function asEcJwk(jwk: JsonWebKey): EcJwk {
  return { ...(jwk as unknown as Record<string, unknown>), kty: "EC", crv: "P-256" } as EcJwk;
}

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return (await importJWK({ ...asEcJwk(jwk), d: jwk.d ?? "" }, "ES256")) as CryptoKey;
}

async function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return (await importJWK(asEcJwk(jwk), "ES256")) as CryptoKey;
}

/**
 * Per-connection monotonic ordering hint (spec §4). Reset on every connect.
 * NOT the replay defense — exp + jti are; this only catches reordering and
 * stale replays that arrive within the TTL window on the SAME socket.
 */
export class SeqTracker {
  #last = 0;
  /** True when `seq` advances the tracker (gaps tolerated, regressions not). */
  accept(seq: number): boolean {
    if (!Number.isInteger(seq) || seq <= this.#last) return false;
    this.#last = seq;
    return true;
  }
  /** Forget history — call when a NEW socket opens. */
  reset(): void {
    this.#last = 0;
  }
}

/** Bounded LRU of accepted `jti` ids (>= 2× the exp window; spec §4). */
export class JtiLru {
  readonly #capacity: number;
  readonly #seen = new Set<string>();
  constructor(capacity = 2048) {
    this.#capacity = capacity;
  }
  /** True if already recorded; records (and evicts oldest) otherwise. */
  seen(jti: string): boolean {
    if (this.#seen.has(jti)) {
      this.#seen.delete(jti);
      this.#seen.add(jti);
      return true;
    }
    this.#seen.add(jti);
    if (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.values().next().value as string;
      this.#seen.delete(oldest);
    }
    return false;
  }
}

/** Inputs to {@link signCommand}. */
export interface SignCommandInput {
  /** Node id (without the `node:` prefix) the command is aimed at */
  nodeId: string;
  /** Unique id per command (anti-replay + result correlation) */
  jti: string;
  /** Per-connection monotonic counter */
  seq: number;
  /** The payload */
  cmd: NodeCommandBody;
  /** Seconds since epoch (default: wall clock) — injectable for tests */
  nowSec?: number;
  /** Lifetime override (default {@link NODE_CMD_TTL_SEC}) */
  ttlSec?: number;
}

/**
 * Sign a command into a compact JWS envelope.
 * @param privateJwk - the control keypair's private half
 * @param input - audience, jti, seq, cmd (and optional clock/TTL)
 * @returns the compact JWS (`header.payload.signature`)
 */
export async function signCommand(privateJwk: JsonWebKey, input: SignCommandInput): Promise<string> {
  const key = await importPrivate(privateJwk);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ cmd: input.cmd, seq: input.seq })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(NODE_CMD_ISSUER)
    .setAudience(`node:${input.nodeId}`)
    .setJti(input.jti)
    .setIssuedAt(now)
    .setExpirationTime(now + (input.ttlSec ?? NODE_CMD_TTL_SEC))
    .sign(key);
}

/**
 * Sign an arbitrary claim set with the control key.
 * @internal test-only — exercises the verify paths signCommand cannot produce.
 * @param privateJwk - the control keypair's private half
 * @param claims - registered claims via setters, the rest as payload members
 * @returns the compact JWS
 */
export async function signRawClaims(
  privateJwk: JsonWebKey,
  claims: Record<string, unknown> & { aud?: string | string[]; exp?: number; iat?: number },
  opts?: {
    /** Omit the `exp` claim entirely — lets tests pin the missing-expiry path. */
    omitExp?: boolean;
  },
): Promise<string> {
  const key = await importPrivate(privateJwk);
  const now = Math.floor(Date.now() / 1000);
  const reserved = new Set(["iss", "aud", "jti", "iat", "exp"]);
  const jwt = new SignJWT(
    Object.fromEntries(Object.entries(claims).filter(([k]) => !reserved.has(k))),
  ).setProtectedHeader({ alg: "ES256", typ: "JWT" });
  if (typeof claims.iss === "string") jwt.setIssuer(claims.iss);
  if (typeof claims.aud === "string" || Array.isArray(claims.aud)) jwt.setAudience(claims.aud);
  if (typeof claims.jti === "string") jwt.setJti(claims.jti);
  jwt.setIssuedAt(claims.iat ?? now);
  if (!opts?.omitExp) jwt.setExpirationTime(claims.exp ?? now + NODE_CMD_TTL_SEC);
  return jwt.sign(key);
}

/** Verified claims of one command frame. */
export interface CommandClaims {
  /** Command payload */
  cmd: NodeCommandBody;
  /** Anti-replay id */
  jti: string;
  /** Per-connection ordering hint */
  seq: number;
}

/** Outcome of {@link verifyCommand}; `reason` is stable for logging/metrics. */
export type VerifyOutcome =
  | { ok: true; claims: CommandClaims }
  | { ok: false; reason: "signature" | "claims" | "replay" | "seq" | "malformed" };

/** Context for {@link verifyCommand}: per-connection state lives here. */
export interface VerifyContext {
  /** This node's id (audience check) */
  nodeId: string;
  /** Shared anti-replay cache for this node's connections */
  jtiLru: JtiLru;
  /** Per-connection seq tracker (fresh/reset per socket) */
  seqTracker: SeqTracker;
  /** Seconds since epoch (default wall clock) — injectable for tests */
  nowSec?: number;
}

/** `aud` is a string or a string array; either must contain the node's id. */
function audienceMatches(aud: JWTPayload["aud"], want: string): boolean {
  if (typeof aud === "string") return aud === want;
  if (Array.isArray(aud)) return aud.includes(want);
  return false;
}

/**
 * Verify a signed command frame: signature → claims (iss/aud/exp/iat) → jti
 * shape → jti replay → seq hint → cmd well-formedness. Order matters: only
 * frames that reach the replay gate can pollute the jti LRU, and a frame
 * rejected on seq still records its jti (it is stale or hostile either way —
 * it must never get a second evaluation).
 *
 * jose v6's `compactVerify` checks crypto and format ONLY (it ignores
 * registered-claim options; `algorithms` pins the accepted alg so a header
 * swap can never downgrade us), so iss/aud/exp/iat are validated here — that
 * split is what keeps `reason: "signature"` for bad crypto/format and
 * `reason: "claims"` for issuer/audience/expiry failures.
 */
export async function verifyCommand(jws: string, publicJwk: JsonWebKey, ctx: VerifyContext): Promise<VerifyOutcome> {
  // 1. Signature + compact-JWS format; the payload is parsed from the BYTES
  // this call just verified (jose v6 hands back a Uint8Array) — never by a
  // second unverified decode of the wire string.
  let payload: JWTPayload;
  try {
    const key = await importPublic(publicJwk);
    const verified = await compactVerify(jws, key, { algorithms: ["ES256"] });
    payload = JSON.parse(new TextDecoder().decode(verified.payload)) as JWTPayload;
  } catch {
    return { ok: false, reason: "signature" };
  }

  // 2. Registered claims (compactVerify does not evaluate these).
  const now = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.iss !== NODE_CMD_ISSUER) return { ok: false, reason: "claims" };
  if (!audienceMatches(payload.aud, `node:${ctx.nodeId}`)) return { ok: false, reason: "claims" };
  if (typeof payload.exp !== "number" || payload.exp <= now) return { ok: false, reason: "claims" };
  if (typeof payload.iat !== "number" || payload.iat > now + IAT_SKEW_SEC) {
    return { ok: false, reason: "claims" };
  }

  // 3. Anti-replay fields.
  if (typeof payload.jti !== "string" || typeof payload.seq !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (ctx.jtiLru.seen(payload.jti)) return { ok: false, reason: "replay" };
  if (!ctx.seqTracker.accept(payload.seq)) return { ok: false, reason: "seq" };

  // 4. Payload well-formedness.
  const cmd = parseNodeCommandBody(payload.cmd);
  if (!cmd) return { ok: false, reason: "malformed" };
  return { ok: true, claims: { cmd, jti: payload.jti, seq: payload.seq } };
}

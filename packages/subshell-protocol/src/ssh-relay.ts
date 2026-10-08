import { compactVerify, importJWK, type JWK, type JWTPayload, SignJWT } from "jose";
import { BASE64_RE, isRecord, isStr } from "./guards.js";
import { isRelayDirection, type RelayDirection } from "./node-frames.js";
import { base64FromBytes, base64ToBytes } from "./ssh-base64-std.js";
import { SSH_RELAY_FRAME_MAX_BYTES } from "./ssh-limits.js";
import { base64UrlNoPad, base64UrlToBytes } from "./ssh-pin-store.js";

/**
 * The sealed agent relay's envelope codec (spec 2026-10-08 §5.6). One ssh-agent
 * message crosses the relay as a PURE data flow:
 *
 *   message -> canonicalize (fixed sorted-key JSON, binds every field)
 *           -> sign         (ES256 compact JWS over the canonical string;
 *                            ORIGIN - §5.6: confidentiality is not authenticity)
 *           -> wrap         ({ jws, routingRef, direction, seq } - the fields
 *                            the receiver reads FIRST to locate the session,
 *                            sealed so the plane never sees them either)
 *           -> seal         (the injected mcp-core recipe: ECDH-ES+A256KW /
 *                            A256GCM to the recipient's PINNED encryption key)
 *           -> base64       (the strict padded spelling RelayFrame.blob wants;
 *                            that codec lives in ssh-base64-std.ts)
 *
 * `open` yields the JWS + routing fields, `verifyRelayEnvelope` binds the rest,
 * and the receiver's {@link SeqGate} refuses resends and rewinds. The agent
 * payload never leaves the signed-and-sealed inner: the plane routes blobs.
 *
 * seal/open are INJECTED, not imported: the production pair lives in
 * `packages/mcp-core/src/crypto.ts`, which depends on this package - importing
 * it back would be a workspace cycle (and Metro cannot see mcp-core at all).
 * {@link RelaySealFn}/{@link RelayOpenFn} are mcp-core's exact signatures, so
 * Tasks 6/7 pass `seal`/`open` straight through. The pin byte-equality check
 * that produces those keys is the node-side MachinePinStore (§4.4), the
 * caller's side of honesty; this codec never touches storage.
 *
 * PURE and Metro-safe: no `node:` builtin import (pinned by test); all crypto
 * goes through jose (Bun's WebCrypto lacks EC importKey/exportKey - the same
 * gap node-signing.ts papers over, so key import mirrors THAT file) and the
 * WebCrypto globals `crypto.getRandomValues` / `crypto.subtle`.
 */

/** `iss` claim every relay signature carries; the codec refuses any other. */
export const RELAY_SIG_ISSUER = "subshell-ssh-relay";

/** Session nonces are 128 bits, base64url-spelled (spec §5.6). */
const NONCE_BYTES = 16;

/** The canonical message's field census, in the emission order (§5.6). */
const MESSAGE_FIELDS = ["agentBytesB64", "direction", "nA", "nB", "relaySessionId", "routingRef", "seq"] as const;

/**
 * The signed inner message (spec §5.6): the signature covers a canonicalized
 * encoding of EXACTLY these fields, so tampering any one of them - or moving
 * an envelope to another session, direction, or slot - fails verification.
 */
export interface RelayInnerMessage {
  /** The relay-session id the plane minted (closes cross-session replay) */
  relaySessionId: string;
  /** The opaque routing ref this session's frames ride (binds envelope to lane) */
  routingRef: string;
  /** Which way this message travels inside its session */
  direction: RelayDirection;
  /** The SIGNED anti-replay seq: strictly increasing per direction, first may be 0 */
  seq: number;
  /** B's endpoint nonce; present once B has sent (always in B2A, both in A2B) */
  nB?: string;
  /** A's endpoint nonce; absent in B's very first message (A has not spoken yet) */
  nA?: string;
  /** The agent payload, canonical base64url (no padding) - opaque to the codec */
  agentBytesB64: string;
}

/** The sealed inner the wire carries: the JWS plus the locate-first fields. */
export interface RelayEnvelopeOpen {
  /** The compact JWS whose canonical payload binds everything else */
  jws: string;
  /** Wrapper copy of the routing ref - cross-checked against the signature */
  routingRef: string;
  /** Wrapper copy of the direction - cross-checked against the signature */
  direction: RelayDirection;
  /** Wrapper copy of the SIGNED seq - the value the SeqGate judges */
  seq: number;
}

/** A recipient to seal to: label + PUBLIC encryption JWK as a JSON string. */
export interface RelaySealRecipient {
  /** The address label sealed as the JWE recipient `kid` (e.g. `node:<id>`) */
  principalId: string;
  /** Public JWK JSON of the recipient's PINNED ECDH-ES encryption key */
  publicJwk: string;
}

/** The opener's own identity: label + BOTH encryption JWK halves as strings. */
export interface RelayOwnIdentity {
  /** The principal label whose recipient slot to open (must match the `kid`) */
  principalId: string;
  /** Public JWK JSON (kept for symmetry with mcp-core's IdentityKeyPair) */
  publicJwk: string;
  /** Private JWK JSON - stays in the local process, like every private half */
  privateJwk: string;
}

/** mcp-core `crypto.ts` seal's signature (structurally assignable to it). */
export type RelaySealFn = (
  text: string,
  recipients: RelaySealRecipient[],
) => Promise<{ envelope: string; recipientIds: string[] }>;

/** mcp-core `crypto.ts` open's signature (throws on foreign/tampered input). */
export type RelayOpenFn = (envelope: string, own: RelayOwnIdentity) => Promise<string>;

/** Inputs to {@link signRelayEnvelope}. */
export interface SignRelayEnvelopeInput {
  /** The sender's ES256 signing private JWK (the §4.1 per-machine key) */
  privateJwk: JsonWebKey;
  /** The message to canonicalize and sign */
  message: RelayInnerMessage;
}

/**
 * The facts a verifier cross-checks the signature against: the routing
 * triple the wrapper locates its session by, plus the session facts only the
 * ENDPOINT knows (I-1, Task 5 review): when the caller holds a session, it
 * supplies what it recorded and {@link verifyRelayEnvelope} enforces every
 * present member. The codec owns none of these facts itself.
 */
export interface RelayBinding {
  /** The opaque routing ref the session's frames ride */
  routingRef: string;
  /** Which way the message travels inside the session */
  direction: RelayDirection;
  /** The signed anti-replay seq */
  seq: number;
  /** B's endpoint nonce as this endpoint recorded it for this relay-open */
  nB?: string;
  /** A's endpoint nonce as this endpoint recorded it for this relay-open */
  nA?: string;
  /** The relay-session id from the `ssh_relay_open` command */
  relaySessionId?: string;
}

/** Inputs to {@link verifyRelayEnvelope}. */
export interface VerifyRelayEnvelopeInput {
  /** The compact JWS from the opened wrapper */
  jws: string;
  /** The sender's PINNED ES256 signing public key (the §4.4 machine pin) */
  publicJwk: JsonWebKey;
  /**
   * The wrapper's locate-first fields and, once the caller holds session
   * state, the nonces and relay-session id it recorded (see
   * {@link RelayBinding}). Every provided member MUST equal what the
   * signature says, so a sealed-but-hostile wrapper cannot pair one
   * session's ref with another session's signed bytes, and an envelope
   * carrying another pairing's nonce is refused the same way.
   */
  expect?: Partial<RelayBinding>;
}

/** Inputs to {@link sealRelayEnvelope}. */
export interface SealRelayEnvelopeInput {
  /** The message to canonicalize, sign, wrap, and seal */
  message: RelayInnerMessage;
  /** The sender's ES256 signing private JWK */
  privateJwk: JsonWebKey;
  /** The recipient's PINNED encryption key and its address label */
  recipient: RelaySealRecipient;
  /** The sealing primitive (mcp-core's `seal`; see the file header) */
  seal: RelaySealFn;
}

/** Inputs to {@link openRelayEnvelope}. */
export interface OpenRelayEnvelopeInput {
  /** The RelayFrame blob: strict padded base64 of the sealed envelope */
  blob: string;
  /** THIS machine's encryption identity (the slot `kid` to open) */
  own: RelayOwnIdentity;
  /** The opening primitive (mcp-core's `open`; see the file header) */
  open: RelayOpenFn;
  /**
   * The frame's own routing facts - REQUIRED (Task 5 review M-1: every real
   * call site holds the frame). The wrapper must agree with them: a frame
   * relayed under ref X cannot deliver an envelope addressed through ref Y,
   * checked before any key material is consulted. The SIGNED anti-replay seq
   * is deliberately absent: the frame's transport seq is a different number
   * (Task 4's grammar), and the wrapper's is sealed inside and only known
   * after opening - bind it with {@link verifyRelayEnvelope}'s `expect`.
   */
  expect: { ref: string; direction: RelayDirection };
}

/** The EC (P-256) JWK shape jose's static types demand (mirrors node-signing). */
type EcJwk = JWK & { kty: "EC"; crv: "P-256" };

/** Force a stored JWK into the EC/P-256 shape jose's types demand. */
function asEcJwk(jwk: JsonWebKey): EcJwk {
  return { ...(jwk as unknown as Record<string, unknown>), kty: "EC", crv: "P-256" } as EcJwk;
}

async function importPrivateES256(jwk: JsonWebKey): Promise<CryptoKey> {
  return (await importJWK({ ...asEcJwk(jwk), d: jwk.d ?? "" }, "ES256")) as CryptoKey;
}

async function importPublicES256(jwk: JsonWebKey): Promise<CryptoKey> {
  return (await importJWK(asEcJwk(jwk), "ES256")) as CryptoKey;
}

/* ------------------------------------------------------------------ */
/* canonicalization (§5.6)                                             */
/* ------------------------------------------------------------------ */

/** Refuse anything that is not a canonical 128-bit base64url nonce. */
function requireNonce(label: string, nonce: unknown): string {
  if (!isStr(nonce)) throw new TypeError(`ssh-relay: ${label} is not a base64url string`);
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(nonce);
  } catch {
    throw new TypeError(`ssh-relay: ${label} is not canonical base64url`);
  }
  if (bytes.length !== NONCE_BYTES) {
    throw new TypeError(`ssh-relay: ${label} must be ${NONCE_BYTES} bytes (got ${bytes.length})`);
  }
  return nonce;
}

/**
 * The nonce pair as the canonical message spells it (spec §5.6): `nB` alone
 * in B's first message, both once each side has seen the peer's, never `nA`
 * without `nB` (B speaks first - though the codec only binds what is present,
 * the endpoints own that protocol fact). Validates through {@link newNonce}'s
 * shape: 16 bytes, canonical base64url.
 */
export function bindNonces(nA?: string, nB?: string): { nA?: string; nB?: string } {
  const bound: { nA?: string; nB?: string } = {};
  if (nA !== undefined) bound.nA = requireNonce("nA", nA);
  if (nB !== undefined) bound.nB = requireNonce("nB", nB);
  return bound;
}

/** Validate a loose record as the closed inner-message grammar, or throw. */
function assertRelayInnerMessage(raw: Record<string, unknown>): RelayInnerMessage {
  for (const key of Object.keys(raw)) {
    if (!(MESSAGE_FIELDS as readonly string[]).includes(key) && raw[key] !== undefined) {
      throw new TypeError(`ssh-relay: unknown relay message field: ${key}`);
    }
  }
  if (!isStr(raw.relaySessionId) || raw.relaySessionId.length === 0) {
    throw new TypeError("ssh-relay: relaySessionId must be a non-empty string");
  }
  if (!isStr(raw.routingRef) || raw.routingRef.length === 0) {
    throw new TypeError("ssh-relay: routingRef must be a non-empty string");
  }
  if (!isRelayDirection(raw.direction)) {
    throw new TypeError("ssh-relay: direction must be B2A or A2B");
  }
  // `-0` passes the safe-integer and `< 0` screens yet JSON-spells as `0`, so
  // it would smuggle a value that === 0 into every later comparison (M-3).
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0 || Object.is(raw.seq, -0)) {
    throw new TypeError("ssh-relay: seq must be a non-negative safe integer");
  }
  if (!isStr(raw.agentBytesB64)) {
    throw new TypeError("ssh-relay: agentBytesB64 must be a base64url string");
  }
  try {
    base64UrlToBytes(raw.agentBytesB64); // "" (empty payload) is canonical and legal
  } catch {
    throw new TypeError("ssh-relay: agentBytesB64 is not canonical base64url");
  }
  const message: RelayInnerMessage = {
    agentBytesB64: raw.agentBytesB64,
    direction: raw.direction,
    relaySessionId: raw.relaySessionId,
    routingRef: raw.routingRef,
    seq: raw.seq as number,
  };
  const { nA, nB } = bindNonces(raw.nA as string | undefined, raw.nB as string | undefined);
  if (nA !== undefined) message.nA = nA;
  if (nB !== undefined) message.nB = nB;
  return message;
}

/**
 * The deterministic canonical encoding the signature covers: JSON with the
 * fixed (alphabetically sorted) field order above, integers in plain spelling,
 * optional nonces emitted only when present. JS key insertion order cannot
 * reach it (fields are read by NAME into a fresh object), and changing ANY
 * field changes the string, so the signature binds every one.
 */
export function canonicalizeRelayMessage(m: RelayInnerMessage): string {
  const message = assertRelayInnerMessage(m as unknown as Record<string, unknown>);
  const canonical: Record<string, unknown> = {};
  for (const field of MESSAGE_FIELDS) {
    const value = message[field as keyof RelayInnerMessage];
    if (value !== undefined) canonical[field] = value;
  }
  return JSON.stringify(canonical);
}

/** Re-derive the message from its canonical string; throws on anything else. */
function parseCanonicalRelayMessage(canonical: string): RelayInnerMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(canonical);
  } catch {
    throw new TypeError("ssh-relay: canonical payload is not JSON");
  }
  if (!isRecord(raw)) throw new TypeError("ssh-relay: canonical payload is not an object");
  const message = assertRelayInnerMessage(raw);
  // The re-derivation must reproduce the verified bytes EXACTLY: an encoding
  // that differs only in spelling (key order, spacing) never came from here.
  if (canonicalizeRelayMessage(message) !== canonical) {
    throw new TypeError("ssh-relay: canonical payload is not in canonical spelling");
  }
  return message;
}

/* ------------------------------------------------------------------ */
/* origin: the ES256 signature (§5.6)                                  */
/* ------------------------------------------------------------------ */

/**
 * Sign a relay message into a compact JWS: the canonical string rides as the
 * single `msg` claim under our issuer. There is deliberately NO `exp` - the
 * session's lifetime is the endpoints'/broker's cut (§5.6), and per-message
 * expiry would make node clock skew an origin failure; replay is the seq
 * gate's job, forgery is this signature's.
 *
 * @throws TypeError when the message is malformed (before any crypto runs)
 */
export async function signRelayEnvelope(input: SignRelayEnvelopeInput): Promise<string> {
  const key = await importPrivateES256(input.privateJwk);
  return new SignJWT({ msg: canonicalizeRelayMessage(input.message) })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(RELAY_SIG_ISSUER)
    .sign(key);
}

/**
 * Verify a relay signature against the peer's PINNED signing key and return
 * the message the canonical string spells. Every failure THROWS - callers
 * treat any throw as origin refusal (the machine pin, not this codec, is what
 * made `publicJwk` trustworthy). jose v6's `compactVerify` checks crypto and
 * format only, so the `iss` claim is evaluated here, and `algorithms` pins
 * ES256 so a header swap can never downgrade the check (node-signing's rule,
 * verbatim). When `expect` is given, EVERY provided member (the routing
 * triple, and - once the caller holds session state - the recorded nonces and
 * relay-session id) must match what the signature says; a mismatch is a
 * refused binding, not a soft hint.
 */
export async function verifyRelayEnvelope(input: VerifyRelayEnvelopeInput): Promise<RelayInnerMessage> {
  let payload: JWTPayload;
  try {
    const key = await importPublicES256(input.publicJwk);
    const verified = await compactVerify(input.jws, key, { algorithms: ["ES256"] });
    payload = JSON.parse(new TextDecoder().decode(verified.payload)) as JWTPayload;
  } catch {
    throw new TypeError("ssh-relay: relay envelope signature is invalid");
  }
  if (payload.iss !== RELAY_SIG_ISSUER || typeof payload.msg !== "string") {
    throw new TypeError("ssh-relay: relay envelope claims are invalid");
  }
  const message = parseCanonicalRelayMessage(payload.msg);
  const expect = input.expect;
  if (expect) {
    if (expect.routingRef !== undefined && expect.routingRef !== message.routingRef) {
      throw new TypeError("ssh-relay: routingRef does not match the signature");
    }
    if (expect.direction !== undefined && expect.direction !== message.direction) {
      throw new TypeError("ssh-relay: direction does not match the signature");
    }
    if (expect.seq !== undefined && expect.seq !== message.seq) {
      throw new TypeError("ssh-relay: seq does not match the signature");
    }
    if (expect.relaySessionId !== undefined && expect.relaySessionId !== message.relaySessionId) {
      throw new TypeError("ssh-relay: relaySessionId does not match the signature");
    }
    // I-1: the endpoint-minted nonces. The plane cannot mint these, so a
    // resent envelope from another pairing is refused HERE once the caller
    // binds the values it recorded for this relay-open.
    if (expect.nB !== undefined && expect.nB !== message.nB) {
      throw new TypeError("ssh-relay: nB does not match the signature");
    }
    if (expect.nA !== undefined && expect.nA !== message.nA) {
      throw new TypeError("ssh-relay: nA does not match the signature");
    }
  }
  return message;
}

/* ------------------------------------------------------------------ */
/* the sealed envelope: wrap + seal, open + bind                       */
/* ------------------------------------------------------------------ */

/**
 * Produce the wire blob for one relay message: canonicalize, sign, wrap as
 * `{ jws, routingRef, direction, seq }`, and seal the wrapper to the
 * recipient's PINNED encryption key. The returned string is strict padded
 * base64 of the General JWE JSON - exactly what `RelayFrame.blob` carries -
 * and is refused here (not on the wire) when it would exceed
 * SSH_RELAY_FRAME_MAX_BYTES: the cap is law on both sides of the link.
 *
 * @throws TypeError on a malformed message, recipient label/key, or over-cap blob
 */
export async function sealRelayEnvelope(input: SealRelayEnvelopeInput): Promise<string> {
  const message = assertRelayInnerMessage(input.message as unknown as Record<string, unknown>);
  if (!isStr(input.recipient?.principalId) || input.recipient.principalId.length === 0) {
    throw new TypeError("ssh-relay: recipient principalId must be a non-empty string");
  }
  if (!isStr(input.recipient.publicJwk) || input.recipient.publicJwk.length === 0) {
    throw new TypeError("ssh-relay: recipient publicJwk must be a non-empty string");
  }
  const jws = await signRelayEnvelope({ privateJwk: input.privateJwk, message });
  const wrapper = JSON.stringify({
    jws,
    routingRef: message.routingRef,
    direction: message.direction,
    seq: message.seq,
  });
  const { envelope } = await input.seal(wrapper, [
    { principalId: input.recipient.principalId, publicJwk: input.recipient.publicJwk },
  ]);
  const bytes = new TextEncoder().encode(envelope);
  if (bytes.length > SSH_RELAY_FRAME_MAX_BYTES) {
    throw new TypeError(
      `ssh-relay: sealed envelope is ${bytes.length} bytes, over the SSH_RELAY_FRAME_MAX_BYTES cap of ${SSH_RELAY_FRAME_MAX_BYTES}`,
    );
  }
  return base64FromBytes(bytes);
}

/**
 * Open a relay frame's blob with THIS machine's encryption key and return the
 * JWS + routing fields. Throws when the blob is not base64, holds no slot for
 * `own.principalId`, is not addressed to us cryptographically, or is tampered
 * (the injected `open` fails all of those); the wrapper's shape is validated
 * before it is handed back. This does NOT verify origin - that is
 * {@link verifyRelayEnvelope} with the sender's pinned signing key, then the
 * caller's {@link SeqGate}. Anyone holding the recipient's PUBLIC encryption
 * key can craft a seal the recipient opens (§5.6's first line), so an opened
 * wrapper is unsigned noise until the signature says otherwise.
 */
export async function openRelayEnvelope(input: OpenRelayEnvelopeInput): Promise<RelayEnvelopeOpen> {
  if (!isStr(input.blob) || input.blob.length === 0 || !BASE64_RE.test(input.blob)) {
    throw new TypeError("ssh-relay: blob is not strict padded base64");
  }
  const envelopeText = new TextDecoder().decode(base64ToBytes(input.blob));
  const wrapperText = await input.open(envelopeText, input.own);
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(wrapperText);
  } catch {
    throw new TypeError("ssh-relay: opened envelope holds no JSON wrapper");
  }
  if (!isRecord(wrapper)) throw new TypeError("ssh-relay: opened envelope wrapper is not an object");
  const { jws, routingRef, direction, seq, ...rest } = wrapper;
  if (Object.keys(rest).length > 0) {
    throw new TypeError("ssh-relay: relay wrapper carries unknown fields");
  }
  if (!isStr(jws) || jws.length === 0) throw new TypeError("ssh-relay: wrapper jws is not a non-empty string");
  if (!isStr(routingRef) || routingRef.length === 0) {
    throw new TypeError("ssh-relay: wrapper routingRef is not a non-empty string");
  }
  if (!isRelayDirection(direction)) {
    throw new TypeError("ssh-relay: wrapper direction is not B2A or A2B");
  }
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || Object.is(seq, -0)) {
    throw new TypeError("ssh-relay: wrapper seq is not a non-negative safe integer");
  }
  if (input.expect.ref !== routingRef) {
    throw new TypeError("ssh-relay: wrapper routingRef does not match the frame's ref");
  }
  if (input.expect.direction !== direction) {
    throw new TypeError("ssh-relay: wrapper direction does not match the frame's");
  }
  return { jws, routingRef, direction, seq: seq as number };
}

/* ------------------------------------------------------------------ */
/* replay: the per-direction seq gate (§5.6)                           */
/* ------------------------------------------------------------------ */

/**
 * The per-direction anti-replay judge for ONE relay session (spec §5.6): the
 * receiver keeps the highest accepted `seq` for each direction and accepts
 * only a strictly greater one, so a multi-key handshake (several
 * SIGN_REQUESTs, increasing seq) completes while a byte-identical resend or
 * any rewind is refused - even though the plane routes every envelope and can
 * resend any of them. The two directions are independent: B2A and A2B are
 * different senders, and one's stream must not throttle the other. Built per
 * session; seq restarts with the session (the signature binds the session id,
 * so a stale envelope cannot ride a fresh session's gate).
 */
export class SeqGate {
  #last: Record<RelayDirection, number> = { B2A: -1, A2B: -1 };

  /**
   * True iff `seq` advances this direction (first accepted value may be 0;
   * gaps are legal, regressions and resends are not). Malformed seq (negative,
   * fractional, non-finite) or an unknown direction answers false and changes
   * nothing - a hostile frame must never move the watermark.
   */
  accept(direction: RelayDirection, seq: number): boolean {
    if (!isRelayDirection(direction)) return false;
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    if (seq <= this.#last[direction]) return false;
    this.#last[direction] = seq;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* endpoint nonces (§5.6)                                              */
/* ------------------------------------------------------------------ */

/**
 * A fresh 128-bit session nonce, canonical base64url (22 characters). Each
 * endpoint mints ONE at session start - B carries `nB` in its first sealed
 * request, A carries `nA` in its first sealed response - and thereafter signs
 * the PEER's value into every message, so an envelope from a different pairing
 * never validates, byte-identical payload or not. WebCrypto's
 * `crypto.getRandomValues` is a global in Bun, node, and the browser alike.
 */
export function newNonce(): string {
  return base64UrlNoPad(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

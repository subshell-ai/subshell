import { createHash } from "node:crypto";

/**
 * The ssh-agent numbering schemes the A-side relay responder probes between
 * (spec 2026-10-08 §5.4, ruling 2026-10-08: the numbering is PROBED, not
 * baked). OpenSSH's classic numbering (identities 13 / answer 14 / sign 15 /
 * sign response 16) and the RFC 9987 numbering OpenSSH 10.x ships (identities
 * 11 / answer 12 / sign 13 / sign response 14) COLLIDE: byte 13 is the
 * identities request under classic and the sign request under 10.x, and byte
 * 14 is the answer under classic and the sign response under 10.x. Measured on
 * this fleet's OpenSSH_10.2p1: request 11 answers 12; requests 13 and 15 both
 * answer FAILURE(5). Forwarding a codepoint under the wrong interpretation is
 * how an unscoped SIGN_REQUEST reaches the agent, so the responder must know
 * which scheme A's live agent speaks before it classifies ANY byte.
 *
 * {@link probeAgentScheme} resolves that once per relay-session open: it sends
 * each candidate's well-formed identities request in turn and demands a
 * VALID IDENTITIES_ANSWER in that candidate's own answer byte to name the
 * scheme. A byte-13 probe against a 10.x agent is a truncated sign request -
 * it can only ever answer FAILURE (a probe therefore never risks a signature)
 * - and the second candidate (byte 11) then names 10.x positively. No
 * resolution ever rests on a guess: an agent that positively answers neither
 * candidate resolves to nothing, and the session refuses everything.
 *
 * The parsing and scoping helpers here are the wire grammar itself: the
 * per-scheme IDENTITIES_ANSWER filter, and SIGN_REQUEST bodies in both the
 * classic (blob, data, flags) and the extended 10.x (trailing `string
 * algorithms`) form. Task 11 (`ssh_agent_identities`) reuses
 * {@link fingerprintAgentBlob} and {@link parseIdentitiesAnswer}: the
 * fingerprint spelling defined here IS the grant-matching grammar (§5.4).
 */

/** One agent request/response numbering: the four codepoints plus the body grammar. */
export interface AgentScheme {
  /** Stable short name for log lines and tests; never user data. */
  name: "openssh-10x" | "classic";
  /** SSH2_AGENTC_REQUEST_IDENTITIES: the roster request byte (one byte, no body). */
  identities: number;
  /** SSH2_AGENT_IDENTITIES_ANSWER: the roster response byte this session's answers carry. */
  answer: number;
  /** SSH2_AGENTC_SIGN_REQUEST: the codepoint whose body MUST be fingerprint-scoped before any forward. */
  sign: number;
  /** SSH2_AGENT_SIGN_RESPONSE: the signature reply byte, otherwise opaque. */
  signResponse: number;
  /** Whether SIGN_REQUEST bodies may carry the trailing `string algorithms` (RFC 9987 extended grammar). */
  extendedSign: boolean;
}

/**
 * The RFC 9987 numbering OpenSSH 10.x ships (measured OpenSSH_10.2p1: an 11
 * answers 12; a 13 answers 5 because it is a truncated sign; a 15 is unknown
 * and answers 5). Sign bodies carry the extended grammar.
 */
export const OPENSSH_10X_SCHEME: AgentScheme = {
  name: "openssh-10x",
  identities: 11,
  answer: 12,
  sign: 13,
  signResponse: 14,
  extendedSign: true,
};

/**
 * OpenSSH's classic numbering from `agent-proto.h` (identities 13 / answer 14
 * / sign 15 / sign response 16), the scheme pre-10.x agents and every other
 * ssh-agent implementation in the field speak. Sign bodies are blob+data+
 * flags only.
 */
export const CLASSIC_SCHEME: AgentScheme = {
  name: "classic",
  identities: 13,
  answer: 14,
  sign: 15,
  signResponse: 16,
  extendedSign: false,
};

/** `SSH2_AGENT_FAILURE`: the uniform refusal, the same 5 in BOTH schemes (measured). */
export const SSH2_AGENT_FAILURE = 5;

/** The probe order: the classic candidate first, so a classic agent resolves in ONE round trip. */
const PROBE_CANDIDATES: readonly AgentScheme[] = [CLASSIC_SCHEME, OPENSSH_10X_SCHEME];

/** One framed round trip to a live agent socket (the `requestLiveAgent` shape). */
export type AgentRequestFn = (socketPath: string, payload: Buffer) => Promise<Buffer>;

/* ------------------------------------------------------------------ */
/* the wire codec (shared shape with the B proxy; A-side parsing)     */
/* ------------------------------------------------------------------ */

/** A cursor over an agent payload; every read past the end throws (never a silent partial parse). */
class ByteReader {
  #buf: Buffer;
  #off = 0;

  constructor(buf: Buffer) {
    this.#buf = buf;
  }

  u32(): number {
    if (this.#off + 4 > this.#buf.length) throw new Error("agent wire: truncated uint32");
    const v = this.#buf.readUInt32BE(this.#off);
    this.#off += 4;
    return v;
  }

  bytes(n: number): Buffer {
    if (n > this.#buf.length - this.#off) throw new Error("agent wire: truncated byte run");
    const v = this.#buf.subarray(this.#off, this.#off + n);
    this.#off += n;
    return v;
  }

  /** An SSH string: uint32 length + bytes. */
  string(): Buffer {
    return this.bytes(this.u32());
  }

  done(): boolean {
    return this.#off === this.#buf.length;
  }
}

/** Serialize an SSH string: uint32 length + bytes. */
function sshString(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

/* ------------------------------------------------------------------ */
/* the fingerprint grammar (§5.4: the ONLY spelling grants match on)   */
/* ------------------------------------------------------------------ */

/**
 * The OpenSSH display fingerprint of one agent key blob: SHA-256 over the
 * RAW SSH wire encoding (the agent-answer blob bytes), spelled `SHA256:` +
 * base64url without padding - the same scheme `fingerprintJwk` established
 * (§4.5: "Agent keys hash their agent wire encoding"; §5.4), which is also
 * the only spelling the selection grammar's `SSH_FINGERPRINT_RE` accepts.
 *
 * The base64url spelling is DELIBERATELY internal and differs from what
 * `ssh-keygen -l` prints (standard base64: different alphabet, padding):
 * these fingerprints are compared ONLY against this spelling (grant rows,
 * roster answers, selection scoping), never against ssh-keygen output, and
 * the UI never invites that cross-comparison (the out-of-band comparison
 * story is about machine keys on the trust card, §4.6). Do NOT "normalize"
 * this to standard base64: stored grant fingerprints are these strings, and
 * a silent alphabet swap would invalidate every standing grant.
 */
export function fingerprintAgentBlob(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64url")}`;
}

/* ------------------------------------------------------------------ */
/* IDENTITIES_ANSWER: parse, then scope                               */
/* ------------------------------------------------------------------ */

/** One roster entry as the agent answer carries it. */
export interface AgentIdentity {
  /** The public key blob, byte-exact from the wire (its fingerprint scopes it). */
  blob: Buffer;
  /** The operator's label; rides through, never parsed. */
  comment: Buffer;
}

/**
 * Parse an IDENTITIES_ANSWER in the RESOLVED scheme: the type byte must be
 * THAT scheme's answer codepoint (byte 14 answers an agent that speaks
 * classic, and is a foreign SIGN_RESPONSE to one that speaks 10.x), and the
 * declared entries must be all there and nothing more. Throws on anything
 * else - an unparseable roster is refused by the caller, NEVER forwarded,
 * because a partial parse of the roster is exactly what §5.4 exists to
 * prevent.
 */
export function parseIdentitiesAnswer(answer: Buffer, scheme: AgentScheme): AgentIdentity[] {
  if (answer.length < 5 || answer[0] !== scheme.answer) {
    throw new Error(`relay agent wire: expected a ${scheme.name} IDENTITIES_ANSWER (${scheme.answer})`);
  }
  const reader = new ByteReader(answer.subarray(1));
  const count = reader.u32();
  const entries: AgentIdentity[] = [];
  for (let i = 0; i < count; i += 1) {
    const blob = reader.string();
    const comment = reader.string();
    entries.push({ blob, comment });
  }
  if (!reader.done()) throw new Error("relay agent wire: IDENTITIES_ANSWER carries trailing bytes");
  return entries;
}

/**
 * Rebuild an IDENTITIES_ANSWER keeping ONLY the entries whose blob
 * fingerprints into `allowed`; fixes the count; kept entries ride byte-
 * identically and are re-headed with the RESOLVED scheme's answer byte.
 * Throws on a malformed answer (see {@link parseIdentitiesAnswer}).
 */
export function filterIdentitiesAnswer(answer: Buffer, allowed: ReadonlySet<string>, scheme: AgentScheme): Buffer {
  const kept = parseIdentitiesAnswer(answer, scheme)
    .filter((entry) => allowed.has(fingerprintAgentBlob(entry.blob)))
    .map((entry) => Buffer.concat([sshString(entry.blob), sshString(entry.comment)]));
  const count = Buffer.alloc(4);
  count.writeUInt32BE(kept.length, 0);
  return Buffer.concat([Buffer.from([scheme.answer]), count, ...kept]);
}

/* ------------------------------------------------------------------ */
/* SIGN_REQUEST: the body the fingerprint scope reads                  */
/* ------------------------------------------------------------------ */

/** The parsed fields of a well-formed SIGN_REQUEST body (only `keyBlob` scopes; the rest ride through). */
export interface SignRequestBody {
  /** The target key blob: its {@link fingerprintAgentBlob} decides the forward (it MUST be checked before any). */
  keyBlob: Buffer;
  /** The bytes to be signed; unexamined, forwarded inside the untouched request bytes. */
  data: Buffer;
  /** Request flags; unexamined (§5.4 scopes by BLOB, not by flag). */
  flags: number;
  /** The RFC 9987 extended grammar's trailing `string algorithms`; present only under the extended scheme. */
  algorithms?: Buffer;
}

/**
 * Split a SIGN_REQUEST (full payload, type byte included) into its fields.
 * The wire grammar is blob, data, flags - in BOTH schemes - and the extended
 * 10.x scheme additionally allows one well-formed trailing `string
 * algorithms`. Anything else (missing fields, truncated strings, an empty
 * blob, a classic body with trailing bytes, junk after the algorithms string)
 * throws: a malformed body is refused, never forwarded.
 */
export function parseSignRequest(payload: Buffer, scheme: AgentScheme): SignRequestBody {
  const reader = new ByteReader(payload.subarray(1));
  const keyBlob = reader.string();
  const data = reader.string();
  const flags = reader.u32();
  if (keyBlob.length === 0) throw new Error("relay agent wire: SIGN_REQUEST names an empty key blob");
  if (reader.done()) return { keyBlob, data, flags };
  if (!scheme.extendedSign) throw new Error("relay agent wire: classic SIGN_REQUEST carries trailing bytes");
  const algorithms = reader.string();
  if (!reader.done()) throw new Error("relay agent wire: SIGN_REQUEST carries bytes after the algorithms string");
  return { keyBlob, data, flags, algorithms };
}

/* ------------------------------------------------------------------ */
/* SIGN_RESPONSE: the answer body the relay gate accepts               */
/* ------------------------------------------------------------------ */

/**
 * Strictly parse a SIGN_RESPONSE (full payload, type byte included): the type
 * byte must be THAT scheme's sign-response codepoint and the body must be
 * exactly one `string` (the signature blob) with nothing after it. Throws
 * otherwise. The type byte ALONE is not enough: the codepoints collide across
 * schemes (classic's roster answer is 14, which is 10.x's sign response), so
 * only the body tells a signature from a foreign scheme's roster.
 */
export function parseSignResponse(response: Buffer, scheme: AgentScheme): Buffer {
  if (response.length < 5 || response[0] !== scheme.signResponse) {
    throw new Error(`relay agent wire: expected a ${scheme.name} SIGN_RESPONSE (${scheme.signResponse})`);
  }
  const reader = new ByteReader(response.subarray(1));
  const signature = reader.string();
  if (!reader.done()) throw new Error("relay agent wire: SIGN_RESPONSE carries bytes after the signature string");
  return signature;
}

/* ------------------------------------------------------------------ */
/* the probe (ruling 2026-10-08: the numbering is learned, never assumed) */
/* ------------------------------------------------------------------ */

/** Whether `answer` is a VALID IDENTITIES_ANSWER in `scheme` (positive confirmation, nothing weaker). */
function isIdentitiesAnswer(answer: Buffer, scheme: AgentScheme): boolean {
  if (answer.length === 0 || answer[0] !== scheme.answer) return false;
  try {
    parseIdentitiesAnswer(answer, scheme);
    return true;
  } catch {
    return false;
  }
}

/**
 * Learn which numbering the live agent speaks: send each candidate's
 * one-byte identities request in turn (classic's 13 first, so a classic agent
 * resolves in a single round trip) and demand a VALID IDENTITIES_ANSWER in
 * that candidate's own answer byte to name it. A 10.x agent reads the byte-13
 * candidate as a truncated sign request and answers FAILURE(5) - the probe
 * sends only one-byte requests, so it can never ask for a signature - then
 * the byte-11 candidate answers a valid 12 and names the scheme positively.
 * An agent that answers neither resolves to NULL: the caller must refuse
 * every request, because a byte under a GUESSED scheme is the bug this
 * ruling exists to kill.
 */
export async function probeAgentScheme(socketPath: string, requestAgent: AgentRequestFn): Promise<AgentScheme | null> {
  for (const candidate of PROBE_CANDIDATES) {
    let answer: Buffer;
    try {
      answer = await requestAgent(socketPath, Buffer.from([candidate.identities]));
    } catch {
      continue; // this candidate got no answer: try the next before giving up
    }
    if (isIdentitiesAnswer(answer, candidate)) return candidate;
  }
  return null;
}

import {
  NODE_CLOSE_HANDSHAKE_REQUIRED,
  NODE_PROTOCOL_VERSION,
  nodeVersionSupported,
  parseNodeEvent,
} from "@internal/subshell-protocol";
import {
  createServerSession,
  ensureSodium,
  type LinkKeyPair,
  type LinkSession,
  parseKxFrame,
  parseLinkBinding,
  parseRegisterFrame,
  type Sodium,
} from "@internal/subshell-protocol/node-link-crypto";
import type { NodeTable } from "@/db/types/nodes.db-types.js";

/**
 * The `/ws/node` link handshake state machine — spec 2026-09-24 §4/§5/§6.
 *
 * PURE POLICY, per socket and per row: given the classification the row
 * received at upgrade ({@link beginLinkUpgrade}) and the frame the socket
 * just produced, decide what may happen. It writes no bytes and never closes
 * a socket itself — every decision comes back as a {@link LinkOutcome} for
 * Task 8's handler to execute (send / forward / close / hold). That split is
 * what keeps this file testable without an HTTP layer, and it is the same
 * seam `node-ws-handler.ts` keeps from the Elysia plugin.
 *
 * **The handshake has no server plaintext reply (ruling R6).** `crypto_kx`
 * is a SINGLE DH — the node's fresh ephemeral against the server's long-term
 * static — and the node already holds the server's pinned public half from
 * enroll, so it derives its side the moment IT sends `eph`; the server has no
 * ephemeral to hand back. A correct `kx` is therefore consumed in silence and
 * the node's next frame is already ciphertext: the encrypted binding. The
 * server's first push on the link is the encrypted `{t:"ok"}` that ends the
 * handshake.
 *
 * **A v14 socket never runs on plaintext once classified (spec §6).** Any
 * wrong-kind frame at the wrong phase closes 4410 rather than being dropped —
 * a dropped frame would leave a downgrade attempt half-satisfied, and the
 * stream has no resync to fall back to (a failed `openFrame` means the link
 * is dead, not mis-framed).
 *
 * **The legacy path is spec §5's self-heal**, and it is the one place a
 * decision is not the machine's to finish: `register` writes the row's pin
 * and answers `register-ok`, then the SOCKET closes normally (ruling R7 — the
 * close is not a 4410; the agent reconnects encrypted and the fresh socket is
 * classified `handshake` by the pin it just wrote). A legacy row may never
 * accept a `ready` that passes both gates (ledger ruling R3): a v14 agent
 * with no pin has exactly one legitimate first frame, so a plain-text `ready`
 * wearing 14 is the downgrade attempt, and the machine reports it as
 * `{ holdEncryptionRequired: true }` for Task 8 to hold with that reason
 * (the hold itself, and the `HeldReason` union that names it, are Task 8's).
 *
 * The byte caps are NOT this file's business: the handler's `frameBytes`
 * pre-caps the raw frame (ruling R2 — binary measures natively), and the
 * post-decrypt cap runs on `forwarded` inside the handler. Ciphertext is
 * plaintext + 17B (`crypto_secretstream_ABYTES`), so no second constant is
 * needed and the machine must not size-reject anything itself.
 */

/** What the row's state says about the socket, decided at upgrade time. */
export type LinkMode = "handshake" | "legacy";

/** Where a handshake-mode socket stands. Legacy sockets never enter phases. */
export type LinkPhase = "awaiting-kx" | "awaiting-binding" | "established";

/**
 * The per-socket scratch this machine reads and writes, living on the shared
 * `ws.data` object (Elysia builds a fresh wrapper per event — see
 * `node-ws-handler.ts`'s own note at `frameQueue`). Task 8 stashes `nodeId`,
 * `apiKeyId` (both already stashed by the upgrade chain), and the row's pin +
 * mode from {@link beginLinkUpgrade}; the phase and session are this file's.
 * NO raw node key ever lives here: the plane stores only better-auth's hash,
 * so the binding re-prove re-RUNS `verifyApiKey` instead of a plaintext
 * compare (spec §4 step 4) — a raw `===` is not merely discouraged, it is
 * impossible.
 */
export interface LinkWsData {
  /** Node row id the upgrade's bearer verification resolved (re-prove target) */
  nodeId?: string;
  /** api-key row id the node row binds — the identity the re-prove compares */
  apiKeyId?: string;
  /** Classification stashed at upgrade from {@link beginLinkUpgrade} */
  linkMode?: LinkMode;
  /** The row's pinned node static (canonical base64) at upgrade; handshake mode only */
  linkEncryptPublicKey?: string | null;
  /** Handshake progress. An absent phase is `awaiting-kx`. @internal machine-owned */
  linkPhase?: LinkPhase;
  /** Derived session once `kx` is accepted; the phase says which key owns it. @internal machine-owned */
  linkSession?: LinkSession;
}

/** The minimal socket surface the machine needs: the shared data object. */
export interface LinkWs {
  data: LinkWsData;
}

/**
 * An inbound frame as the handler delivers it. `text` is Elysia's plaintext
 * form — the raw string, or the object Elysia JSON-parsed from it; `bytes` is
 * a binary frame (Buffer is a Uint8Array).
 */
export type LinkFrame = { text: string | object } | { bytes: Uint8Array };

/**
 * The decision. Task 8 executes; nothing here sends, forwards or closes.
 *
 * - `{ consumed }` — the frame advanced the machine; emit nothing (the R6
 *   step: a correct `kx` earns silence, the node's next frame is ciphertext).
 * - `{ consumed, established, sendBytes }` — the handshake just completed:
 *   `sendBytes` is the server's FIRST push, the sealed `{"t":"ok"}` (it
 *   carries the 24B secretstream header), to be sent as a binary frame;
 *   `established` is the live session for Task 8 to key its send path on.
 * - `{ forwarded }` — plaintext for the existing `parseNodeEvent` + gates
 *   path. From an established link this is the DECRYPTED string (the post-
 *   decrypt byte cap runs on it in the handler); from a legacy socket it is
 *   the frame as it arrived, legacy bytes included — binary there is what
 *   binary on a plaintext socket always was: dropped as unrecognized.
 * - `{ holdEncryptionRequired }` — ledger R3: a legacy row received a
 *   plaintext `ready` that WOULD pass both gates. Task 8 holds it DIRECTLY
 *   with `holdRefusedNode` under the new `"encryption-required"` reason —
 *   `applyReady` NEVER runs on a would-pass legacy `ready`, precisely so a
 *   downgrade's self-claimed identity is never stamped onto the row. (A
 *   below-floor or protocol-mismatch `ready` on the same socket is FORWARDED
 *   and keeps its existing `applyReady` + hold path unchanged.) The machine
 *   does not write or hold anything itself.
 * - `{ close }` — refuse the socket with `code` (4410 here) and a reason the
 *   agent relays to its own log (spec §6).
 * - `{ sendText, thenClose }` — ruling R7, the legacy register answer: send
 *   this ONE plaintext frame, then close the socket NORMALLY (not 4410). The
 *   agent reconnects encrypted; do not handshake on the same socket (§5).
 */
export type LinkOutcome =
  | { consumed: true }
  | { consumed: true; established: LinkSession; sendBytes: Uint8Array }
  | { forwarded: string | object }
  | { holdEncryptionRequired: true }
  | { close: { code: number; reason: string } }
  | { sendText: string; thenClose: true };

/**
 * Everything the machine reaches outside itself. The production wiring is
 * Task 8's: `verifyApiKey` is the SAME function `NodeWsDeps` carries (its
 * return shape mirrors `NodeVerifiedKey` exactly so the handler's own
 * implementation is assignable unchanged), the keypair pair comes from
 * `node-encryption-keys.ts`, and `setEncryptPublicKey` from the nodes
 * repository.
 */
export interface LinkSessionDeps {
  /**
   * Re-run of the bearer verification: resolve a raw node key to its api-key
   * row, or null. better-auth hashes internally — the plane never holds the
   * plaintext key, which is why the re-prove asks THIS and never compares
   * strings. (Like the upgrade's call, this may bump the row's
   * lastVerified-timestamp; the upgrade already called it once, and a second
   * idempotent touch inside one connection is accepted.)
   */
  verifyApiKey(rawKey: string): Promise<{ id: string; metadata: Record<string, unknown> | null } | null>;
  /** The server's static link keypair (generate-once, 0600 on disk) */
  loadNodeEncryptionKeys(): Promise<LinkKeyPair>;
  /** Pin a legacy row's claimed node static (canonical base64) — spec §5 */
  setEncryptPublicKey(id: string, key: string): Promise<void>;
  /** The server's public half, for the `register-ok` answer */
  nodeEncryptionPublicKey(): Promise<string>;
}

/**
 * How long a classified-but-incomplete handshake may hold a socket open
 * before the handler closes it with 4410 (spec §6's close-without-resync: a
 * socket that opens and says nothing is refused, not waited on forever).
 * **Arming the timer is Task 8's job** (it owns the socket); this module only
 * answers {@link handshakeIncomplete}.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Classify a row at upgrade time: a pinned row must handshake, a pin-less row
 * is legacy. Task 8 stashes the result (plus `nodeId`, `apiKeyId` and the
 * row's pin) on `ws.data`.
 */
export function beginLinkUpgrade(
  node: Pick<NodeTable, "encryptPublicKey">,
): { mode: "handshake" } | { mode: "legacy" } {
  return node.encryptPublicKey !== null ? { mode: "handshake" } : { mode: "legacy" };
}

/**
 * Whether a socket's handshake is still open — the predicate Task 8's timer
 * re-checks when it fires (a socket that established in the meantime must not
 * be closed by a stale deadline).
 */
export function handshakeIncomplete(data: LinkWsData): boolean {
  return data.linkMode === "handshake" && data.linkPhase !== "established";
}

/**
 * The per-frame decision. Wire input never throws: every refusal is a
 * {@link LinkOutcome}. Throws are reserved for IMPOSSIBLE states that name a
 * wiring bug (no `nodeId`, no classification, a phase without its session) —
 * the same doctrine as `assertNodePathId`: they indicate the upgrade chain
 * did not run, and the socket must not be trusted to keep going.
 */
export async function handleLinkFrame(deps: LinkSessionDeps, ws: LinkWs, frame: LinkFrame): Promise<LinkOutcome> {
  const data = ws.data;
  const nodeId = data.nodeId;
  if (!nodeId) throw new Error("link-session: socket has no authenticated nodeId");
  if (data.linkMode === "handshake") return handleHandshakeFrame(deps, data, nodeId, frame);
  if (data.linkMode === "legacy") return handleLegacyFrame(deps, nodeId, frame);
  throw new Error("link-session: socket never classified (beginLinkUpgrade did not run at upgrade)");
}

/* ------------------------------------------------------------------ */
/* handshake mode                                                      */
/* ------------------------------------------------------------------ */

async function handleHandshakeFrame(
  deps: LinkSessionDeps,
  data: LinkWsData,
  nodeId: string,
  frame: LinkFrame,
): Promise<LinkOutcome> {
  // An absent phase is the socket's first frame.
  if ((data.linkPhase ?? "awaiting-kx") === "awaiting-kx") {
    if ("bytes" in frame) return refuse("unexpected frame: ciphertext before kx");
    return acceptKx(deps, data, frame.text);
  }
  if (data.linkPhase === "awaiting-binding") {
    if (!("bytes" in frame)) return refuse("unexpected frame: plaintext before the binding");
    return completeBinding(deps, data, nodeId, frame.bytes);
  }
  // established: ciphertext only, and a failed open means the link is DEAD.
  if ("bytes" in frame) {
    const session = requireSession(data);
    const plaintext = session.openFrame(frame.bytes);
    if (plaintext === null) return refuse("ciphertext undecryptable — the link stream is dead, never resync");
    return { forwarded: plaintext };
  }
  return refuse("unexpected frame: plaintext on an established link");
}

/**
 * The `kx` step (spec §4 steps 2–3): shape, then 32-byte decodes, then the
 * pin compare — and ONLY then derivation. The pin compare is
 * `sodium_memcmp` (`sodium.sodium_memcmp` / the wrapper's `memcmp`) over the
 * DECODED bytes: constant time, and equal-only-on-true-equality. A mismatch
 * must never reach `createServerSession`, so the derivation sits behind the
 * compare AND behind `loadNodeEncryptionKeys()` — the only call site of the
 * former is after the await of the latter, which is what the test's
 * load-spy asserts.
 *
 * On success: NO reply is emitted (ruling R6 — a single-DH kx gives the
 * server nothing to hand back, and the node needs nothing); the next inbound
 * frame must be the encrypted binding.
 */
async function acceptKx(deps: LinkSessionDeps, data: LinkWsData, raw: string | object): Promise<LinkOutcome> {
  const kx = parseKxFrame(parseJson(raw));
  // `pub` is optional on the wire type only because the server's legacy
  // register carries it instead; on a handshake socket the claim is mandatory
  // — without it there is no long-term identity to pin the link to.
  if (!kx || kx.pub === undefined) return refuse("handshake required: expected a kx frame");
  const s = await ensureSodium();
  const eph = decode32(s, kx.eph);
  if (!eph) return refuse("handshake refused: kx eph must decode to 32 bytes");
  const pub = decode32(s, kx.pub);
  if (!pub) return refuse("handshake refused: kx pub must decode to 32 bytes");
  const pinned =
    data.linkEncryptPublicKey === null || data.linkEncryptPublicKey === undefined
      ? undefined
      : decode32(s, data.linkEncryptPublicKey);
  if (!pinned) return refuse("handshake refused: the row's encryption pin is missing or malformed");
  // memcmp throws on unequal lengths — both sides are 32 bytes by the checks
  // above, so the call below is the library's own guarantee, not a guard.
  if (!s.memcmp(pub, pinned)) return refuse("handshake refused: pub mismatch");

  // A throwing keypair load is INFRASTRUCTURE (a corrupt 0600 file refuses to
  // rotate — see node-encryption-keys.ts), not a wire refusal: let it
  // propagate to the handler's own error path and the socket's timeout.
  const serverStatic = await deps.loadNodeEncryptionKeys();
  let session: LinkSession;
  try {
    session = await createServerSession({ serverStatic, clientEphemeralPublicKey: kx.eph });
  } catch {
    // Belt on the eph checks above: the library validated the same bytes
    // independently and did not like them.
    return refuse("handshake refused: kx ephemeral unusable");
  }
  data.linkSession = session;
  data.linkPhase = "awaiting-binding";
  return { consumed: true };
}

/**
 * The binding step (spec §4 step 4): decrypt, parse, then the THREE checks —
 * the claimed nodeId against the bearer's row, the nodeKey re-proved through
 * the upgrade's OWN verification chain, and the protocol exact-match. Each
 * refusal names which check failed, per the two-gates doctrine: a refusal
 * that could be one of five things is a refusal nobody can act on.
 */
async function completeBinding(
  deps: LinkSessionDeps,
  data: LinkWsData,
  nodeId: string,
  bytes: Uint8Array,
): Promise<LinkOutcome> {
  const session = requireSession(data);
  const plaintext = session.openFrame(bytes);
  if (plaintext === null) return refuse("handshake refused: binding undecryptable");
  const binding = parseLinkBinding(parseJson(plaintext));
  if (!binding) return refuse("handshake refused: binding malformed");
  if (binding.nodeId !== nodeId) {
    return refuse("handshake refused: binding nodeId names a different row");
  }
  const reProve = await reProveNodeKey(deps, data, binding.nodeKey);
  if (reProve) return reProve;
  if (binding.protocolVersion !== NODE_PROTOCOL_VERSION) {
    return refuse(
      `handshake refused: protocol mismatch (node ${binding.protocolVersion}, server ${NODE_PROTOCOL_VERSION})`,
    );
  }
  const sendBytes = session.sealFrame(JSON.stringify({ t: "ok" }));
  data.linkPhase = "established";
  return { consumed: true, established: session, sendBytes };
}

/**
 * Spec §4 step 4's "verify the key by hash compare", resolved EXACTLY as the
 * upgrade runs it — better-auth hashes internally, the plane holds no
 * plaintext, so this re-RUNS `verifyApiKey` and re-checks the same two links
 * the upgrade chain checked (`authenticateNodeUpgrade`: metadata
 * kind/nodeId is the identity claim, `node.apiKeyId === row.id` is the
 * binding claim — here `v.id === data.apiKeyId`). The binding therefore
 * proves, INSIDE the encrypted channel, that the socket carries the same
 * live credential the upgrade authenticated; a valid key from another row
 * fails exactly as a dead key does.
 */
async function reProveNodeKey(deps: LinkSessionDeps, data: LinkWsData, nodeKey: string): Promise<LinkOutcome | null> {
  const row = await deps.verifyApiKey(nodeKey);
  if (!row) return refuse("handshake refused: binding nodeKey is not a live node key");
  const meta = row.metadata;
  if (meta?.kind !== "node" || meta.nodeId !== data.nodeId || row.id !== data.apiKeyId) {
    return refuse("handshake refused: binding nodeKey re-proves to a different row");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* legacy mode (spec §5 + ledger R3)                                   */
/* ------------------------------------------------------------------ */

async function handleLegacyFrame(deps: LinkSessionDeps, nodeId: string, frame: LinkFrame): Promise<LinkOutcome> {
  if ("bytes" in frame) {
    // A row with no pin has no stream to open. Hand the frame to the existing
    // path — a v13-era agent never sends binary, and anything that does gets
    // dropped as unrecognized exactly as it is today. R10 needs NO refusal
    // here: a provisioned agent's sealed binding can only arrive AFTER its
    // `kx`, and the text claim below closes the socket first.
    return { forwarded: frame.bytes };
  }
  if (isRegisterClaim(frame.text)) return acceptRegister(deps, nodeId, frame.text);
  // R10: a real `kx` CLAIM (same shape gate the handshake path uses —
  // parseKxFrame over the parsed frame, eph AND pub present) on a pin-less row
  // is the post-rotation redial, or its lookalike: the agent's config kept
  // both link fields while key rotation cleared the row's pin
  // (rotate-node-key.route.ts step 2), so it dials handshake mode at a row
  // that no longer holds its identity. Forwarded, this was a silent permanent
  // stall — no ack, no deadline on either end, no register, a socket open and
  // saying nothing. Refused, the agent's own non-terminal-4410 loop relays
  // the remedy to its log. A refusal, deliberately NOT a hold: pairing is a
  // handshake between the two endpoints, not an admin surface, and fail
  // closed is this machine's whole doctrine. A frame the shape gate rejects
  // (no eph, eph not base64-shaped, no pub) is junk and stays forwarded —
  // the refusal is for claims, not for anyone who typed `"t":"kx"`.
  const claim = parseKxFrame(parseJson(frame.text));
  if (claim && claim.pub !== undefined) {
    return refuse("legacy row received a kx claim — re-pair via register");
  }
  // R3: the row's lack of a pin is not evidence it may run. A ready that
  // WOULD pass both gates on this socket is the downgrade attempt spec §4's
  // properties call out, and the hold for it is a NEW reason only Task 8's
  // HeldReason union can name (ledger R3 — that edit belongs there).
  const event = parseNodeEvent(frame.text);
  if (
    event?.type === "ready" &&
    nodeVersionSupported(event.agentVersion) &&
    event.protocolVersion === NODE_PROTOCOL_VERSION
  ) {
    return { holdEncryptionRequired: true };
  }
  // Everything else — including a below-floor or protocol-mismatched ready —
  // belongs to the existing gates and hold path unchanged.
  return { forwarded: frame.text };
}

/**
 * The §5 self-heal: an authenticated `{t:"register", pub}` (the bearer key IS
 * the trust root — it authenticates every legacy frame already) commits the
 * node's long-term static to its row. The stored value goes through the same
 * canonical re-encode as enroll (`enroll.route.ts`: `to_base64(from_base64(·))`),
 * so the pin is always in the exact spelling the handshake's byte comparison
 * will see. Then R7: one plaintext `register-ok`, then a NORMAL close — the
 * agent reconnects and the row's fresh pin classifies that socket handshake.
 */
async function acceptRegister(deps: LinkSessionDeps, nodeId: string, raw: string | object): Promise<LinkOutcome> {
  const register = parseRegisterFrame(parseJson(raw));
  if (!register) return refuse("register frame malformed");
  const s = await ensureSodium();
  const pub = decode32(s, register.pub);
  if (!pub) return refuse("register refused: pub must decode to 32 bytes (an X25519 public key)");
  await deps.setEncryptPublicKey(nodeId, s.to_base64(pub));
  const controlEncryptPublicKey = await deps.nodeEncryptionPublicKey();
  return {
    sendText: JSON.stringify({ t: "register-ok", controlEncryptPublicKey }),
    thenClose: true,
  };
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function refuse(reason: string): LinkOutcome {
  return { close: { code: NODE_CLOSE_HANDSHAKE_REQUIRED, reason } };
}

function requireSession(data: LinkWsData): LinkSession {
  const session = data.linkSession;
  if (!session) throw new Error("link-session: phase has no stashed session (impossible state)");
  return session;
}

/** JSON.parse for wire strings; an unparseable string is `undefined`, never a throw. */
function parseJson(raw: string | object): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Decode a base64 key and enforce its byte length; junk or a wrong length is undefined. */
function decode32(s: Sodium, value: string): Uint8Array | undefined {
  try {
    const decoded = s.from_base64(value);
    return decoded.length === 32 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this plaintext frame CLAIMS to be a register (before any validation of it). */
function isRegisterClaim(raw: string | object): boolean {
  const value = parseJson(raw);
  return typeof value === "object" && value !== null && (value as { t?: unknown }).t === "register";
}

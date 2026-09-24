/**
 * The /ws/node link encryption primitives — spec 2026-09-24 §2.
 *
 * Two official libsodium constructions do every cryptographic act here, and
 * this module adds NO protocol logic beyond choosing them and serializing:
 *
 * - `crypto_kx_*_session_keys`: a one-round key exchange. ONE X25519 DH — the
 *   node's FRESH per-connection ephemeral with the server's LONG-TERM static —
 *   plus a hash binding of both public keys (BLAKE2b-512 over
 *   `dh || client_pk || server_pk`, first half = client's receive key, second
 *   half = client's send key; the server gets the mirror). The server's static
 *   is pinned per node as `controlEncryptPublicKey`; the node's own static is
 *   NEVER DH'd — it arrives as a CLAIM in the handshake frame, compared against
 *   the row's `encryptPublicKey` BEFORE any derivation (spec §4 step 3), and
 *   the node's identity is the bearer key carried in the encrypted binding
 *   payload (spec §4 step 4). Server authentication falls out of the single
 *   DH: only a holder of the server static derives keys that make the node's
 *   first ciphertext decryptable. Forward secrecy is the ephemeral's job; its
 *   private half is dropped here at derivation and kept nowhere.
 * - `crypto_secretstream_xchacha20poly1305`: a ratcheting authenticated
 *   byte stream. Per-message rekey is the library's construction, not a
 *   schedule of ours; a tampered message makes `pull` fail, which `openFrame`
 *   reports as `null` — the CALLER's job is to never resync a failed stream
 *   (spec §6: the stream's integrity is the contract).
 *
 * Pure JS/WASM by design (no `node:` imports), so a consumer CAN barrel it —
 * but it is a SUBPATH export (spec §2's Bun-support note; the wire.ts /
 * release-signature precedent): mobile imports the barrel and never needs
 * this, and WASM weight should not ride a barrel it cannot use.
 *
 * Base64 (libsodium's `to_base64`, the standard alphabet) is the on-file and
 * on-text-frame encoding for every key here — consistent with how the rest of
 * the link serializes (JWK JSON strings); binary frames themselves are raw
 * bytes, never base64.
 *
 * The wiring direction is the part a reader must NOT "fix" from intuition:
 * libsodium-wrappers' `sharedRx`/`sharedTx` names are faithful to the C
 * `rx`/`tx` arguments (measured against the key schedule in
 * `__tests__/node-link-crypto.test.ts`), so on BOTH ends `sealFrame` uses the
 * session's own `sharedTx` and `openFrame` its own `sharedRx`. The symmetry
 * that reads as swapped — the server's receive key equals the client's send
 * key, and its send key the client's receive key — is the whole point of kx.
 */
import _sodium from "libsodium-wrappers-sumo";
import { BASE64_RE, isInt, isRecord, isStr } from "./guards.js";

/** The ready libsodium handle. Tasks 7/9 need `from_base64` for frame-field length checks. */
export type Sodium = typeof _sodium;

let sodium: Sodium | undefined;

/**
 * Awaiting this is cheap after the first call (the WASM's own `ready` promise,
 * memoized here); every other export in this module calls it, so consumers
 * await it only when they want the handle itself.
 */
export async function ensureSodium(): Promise<Sodium> {
  if (!sodium) {
    await _sodium.ready;
    sodium = _sodium;
  }
  return sodium;
}

/** A link keypair, base64-encoded (each half decodes to 32 bytes). */
export type LinkKeyPair = { publicKey: string; privateKey: string };

/** A live encrypted link: seal outbound frames, open inbound ones. */
export interface LinkSession {
  /**
   * Seal one outbound frame. The FIRST output carries the 24-byte
   * secretstream header prefixed (the receiving end needs it exactly once to
   * initialize its pull state); later outputs are bare ciphertext.
   */
  sealFrame(plaintext: string): Uint8Array;
  /**
   * Open one inbound frame, splitting the header from the first. Returns
   * `null` on any authentication or parse failure — never throws for
   * adversary input. A `null` here means the stream is dead: the caller
   * closes the link (spec §6), because resyncing a ratcheted stream on
   * attacker-chosen bytes is not a recovery.
   */
  openFrame(ciphertext: Uint8Array): string | null;
}

/**
 * `crypto_secretstream_xchacha20poly1305`'s header length (measured against
 * the library constant by test): the nonce-plus-cipher-suite blob `init_push`
 * hands back and `init_pull` consumes.
 */
export const LINK_HEADER_BYTES = 24;

/** The library's push/pull state handles, as its own types name them. */
type SecretstreamState = ReturnType<Sodium["crypto_secretstream_xchacha20poly1305_init_pull"]>;

/** Decode a base64 key and enforce its byte length; a wrong-length key is a programmer error, not wire input. */
function decodeKey(s: Sodium, value: string, label: string): Uint8Array {
  const decoded = s.from_base64(value);
  if (decoded.length !== 32) {
    throw new Error(`${label} must decode to 32 base64 bytes, got ${decoded.length}`);
  }
  return decoded;
}

/**
 * A session from the two derived keys. Send/receive are positional here
 * because the kx calls' `sharedTx`/`sharedRx` naming is C-faithful and the
 * caller maps them (see the module header); everything about direction beyond
 * this point is the library's.
 */
function buildSession(s: Sodium, sendKey: Uint8Array, receiveKey: Uint8Array): LinkSession {
  // Push state is created lazily on the first seal — the session constructor
  // must not spend the ratchet's starting point for a link that seals nothing.
  let pushState: SecretstreamState | undefined;
  // Non-null exactly while the header still rides the next frame: one
  // assignment on init, one on the frame that consumes it.
  let pushHeader: Uint8Array | undefined;
  // Pull state CANNOT be created eagerly: it needs the peer's header, which
  // only arrives with the first inbound frame.
  let pullState: SecretstreamState | undefined;

  return {
    sealFrame(plaintext: string): Uint8Array {
      if (!pushState) {
        const init = s.crypto_secretstream_xchacha20poly1305_init_push(sendKey);
        pushState = init.state;
        pushHeader = init.header;
      }
      const ct = s.crypto_secretstream_xchacha20poly1305_push(
        pushState,
        s.from_string(plaintext),
        null,
        s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      );
      if (pushHeader) {
        const header = pushHeader;
        pushHeader = undefined;
        const out = new Uint8Array(LINK_HEADER_BYTES + ct.length);
        out.set(header, 0);
        out.set(ct, LINK_HEADER_BYTES);
        return out;
      }
      return ct;
    },
    openFrame(ciphertext: Uint8Array): string | null {
      try {
        let body = ciphertext;
        if (!pullState) {
          // A first frame shorter than the header cannot carry a message
          // (body would need at least the 17-byte auth tag); refuse before
          // init_pull throws on the split.
          if (ciphertext.length < LINK_HEADER_BYTES) return null;
          pullState = s.crypto_secretstream_xchacha20poly1305_init_pull(
            ciphertext.subarray(0, LINK_HEADER_BYTES),
            receiveKey,
          );
          body = ciphertext.subarray(LINK_HEADER_BYTES);
        }
        // libsodium-wrappers reports an authentication failure as `false`
        // (and a length violation as a throw) — both mean null here.
        const result = s.crypto_secretstream_xchacha20poly1305_pull(pullState, body, null);
        if (result === false) return null;
        return s.to_string(result.message);
      } catch {
        return null;
      }
    },
  };
}

/** Generate a fresh LONG-TERM link keypair — the node's at enroll, the server's at first use. */
export async function generateLinkKeyPair(): Promise<LinkKeyPair> {
  const s = await ensureSodium();
  const { publicKey, privateKey } = s.crypto_kx_keypair();
  return { publicKey: s.to_base64(publicKey), privateKey: s.to_base64(privateKey) };
}

/**
 * Derive the node side of a link from an EXPLICIT ephemeral — the deterministic
 * twin the KAT vector pins. Production code calls {@link createClientSession};
 * this exists so the vector exercises the same derivation the real path runs,
 * which a derivation pinned only through a private pair could not.
 * The ephemeral's private half is used and dropped here; forward secrecy is
 * the point of its freshness, so keeping it reachable would defeat that.
 */
export async function createClientSessionWithEphemeral(opts: {
  serverStaticPublicKey: string;
  ephemeral: LinkKeyPair;
}): Promise<{ session: LinkSession; ephemeralPublicKey: string }> {
  const s = await ensureSodium();
  const serverPk = decodeKey(s, opts.serverStaticPublicKey, "server static public key");
  const ephPk = decodeKey(s, opts.ephemeral.publicKey, "ephemeral public key");
  const ephSk = decodeKey(s, opts.ephemeral.privateKey, "ephemeral secret key");
  const { sharedRx, sharedTx } = s.crypto_kx_client_session_keys(ephPk, ephSk, serverPk);
  // to_base64 of the DECODED pk, not the input string: the caller puts this
  // into the `kx` frame, and what travels must be the bytes that were derived
  // with, whatever spelling the input used.
  return { session: buildSession(s, sharedTx, sharedRx), ephemeralPublicKey: s.to_base64(ephPk) };
}

/**
 * Derive the node side of a link with a FRESH per-connection ephemeral.
 * The returned `ephemeralPublicKey` is what the caller sends as the frame's
 * `eph` field.
 */
export async function createClientSession(opts: { serverStaticPublicKey: string }): Promise<{
  session: LinkSession;
  ephemeralPublicKey: string;
}> {
  return createClientSessionWithEphemeral({
    serverStaticPublicKey: opts.serverStaticPublicKey,
    ephemeral: await generateLinkKeyPair(),
  });
}

/**
 * Derive the control-plane side of a link. The CALLER (the `/ws/node`
 * handshake, task 7) compares the frame's claimed node static (`pub`) against
 * the row's `encryptPublicKey` pin BEFORE calling this — a mismatch never
 * reaches the derivation.
 */
export async function createServerSession(opts: {
  serverStatic: LinkKeyPair;
  clientEphemeralPublicKey: string;
}): Promise<LinkSession> {
  const s = await ensureSodium();
  const serverPk = decodeKey(s, opts.serverStatic.publicKey, "server static public key");
  const serverSk = decodeKey(s, opts.serverStatic.privateKey, "server static secret key");
  const clientPk = decodeKey(s, opts.clientEphemeralPublicKey, "client ephemeral public key");
  const { sharedRx, sharedTx } = s.crypto_kx_server_session_keys(serverPk, serverSk, clientPk);
  return buildSession(s, sharedTx, sharedRx);
}

/* ------------------------------------------------------------------ */
/* handshake frame types + validators (node-frames.ts style)           */
/* ------------------------------------------------------------------ */

/**
 * The `kx` frame, either direction: `eph` is the sender's fresh ephemeral
 * public key, and `pub` is the node's long-term static claim (the node's
 * frame; spec §4 step 2). Shape only — WHICH `pub` the handshake requires is
 * the caller's classification (task 7), and the reply's `eph` is not
 * derivation input in this construction (see the module header).
 */
export type KxFrame = { t: "kx"; eph: string; pub?: string };

/** A legacy row's first-connect registration (spec §5): the node commits its long-term static. */
export type RegisterFrame = { t: "register"; pub: string };

/** The plane's answer to registration: the SERVER's encryption static, for the node to pin (spec §3, §5). */
export type RegisterOkFrame = { t: "register-ok"; controlEncryptPublicKey: string };

/** The first decrypted payload: the identity the link is bound to (spec §4 step 4). */
export type LinkBinding = { nodeId: string; nodeKey: string; protocolVersion: number };

/** The plane's encrypted ack. */
export type LinkAck = { t: "ok" };

/**
 * A base64-shaped string of at least one byte. SHAPE only, like every
 * validator here: a 32-byte length check needs a decode, and the callers
 * (tasks 7/9) do it against their own `ensureSodium()` handle once they have
 * decided the frame is worth decoding at all.
 */
function isB64(value: unknown): value is string {
  return isStr(value) && value.length > 0 && BASE64_RE.test(value);
}

/** A `kx` frame, or null. `pub` is optional (only the first connect carries the claim). */
export function parseKxFrame(v: unknown): KxFrame | null {
  if (!isRecord(v) || v.t !== "kx" || !isB64(v.eph)) return null;
  if ("pub" in v) {
    if (!isB64(v.pub)) return null;
    return { t: "kx", eph: v.eph, pub: v.pub };
  }
  return { t: "kx", eph: v.eph };
}

/** A `register` frame, or null. */
export function parseRegisterFrame(v: unknown): RegisterFrame | null {
  if (!isRecord(v) || v.t !== "register" || !isB64(v.pub)) return null;
  return { t: "register", pub: v.pub };
}

/** A `register-ok` frame, or null. */
export function parseRegisterOkFrame(v: unknown): RegisterOkFrame | null {
  if (!isRecord(v) || v.t !== "register-ok" || !isB64(v.controlEncryptPublicKey)) return null;
  return { t: "register-ok", controlEncryptPublicKey: v.controlEncryptPublicKey };
}

/** A decrypted binding payload, or null. Shape only — the bearer check is the handshake. */
export function parseLinkBinding(v: unknown): LinkBinding | null {
  if (!isRecord(v) || !isStr(v.nodeId) || !isStr(v.nodeKey) || !isInt(v.protocolVersion)) return null;
  return { nodeId: v.nodeId, nodeKey: v.nodeKey, protocolVersion: v.protocolVersion };
}

/** The encrypted ack, or null. */
export function parseLinkAck(v: unknown): LinkAck | null {
  if (!isRecord(v) || v.t !== "ok") return null;
  return { t: "ok" };
}

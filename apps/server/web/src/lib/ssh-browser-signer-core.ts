import { readEnvelope, unlockEnvelope } from "./ssh-browser-signer/envelope";
import { importPrivate, importPublic, type PrivateIdentity, type PublicIdentity } from "./ssh-browser-signer/keys";
import { base64, concat, decode64, equal, field, MAX_BYTES, Reader, SignerError, u32 } from "./ssh-browser-signer/wire";

/** The destination approved locally before any private key is imported. */
export interface BrowserSignerScope {
  /** The exact SSH username authorized for this login. */
  user: string;
  /** The approved host's canonical base64 SSH public key wire blob. */
  hostKey: string;
  /** The absolute expiration time in milliseconds, at most 90 seconds away. */
  expiresAt: number;
}

const FAILURE = "BQ==";
const EXPIRED = "The local SSH key request expired. Start the connection again.";
const KEY_ERROR = "Couldn't read that SSH key. Choose a supported OpenSSH private key and check its passphrase.";

function safeError(error: unknown): Error {
  return new Error(error instanceof SignerError ? error.message : KEY_ERROR);
}

/** Inspect only the bounded OpenSSH envelope to decide whether to ask for a passphrase. */
export function inspectBrowserSshKey(bytes: Uint8Array): { encrypted: boolean } {
  try {
    const envelope = readEnvelope(bytes);
    try {
      return { encrypted: envelope.encrypted };
    } finally {
      envelope.buffer.fill(0);
    }
  } catch (error) {
    throw safeError(error);
  }
}

/** Validate the host's full public wire blob and return OpenSSH's SHA-256 fingerprint. */
export async function browserHostFingerprint(hostKey: string): Promise<string> {
  try {
    const bytes = decode64(hostKey);
    await importPublic(bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `SHA256:${base64(new Uint8Array(digest)).replace(/=+$/, "")}`;
  } catch {
    throw new Error("The SSH host key isn't supported or isn't valid.");
  }
}

/**
 * Import a key inside a dedicated worker and authorize one verified, host-bound
 * SSH login. The caller owns worker termination; this core never performs I/O.
 * Mutable input arrays are scrubbed after import, including failed imports.
 */
export async function createBrowserSshSigner(
  args: BrowserSignerScope & { bytes: Uint8Array; passphrase?: Uint8Array },
): Promise<{
  publicKey: string;
  request(payload: string): Promise<{ response: string; done: boolean }>;
  close(): void;
}> {
  let privateKey: PrivateIdentity | undefined;
  let host: PublicIdentity | undefined;
  let binding: Uint8Array | undefined;
  let state: "open" | "binding" | "signing" | "closed" = "open";
  const remaining = args.expiresAt - Date.now();
  const monotonicDeadline = performance.now() + Math.min(remaining, 90_000);
  const expired = () => Date.now() >= args.expiresAt || performance.now() >= monotonicDeadline;
  const close = () => {
    state = "closed";
    privateKey = undefined;
    host = undefined;
    binding?.fill(0);
    binding = undefined;
  };
  const isClosed = () => state === "closed";
  try {
    if (!Number.isFinite(args.expiresAt) || remaining <= 0 || remaining > 90_000) throw new SignerError(EXPIRED);
    if (!args.bytes.length || args.bytes.length > MAX_BYTES) {
      throw new SignerError("Choose an SSH private key file no larger than 64 KiB.");
    }
    if (args.user.length > 256) throw new SignerError("Choose a valid SSH username before selecting a key.");
    const user = new TextEncoder().encode(args.user);
    if (
      !user.length ||
      user.length > 256 ||
      user.some((byte) => byte < 32 || byte === 127) ||
      new TextDecoder().decode(user) !== args.user
    ) {
      throw new SignerError("Choose a valid SSH username before selecting a key.");
    }
    if (args.passphrase && args.passphrase.length > MAX_BYTES)
      throw new SignerError("That SSH key passphrase is too large.");
    const hostBytes = decode64(args.hostKey);
    host = await importPublic(hostBytes);
    if (expired()) throw new SignerError(EXPIRED);
    const envelope = readEnvelope(args.bytes);
    try {
      const plaintext = await unlockEnvelope(envelope, args.passphrase);
      try {
        if (expired()) throw new SignerError(EXPIRED);
        privateKey = await importPrivate(plaintext, concat(envelope.publicKey), envelope.encrypted ? 16 : 8);
      } finally {
        plaintext.fill(0);
      }
    } finally {
      envelope.buffer.fill(0);
    }
    if (expired()) throw new SignerError(EXPIRED);
    const publicBytes = privateKey.publicKey;
    const publicKey = base64(publicBytes);

    const request = async (payload: string): Promise<{ response: string; done: boolean }> => {
      if (expired()) close();
      if (state !== "open") return { response: FAILURE, done: state !== "binding" };
      let packet: Uint8Array | undefined;
      let response = FAILURE;
      try {
        packet = decode64(payload);
        const reader = new Reader(packet);
        const command = reader.byte();
        if (command === 11) {
          reader.end();
          response = base64(
            concat(new Uint8Array([12]), u32(1), field(publicBytes), field("Subshell one-time SSH key")),
          );
        } else if (command === 27) {
          const extension = reader.text();
          const approvedHost = reader.string();
          const session = reader.string();
          const signature = reader.string();
          const forwarding = reader.byte();
          reader.end();
          if (
            extension !== "session-bind@openssh.com" ||
            binding ||
            !host ||
            !equal(approvedHost, hostBytes) ||
            session.length < 16 ||
            session.length > 128 ||
            forwarding !== 0
          )
            throw new SignerError("The SSH session binding wasn't approved.");
          // Reserve the binding before awaiting verification so concurrent
          // requests can't replace it or sign against an unverified session.
          state = "binding";
          const verified = await host.verify(session, signature);
          if (state !== "binding" || expired()) {
            close();
          } else {
            state = "open";
            if (verified) {
              binding = concat(session);
              response = "Bg==";
            }
          }
        } else if (command === 13) {
          const identity = reader.string();
          const data = reader.string();
          const flags = reader.u32();
          reader.end();
          if (!privateKey || !binding || !equal(identity, publicBytes))
            throw new SignerError("The SSH signature wasn't approved.");
          const auth = new Reader(data);
          if (
            !equal(auth.string(), binding) ||
            auth.byte() !== 50 ||
            !equal(auth.string(), user) ||
            auth.text() !== "ssh-connection" ||
            auth.text() !== "publickey-hostbound-v00@openssh.com" ||
            auth.byte() !== 1
          )
            throw new SignerError("The SSH login doesn't match the approved destination.");
          const algorithm = auth.text();
          if (
            !equal(auth.string(), publicBytes) ||
            !equal(auth.string(), hostBytes) ||
            !privateKey.accepts(algorithm, flags)
          )
            throw new SignerError("The SSH signature wasn't approved.");
          auth.end();
          // Consume before the first signing await. Every simultaneous or later
          // request fails, including a second request during slow browser crypto.
          const key = privateKey;
          state = "signing";
          privateKey = undefined;
          host = undefined;
          binding.fill(0);
          binding = undefined;
          const signature = await key.sign(data, algorithm);
          if (state === "signing" && !expired()) response = base64(concat(new Uint8Array([14]), field(signature)));
          close();
        }
      } catch {
        if (state === "signing") close();
        if (state === "binding") state = "open";
      } finally {
        packet?.fill(0);
        if (expired()) {
          close();
          response = FAILURE;
        }
      }
      return { response, done: isClosed() };
    };
    return { publicKey, request, close };
  } catch (error) {
    close();
    throw safeError(error);
  } finally {
    args.bytes.fill(0);
    args.passphrase?.fill(0);
  }
}

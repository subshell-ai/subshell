import { isRecord } from "./guards.js";
import { base64ToBytes } from "./ssh-base64-std.js";
import { SSH_MAX_HOST_PIN_LINE_CHARS } from "./ssh-limits.js";

/** Native signing ends after one authentication, even if a caller disappears. */
export const SSH_LOCAL_KEY_TTL_MS = 90_000;
export const SSH_LOCAL_KEY_MAX_BYTES = 65_536;
export const SSH_LOCAL_KEY_MAX_BASE64 = 87_384;
/** Encoded-passphrase bound (bytes): both signing paths check this single number. */
export const SSH_LOCAL_KEY_MAX_PASSPHRASE_BYTES = 4_096;

/** The agent's SSH_AGENT_FAILURE reply, as it crosses the bridge: byte 5, base64. */
export const SSH_AGENT_FAILURE_BASE64 = "BQ==";

/** The only data exchanged is public SSH agent traffic, never a private key. */
export type SshKeyBridgeCommand =
  | { type: "ssh_key_bridge"; op: "open"; id: string; hostPin: string }
  | { type: "ssh_key_bridge"; op: "exchange"; id: string; reply?: { seq: number; payload: string } }
  | { type: "ssh_key_bridge"; op: "close"; id: string };

export interface SshKeyBridgeResult {
  /** True once signing access has ended. */
  done: boolean;
  /** One outstanding, length-bounded SSH-agent request. */
  request: { seq: number; payload: string } | null;
}

/** Reject noncanonical or oversized messages before allocating decoded bytes. */
export function isSshKeyBridgePayload(value: unknown): value is string {
  if (typeof value !== "string" || !value.length || value.length > SSH_LOCAL_KEY_MAX_BASE64) return false;
  try {
    return base64ToBytes(value).length <= SSH_LOCAL_KEY_MAX_BYTES;
  } catch {
    return false;
  }
}

/** One plain host key, with the wire algorithm agreeing with the known_hosts column. */
export function isSshLocalKeyHostPin(value: unknown): value is string {
  // Same line hygiene as isSshKnownHostsPinLine (ssh-frames.ts): this string is
  // written verbatim into the known_hosts the pane's ssh trusts with
  // StrictHostKeyChecking, so a smuggled control character or option token
  // would become part of that trust, not just noise. The host token is a
  // POSITIVE allow-list: a plain host label, a bracketed address (IPv6 or
  // host) with optional `:port`, or a canonical hashed `|1|salt|hash` token
  // (how the operator's own file may spell the pin). Globs, comma
  // option-lists, `@`/`!` markers, and trailing
  // junk are refused here, at the last check before the file is written.
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > SSH_MAX_HOST_PIN_LINE_CHARS ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value) ||
    value.startsWith("#")
  )
    return false;
  const [host, algorithm, encoded, ...rest] = value.split(/\s+/);
  if (
    !host ||
    !(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) ||
      /^\[[A-Za-z0-9._:-]+\](?::\d+)?$/.test(host) ||
      /^\|1\|[A-Za-z0-9+/]+={0,2}\|[A-Za-z0-9+/]+={0,2}$/.test(host)
    ) ||
    (rest.length > 0 && !rest[0]?.startsWith("#")) ||
    !algorithm ||
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(algorithm) ||
    !isSshKeyBridgePayload(encoded)
  )
    return false;
  const bytes = base64ToBytes(encoded);
  if (bytes.length < 5) return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return (
    length === algorithm.length &&
    bytes.length > length + 4 &&
    new TextDecoder().decode(bytes.subarray(4, 4 + length)) === algorithm
  );
}

/** Rebuild an agent reply without preserving unknown fields. */
export function parseSshKeyBridgeReply(value: unknown): { seq: number; payload: string } | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 0 ||
    !isSshKeyBridgePayload(value.payload)
  )
    return null;
  return { seq: value.seq as number, payload: value.payload };
}

/** Validate node results independently of the authenticated transport. */
export function parseSshKeyBridgeResult(value: unknown): SshKeyBridgeResult | null {
  if (!isRecord(value) || typeof value.done !== "boolean") return null;
  const request = value.request === null ? null : parseSshKeyBridgeReply(value.request);
  if (value.request !== null && request === null) return null;
  if (value.done && request) return null;
  return { done: value.done, request };
}

import { isRecord } from "./guards.js";
import { base64ToBytes } from "./ssh-base64-std.js";

/** Native signing ends after one authentication, even if a caller disappears. */
export const SSH_LOCAL_KEY_TTL_MS = 90_000;
export const SSH_LOCAL_KEY_MAX_BYTES = 65_536;
export const SSH_LOCAL_KEY_MAX_BASE64 = 87_384;

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
  if (typeof value !== "string" || value.length > 16_384 || /[\r\n\0]/.test(value)) return false;
  const [host, algorithm, encoded] = value.trim().split(/\s+/);
  if (
    !host ||
    host.startsWith("@") ||
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

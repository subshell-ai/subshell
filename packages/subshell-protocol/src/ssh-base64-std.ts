/**
 * The STANDARD (padded) base64 spelling the relay wire's `blob` field uses,
 * as a pure module: no `node:` builtin, no `Buffer` (pinned by test, same
 * regime as ssh-relay.ts, which imports this file through the Metro-consumed
 * barrel). These are the exact helpers that lived inline in ssh-relay.ts;
 * Task 5 review M-5 split them out to keep that file inside the size
 * guideline. No logic change: the acceptance set stays BASE64_RE-compatible
 * (Task 4's `parseRelayFrame` cap rule measures the raw payload of strings
 * this grammar admits), and junk is refused, never repaired.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_VALUES: number[] = (() => {
  const values = new Array<number>(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    values[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return values;
})();

/** Encodes bytes as standard base64 WITH `=` padding (the blob's grammar). */
export function base64FromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64_ALPHABET[(n >> 18) & 63];
    out += BASE64_ALPHABET[(n >> 12) & 63];
    out += remaining > 1 ? BASE64_ALPHABET[(n >> 6) & 63] : "=";
    out += remaining > 2 ? BASE64_ALPHABET[n & 63] : "=";
  }
  return out;
}

/**
 * Decodes standard padded base64 to bytes. Callers pre-screen with
 * BASE64_RE; this still refuses mid-text padding, non-alphabet bytes, and
 * non-canonical trailing bits - junk is refused, never repaired. A code point
 * at or above U+0080 is NOT in the table's range: it is refused by name
 * (Task 5 review M-2 - reading past the table yields `undefined`, which
 * `v < 0` would wave through and silently corrupt into NaN-poisoned bytes).
 */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 4 !== 0) throw new TypeError("ssh-relay: blob length is not a padded base64 group");
  let pad = 0;
  while (pad < 2 && text[text.length - 1 - pad] === "=") pad += 1;
  const body = text.slice(0, text.length - pad);
  const out = new Uint8Array(Math.floor((body.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of body) {
    const code = ch.charCodeAt(0);
    const v = code < 128 ? BASE64_VALUES[code] : -1;
    if (v < 0) throw new TypeError("ssh-relay: blob carries a non-base64 character");
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (bits === 6 || (value & ((1 << bits) - 1)) !== 0) {
    throw new TypeError("ssh-relay: blob has non-canonical trailing bits");
  }
  return out;
}

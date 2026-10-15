import { SSH_LOCAL_KEY_MAX_BASE64, SSH_LOCAL_KEY_MAX_BYTES } from "@internal/subshell-protocol";

/** A fixed message safe to pass through the worker's public error boundary. */
export class SignerError extends Error {}

/** Read bounded SSH wire fields; slices stay within the original allocation. */
export class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.offset >= this.bytes.length) throw new SignerError("The SSH data isn't valid.");
    return this.bytes[this.offset++];
  }

  u32(): number {
    if (this.remaining < 4) throw new SignerError("The SSH data isn't valid.");
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0);
    this.offset += 4;
    return value;
  }

  string(): Uint8Array {
    const length = this.u32();
    if (length > this.remaining) throw new SignerError("The SSH data isn't valid.");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text(): string {
    const bytes = this.string();
    if (bytes.some((byte) => byte < 32 || byte > 126)) throw new SignerError("The SSH data isn't valid.");
    return String.fromCharCode(...bytes);
  }

  end(): void {
    if (this.remaining !== 0) throw new SignerError("The SSH data contains unexpected extra bytes.");
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

/** Compare public wire fields without converting them into strings. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Join bounded wire fields. Callers never use this for unbounded input. */
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Encode an unsigned SSH integer. */
export function u32(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** Encode an SSH length-prefixed byte string. */
export function field(value: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat(u32(bytes.length), bytes);
}

/** Standard base64 with padding, as required by the SSH relay. */
export function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Refuse noncanonical encodings and oversized packets before allocating them. */
export function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (
    value.length > SSH_LOCAL_KEY_MAX_BASE64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new SignerError("The SSH data isn't valid base64 or is too large.");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length > SSH_LOCAL_KEY_MAX_BYTES || base64(bytes) !== value) {
    bytes.fill(0);
    throw new SignerError("The SSH data isn't valid base64 or is too large.");
  }
  return bytes;
}

/** JWK fields use the unpadded URL-safe variant of base64. */
export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode one positive, minimally encoded SSH mpint into unsigned bytes. */
export function positive(reader: Reader, maximum = 1024): Uint8Array {
  const bytes = reader.string();
  if (
    bytes.length === 0 ||
    bytes.length > maximum + 1 ||
    (bytes[0] & 0x80) !== 0 ||
    (bytes[0] === 0 && (bytes.length === 1 || (bytes[1] & 0x80) === 0))
  ) {
    throw new SignerError("The SSH key contains an invalid integer.");
  }
  const unsigned = bytes[0] === 0 ? bytes.subarray(1) : bytes;
  if (unsigned.length > maximum) throw new SignerError("The SSH key is too large.");
  return unsigned;
}

/** Encode an unsigned integer as the SSH mpint representation. */
export function mpint(value: Uint8Array): Uint8Array<ArrayBuffer> {
  let offset = 0;
  while (offset < value.length && value[offset] === 0) offset++;
  const bytes = value.subarray(offset);
  return field(bytes.length && (bytes[0] & 0x80) !== 0 ? concat(new Uint8Array([0]), bytes) : bytes);
}

/** Left-pad a scalar to the fixed width Web Crypto expects. */
export function padded(value: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (value.length > size) throw new SignerError("The SSH key contains an invalid integer.");
  const out = new Uint8Array(size);
  out.set(value, size - value.length);
  return out;
}

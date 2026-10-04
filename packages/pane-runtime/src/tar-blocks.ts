/**
 * Shared ustar/pax primitives for the node-to-node archive transfer's
 * writer (tar-writer.ts) and extractor (tar-extractor.ts). Kept apart from
 * both so the byte-level format - the part that must be exactly right and is
 * the whole security surface of extraction - is one small, fully-tested unit.
 *
 * Format reference is ustar (POSIX.1-1988) with pax extended headers for
 * names that do not fit the fixed fields, matching what `tar-vendor.ts`'s
 * reader already accepts (so an archive this writer emits is readable by that
 * parser too, modulo its npm `package/` strip, which the transfer extractor
 * deliberately does not apply).
 *
 * This module does NOT touch gzip or the filesystem; it turns header specs into
 * 512-byte blocks, parses blocks back, and enforces the path/type rules.
 */

import { TextDecoder, TextEncoder } from "node:util";

/** ustar is defined in 512-byte blocks. */
export const BLOCK = 512;

/** The only entry types the transfer writer emits and the extractor accepts. */
export const TYPE_FILE = "0";
export const TYPE_DIR = "5";
export const TYPE_PAX = "x";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The transfer path guard. Absolute paths, embedded NULs and any `..` segment
 * are refused; empty and `.` segments collapse; the result is a clean relative
 * posix path. Applied on EXTRACT to the name the header or its pax override
 * supplies, so a hostile archive cannot name a file outside the destination
 * root. NO `package/` strip (that rule belongs to npm's tarballs only).
 */
export function safeTransferPath(p: string): string {
  // Newline is refused beside the NUL: a pax `path=` record is one
  // newline-delimited line, and a >100-byte name containing one would be
  // TRUNCATED at the newline by the override reader - the file would land
  // under a wrong name in silence. Linux allows `\n` in file names, so both
  // sides of the wire need the same rule: refuse, don't mangle.
  if (p === "" || p.startsWith("/") || p.includes("\0") || p.includes("\n")) {
    throw new Error(`tar: refusing absolute/empty path '${p}'`);
  }
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error(`tar: refusing traversal path '${p}'`);
    parts.push(seg);
  }
  if (parts.length === 0) throw new Error("tar: refusing empty path");
  return parts.join("/");
}

/** Strip trailing NULs (tar pads fixed fields with zeros). */
export function trimZeros(b: Uint8Array): Uint8Array {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.subarray(0, end);
}

function readOctalField(b: Uint8Array): number {
  const s = dec.decode(trimZeros(b)).trim();
  if (s === "") return 0;
  const v = Number.parseInt(s, 8);
  if (!Number.isFinite(v) || v < 0) throw new Error(`tar: malformed octal field '${s}'`);
  return v;
}

/** A decoded view of one parsed ustar header (only the fields the transfer uses). */
export interface ParsedHeader {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  mtime: number;
  typeflag: string;
}

/** Parse a 512-byte header block. Does NOT verify the checksum (the gzip CRC
 * already covers corruption and a hostile-but-well-formed archive passes it;
 * what matter are the path/type/size rules the CALLER applies). */
export function parseHeader(block: Uint8Array): ParsedHeader {
  if (block.length !== BLOCK) throw new Error(`tar: header block must be ${BLOCK} bytes`);
  return {
    name: dec.decode(trimZeros(block.subarray(0, 100))),
    prefix: dec.decode(trimZeros(block.subarray(345, 500))),
    size: readOctalField(block.subarray(124, 136)),
    mode: readOctalField(block.subarray(100, 108)) & 0o7777,
    mtime: readOctalField(block.subarray(136, 148)),
    typeflag: dec.decode(block.subarray(156, 157)) || TYPE_FILE,
  };
}

/** True when a header block is the all-zero archive terminator. */
export function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

/** Write ASCII/text into `buf` at [at, at+len); throw if it overflows. */
function put(buf: Uint8Array, at: number, len: number, text: string): void {
  const bytes = enc.encode(text);
  if (bytes.length > len) throw new Error(`tar: field overflow at ${at} (${bytes.length} > ${len})`);
  buf.set(bytes, at);
}

/** ustar octal field: `width` octal digits, NUL-terminated, fits within `len`. */
function octal(value: number, width: number): string {
  const s = value.toString(8);
  if (s.length > width) throw new Error(`tar: octal overflow ${value} (width ${width})`);
  return `${s.padStart(width, "0")}\0`;
}

/** Spec for one header the writer builds. */
export interface HeaderSpec {
  /** Raw bytes for the 100-byte name field (caller may put a placeholder when pax carries the real path). */
  nameBytes: Uint8Array;
  size: number;
  mode: number;
  mtimeSeconds: number;
  typeflag: string;
}

/** Build a 512-byte ustar header block with a correct checksum. */
export function buildHeader(spec: HeaderSpec): Uint8Array {
  const h = new Uint8Array(BLOCK);
  if (spec.nameBytes.length > 100) throw new Error(`tar: name field overflow (${spec.nameBytes.length} > 100)`);
  h.set(spec.nameBytes, 0);
  put(h, 100, 8, octal(spec.mode & 0o7777, 6));
  put(h, 108, 8, octal(0, 6)); // uid
  put(h, 116, 8, octal(0, 6)); // gid
  put(h, 124, 12, octal(spec.size, 11));
  put(h, 136, 12, octal(spec.mtimeSeconds >>> 0, 11));
  h.fill(0x20, 148, 156); // checksum = spaces while summing
  put(h, 156, 1, spec.typeflag);
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148); // 6 octal + NUL + space
  return h;
}

/** One pax record: "<len> <key>=<value>\n" where <len> counts the whole record. */
export function paxRecord(key: string, value: string): Uint8Array {
  const kvBytes = enc.encode(`${key}=${value}`).length;
  let len = kvBytes + 3; // "<d> <kv>\n" with a 1-digit d
  for (let i = 0; i < 16; i++) {
    const line = enc.encode(`${len} ${key}=${value}\n`);
    if (line.length === len) return line;
    len = line.length;
  }
  throw new Error("tar: pax record length did not converge");
}

/** Extract a `path=` override from a pax extended-header body, if present. */
export function paxOverridePath(body: Uint8Array): string | undefined {
  let path: string | undefined;
  for (const line of dec.decode(body).split("\n")) {
    const space = line.indexOf(" ");
    const kv = space === -1 ? "" : line.slice(space + 1);
    if (kv.startsWith("path=")) path = kv.slice(5);
  }
  return path;
}

/**
 * A pax `x` header + its block-padded body carrying `path=<p>`, as the two (or
 * more) blocks to emit before the real entry whose name is too long for ustar.
 * The extractor applies the override BEFORE its path guard.
 */
export function paxPathBlocks(p: string): Uint8Array[] {
  const record = paxRecord("path", p);
  const padded = new Uint8Array(Math.ceil(record.length / BLOCK) * BLOCK);
  padded.set(record);
  const header = buildHeader({
    nameBytes: enc.encode("./PaxHeaders/.longname"),
    size: record.length,
    mode: 0o644,
    mtimeSeconds: 0,
    typeflag: TYPE_PAX,
  });
  return [header, padded];
}

/** Whether `p` cannot ride the plain 100-byte name field and needs a pax override. */
export function needsPax(p: string): boolean {
  return enc.encode(p).length > 100 || p.includes("\0");
}

/** Pad a byte count up to the next whole block. */
export function blockPadding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

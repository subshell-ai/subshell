/**
 * Unpacks one npm `.tgz` (gzip + ustar/pax) into validated entries.
 *
 * Vendored rather than shelled out to `tar(1)` because the agent is a
 * compiled binary in containers that may have no tar (spec §8.1), and
 * vendored rather than a dependency because the agent binary bundles what
 * it imports and this is ~120 lines of format we already must understand
 * to enforce the safety rules. Decompression uses node:zlib's output ceiling
 * so a gzip bomb is stopped before its expanded bytes are allocated in full.
 *
 * The limits and refusals are spec §2.8: regular files and directories
 * only — links and devices are refused outright because `npm pack` never
 * emits them, so accepting them would add an escape hatch for nothing;
 * every path must normalize under the root; totals are capped DURING the
 * parse, never after full expansion.
 *
 * The ustar header checksum is deliberately NOT verified: the gzip CRC
 * already covers corruption, and a hostile-but-valid archive passes a
 * checksum anyway — what matter are the path/type/size rules below.
 */
import { gunzipSync } from "node:zlib";

/** One regular file unpacked from a tarball, with its normalized path. */
export interface TarEntry {
  /** Root-relative path, npm's `package/` wrapper already stripped. */
  path: string;
  /** The file's bytes (copied out of the gunzipped buffer). */
  content: Uint8Array;
}

/** Payload and entry caps, also used to bound decompression before parsing. */
export interface TgzLimits {
  /** Max total bytes across all kept entries. */
  maxTotalBytes?: number;
  /** Max number of headers, including directories and extended metadata. */
  maxEntries?: number;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

/**
 * Gunzips and unpacks an npm `.tgz` into validated entries.
 *
 * Throws `Error` naming the violated rule on anything `npm pack` would
 * never produce: an absolute or traversing path, a link/device typeflag, a
 * malformed size, a body running past the end, or totals over `opts`
 * (defaults {@link DEFAULT_MAX_BYTES} / {@link DEFAULT_MAX_ENTRIES}).
 */
export function extractTgz(tgz: Uint8Array, opts: TgzLimits = {}): TarEntry[] {
  const maxBytes = opts.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  for (const limit of [maxBytes, maxEntries]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("tar: invalid size or entry limit");
  }
  // Each header and its padding use at most 1024 bytes. Metadata has its own
  // budget; count even bytes after the tar terminator, which the parser skips.
  const maxExpandedBytes = maxBytes + maxEntries * 1024 + MAX_METADATA_BYTES + 1024;
  if (!Number.isSafeInteger(maxExpandedBytes)) throw new Error("tar: invalid expanded size limit");
  let raw: Uint8Array;
  try {
    raw = gunzipSync(tgz, { maxOutputLength: maxExpandedBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("tar: expanded size exceeds limit");
    }
    throw error;
  }
  const dec = new TextDecoder();
  const out: TarEntry[] = [];
  let off = 0;
  let pendingPath: string | undefined; // from a pax header
  let total = 0;
  let entries = 0;
  let metadataBytes = 0;
  const field = (blk: Uint8Array, start: number, len: number) =>
    dec.decode(blk.subarray(start, start + len)).replace(/\0.*$/s, "");
  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512);
    off += 512;
    if (header.every((b) => b === 0)) break; // terminator
    if (++entries > maxEntries) throw new Error(`tar: more than ${maxEntries} entries`);
    const name = field(header, 0, 100);
    const sizeOctal = field(header, 124, 12);
    const typeflag = field(header, 156, 1) || "0";
    const prefix = field(header, 345, 155);
    const size = Number.parseInt(sizeOctal.trim(), 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("tar: malformed entry size");
    const body = raw.subarray(off, off + size);
    if (body.length !== size) throw new Error("tar: truncated archive");
    off += Math.ceil(size / 512) * 512;

    if (typeflag === "x" || typeflag === "g") {
      metadataBytes += size;
      if (metadataBytes > MAX_METADATA_BYTES) throw new Error("tar: metadata size exceeds limit");
      // pax extended header: only `path` matters to us; take it for the NEXT entry.
      for (const line of dec.decode(body).split("\n")) {
        const eq = line.indexOf(" ");
        const kv = eq === -1 ? "" : line.slice(eq + 1);
        if (kv.startsWith("path=")) pendingPath = decodePax(kv.slice(5));
      }
      continue;
    }
    const rawPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;

    if (typeflag === "5") {
      if (size !== 0) throw new Error("tar: refusing directory with a body");
      continue; // directory paths are implicit in file entries
    }
    if (typeflag !== "0") throw new Error(`tar: refusing entry type '${typeflag}' (only files are installable)`);

    const rel = safeRelativePath(rawPath);
    total += size;
    if (total > maxBytes) throw new Error(`tar: unpacked size exceeds ${maxBytes} bytes`);
    out.push({ path: rel, content: new Uint8Array(body) });
  }
  return out;
}

/** npm wraps everything in `package/`; accept one other single top dir (mirrors repack), then normalize. */
function safeRelativePath(p: string): string {
  if (p.startsWith("/") || p.includes("\0")) throw new Error(`tar: refusing absolute path '${p}'`);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error(`tar: refusing traversal path '${p}'`);
    parts.push(seg);
  }
  if (parts.length > 1 && (parts[0] === "package" || parts[0].startsWith("package@"))) parts.shift();
  if (parts.length === 0) throw new Error(`tar: refusing empty path`);
  return parts.join("/");
}

/**
 * Decode `\xNN` hex escapes in a pax override — DEFENSIVE, not expected:
 * POSIX pax escapes specials as `\` + three OCTAL digits (bsdtar follows
 * that), and node-tar, the producer behind every npm registry tarball,
 * escapes nothing. The hex branch is dead code against real data; it stays
 * as a cheap belt so an escaped name cannot ship mangled if one ever does.
 */
function decodePax(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

/**
 * Minimal ustar writers for the vendored-tgz tests: enough of the format to
 * exercise every reader rule in `tar-vendor.ts` (and later, the plugin-pack
 * installer's), and nothing more.
 *
 * The header layout these emit is the plain ustar one:
 *
 *   0    name        (100 bytes, NUL-padded)
 *   100  mode        (7 octal digits + NUL)
 *   108  uid         (7 octal digits + NUL)
 *   116  gid         (7 octal digits + NUL)
 *   124  size        (11 octal digits, NUL-padded)
 *   136  mtime       (11 octal digits, NUL-padded)
 *   148  checksum    (6 octal digits + NUL + space; computed over the block
 *                     with THIS field filled with spaces)
 *   156  typeflag    (1 byte: "0" file, "5" dir, "1" hard link, "2" symlink,
 *                     "x"/"g" pax header)
 *   257  magic "ustar\0" + version "00"
 *   345  prefix      (written by `handBuiltTgz` when an entry sets one;
 *                     `makeTgz` never does)
 *
 * Data after a header is block-PADDED, not just sliced: a 5-byte file still
 * occupies a full 512-byte block, because the reader consumes
 * `ceil(size/512)` blocks per entry. A zero-byte entry occupies NONE (that is
 * what real tar and npm's tarballs do; a padding-mismatched fixture would
 * drift off block alignment and test nothing). Two zero blocks terminate.
 *
 * Names are written EXACTLY as given. A fixture path carrying npm's
 * `package/` prefix therefore produces the same bytes a real `npm pack`
 * archive does — which is the point: the reader, not the fixture, owns
 * stripping it, so the prefix test actually exercises the strip.
 */

const encoder = new TextEncoder();

/** One 512-byte ustar header block for a given entry. */
function ustarHeader(name: string, mode: string, size: number, typeflag: string, prefix = ""): Uint8Array {
  const header = new Uint8Array(512);
  const put = (s: string, off: number, len: number) =>
    header.set(encoder.encode(s.padEnd(len, "\0")).subarray(0, len), off);
  // Fail loudly rather than silently truncating: an overlong field here would
  // put the reader off-block with no explanation. (A >100-byte single-field
  // name is exactly what pax headers and the prefix field exist for, and
  // `handBuiltTgz` builds those by hand.)
  if (encoder.encode(name).length > 100) {
    throw new Error(`tgz-fixture: name does not fit the 100-byte ustar name field: ${name}`);
  }
  if (encoder.encode(prefix).length > 155) {
    throw new Error(`tgz-fixture: prefix does not fit the 155-byte ustar prefix field: ${prefix}`);
  }
  put(name, 0, 100);
  put(mode.padStart(7, "0"), 100, 8);
  put("0".padStart(7, "0"), 108, 8); // uid
  put("0".padStart(7, "0"), 116, 8); // gid
  put(size.toString(8).padStart(11, "0"), 124, 12); // size
  put("0".padStart(11, "0"), 136, 12); // mtime
  put("        ", 148, 8); // checksum placeholder before computing
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  put(typeflag, 156, 1); // file typeflag
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  if (prefix) put(prefix, 345, 155);
  return header;
}

/** Frames raw entries (names verbatim, bodies pre-encoded) into a gzip tar. */
function frame(
  entries: Array<{ name: string; typeflag: string; body: Uint8Array; mode?: string; prefix?: string }>,
): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    blocks.push(ustarHeader(e.name, e.mode ?? "644", e.body.length, e.typeflag, e.prefix ?? ""));
    const paddedLen = Math.ceil(e.body.length / 512) * 512;
    if (paddedLen > 0) {
      const padded = new Uint8Array(paddedLen);
      padded.set(e.body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate
  const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    all.set(b, at);
    at += b.length;
  }
  return Bun.gzipSync(all);
}

/**
 * Minimal ustar writer from path + string/bytes content. Single call per
 * fixture; names go into the archive verbatim (see file doc).
 */
export function makeTgz(
  entries: Array<{
    path: string;
    content: string | Uint8Array;
    type?: "0" | "5" | "2" | "1" | "x";
    mode?: string;
  }>,
): Uint8Array<ArrayBuffer> {
  return frame(
    entries.map((e) => ({
      name: e.path,
      typeflag: e.type ?? "0",
      mode: e.mode,
      body: typeof e.content === "string" ? encoder.encode(e.content) : e.content,
    })),
  );
}

/**
 * Variant for archives `makeTgz` cannot express: pre-encoded bodies, raw
 * typeflags, and an optional prefix field — needed for the pax-header and
 * long-path cases (a >100-char path is the whole reason those exist).
 */
export function handBuiltTgz(
  entries: Array<{ name: string; typeflag: string; body: Uint8Array; prefix?: string }>,
): Uint8Array<ArrayBuffer> {
  return frame(entries);
}

/**
 * A minimal LOADABLE plugin package as an npm tgz, for the registry-install
 * tests. "Loadable" is load-bearing: the installer runs the real loader
 * against the staging copy before swapping, so the default entry is a factory
 * that satisfies every check in `plugin-runtime.ts` (modelled on
 * `packages/plugins/pi/src/index.ts` minus its imports: a plugin's real build
 * inlines `plugin-api`, a fixture has nothing to inline). The subshell block
 * carries `description` because `parseManifest` requires it, and
 * `capabilityMismatches` is satisfied by declaring no capabilities and
 * implementing no optional members.
 */
export function makePluginTgz(opts: {
  name: string;
  version: string;
  id?: string;
  apiVersion?: number;
  entryBody?: string;
}): Uint8Array<ArrayBuffer> {
  const subshell = {
    apiVersion: opts.apiVersion ?? 1,
    id: opts.id ?? opts.name.replace(/^(@[^/]+\/)?plugin-/, ""),
    type: "agent-harness",
    name: "fixture",
    description: "fixture plugin",
    entry: "index.js",
  };
  const manifest = { name: opts.name, version: opts.version, type: "module", subshell };
  const entry =
    opts.entryBody ??
    "export default function fixture() { return { capabilities: () => [], buildCommand: (input) => [input.binary], validatePreset: () => ({ valid: true }) }; }\n";
  return makeTgz([
    { path: "package/package.json", content: JSON.stringify(manifest) },
    { path: "package/index.js", content: entry },
  ]);
}

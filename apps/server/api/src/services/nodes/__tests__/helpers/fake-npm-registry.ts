import { createHash } from "node:crypto";

/**
 * A stand-in npm registry for the server's local-install tests: packuments and
 * tarballs served from memory over a real HTTP server, so `installPlugin`'s
 * fetch path runs end to end without touching the network.
 *
 * The ustar writer here is a compact port of
 * `packages/pane-runtime/src/__tests__/helpers/tgz-fixture.ts`. That file is a
 * package's own test internal — reaching into another package's `__tests__`
 * would couple two suites' internals, so the duplication is the deliberate
 * choice; if the reader's rules change, that fixture remains the fuller
 * reference.
 */

/** One package the fake registry serves: exact version -> tgz bytes. */
export interface ServedPackage {
  /** `dist-tags.latest` */
  latest: string;
  /** Extra dist-tags, e.g. `{ bad: "9.9.9" }` so `pkg@bad` resolves */
  tags?: Record<string, string>;
  /** Exact version -> served tarball bytes */
  versions: Record<string, Uint8Array>;
  /** Announce a digest that does NOT match the served bytes (integrity test) */
  tamper?: boolean;
}

/** A running fake registry. */
export interface FakeRegistry {
  /** Base URL to hand as `registryUrl` */
  base: string;
  /** Mutate to serve more packages; read before each request takes effect. */
  served: Map<string, ServedPackage>;
  /** Packument requests, in order, by package name. */
  hits: string[];
  stop(): void;
}

const WRONG_SRI = `sha512-${createHash("sha512").update("not the tarball").digest("base64")}`;

/** Start a fake registry on an ephemeral port. */
export function startFakeRegistry(): FakeRegistry {
  const served = new Map<string, ServedPackage>();
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p.startsWith("/tarball/")) {
        const rest = p.slice("/tarball/".length);
        const slash = rest.indexOf("/");
        const name = decodeURIComponent(rest.slice(0, slash));
        const version = decodeURIComponent(rest.slice(slash + 1)).replace(/\.tgz$/, "");
        const bytes = served.get(name)?.versions[version];
        return bytes ? new Response(bytes) : new Response("not found", { status: 404 });
      }
      const name = p.slice(1).split("/").map(decodeURIComponent).join("/");
      hits.push(name);
      const pkg = served.get(name);
      if (!pkg) return new Response("not found", { status: 404 });
      const versions: Record<string, unknown> = {};
      for (const [v, tgz] of Object.entries(pkg.versions)) {
        versions[v] = {
          name,
          version: v,
          dist: {
            // Relative on purpose, as registries and mirrors actually announce
            // (the client resolves it against the base URL).
            tarball: `/tarball/${encodeURIComponent(name)}/${encodeURIComponent(v)}.tgz`,
            integrity: pkg.tamper ? WRONG_SRI : `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
          },
        };
      }
      return Response.json({ "dist-tags": { latest: pkg.latest, ...pkg.tags }, versions });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    served,
    hits,
    stop: () => server.stop(true),
  };
}

const encoder = new TextEncoder();

/** One 512-byte ustar header block (checksum computed over the space-filled field). */
function ustarHeader(name: string, mode: string, size: number, typeflag: string): Uint8Array {
  const header = new Uint8Array(512);
  const put = (s: string, off: number, len: number) =>
    header.set(encoder.encode(s.padEnd(len, "\0")).subarray(0, len), off);
  if (encoder.encode(name).length > 100) throw new Error(`tgz fixture: name does not fit the 100-byte field: ${name}`);
  put(name, 0, 100);
  put(mode.padStart(7, "0"), 100, 8);
  put("0".padStart(7, "0"), 108, 8); // uid
  put("0".padStart(7, "0"), 116, 8); // gid
  put(size.toString(8).padStart(11, "0"), 124, 12); // size
  put("0".padStart(11, "0"), 136, 12); // mtime
  put("        ", 148, 8); // checksum placeholder
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  put(typeflag, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  return header;
}

/** Minimal ustar writer: path + content, gzip-framed like an npm tarball. */
export function makeTgz(entries: Array<{ path: string; content: string | Uint8Array }>): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const body = typeof e.content === "string" ? encoder.encode(e.content) : e.content;
    blocks.push(ustarHeader(e.path, "644", body.length, "0"));
    const paddedLen = Math.ceil(body.length / 512) * 512;
    if (paddedLen > 0) {
      const padded = new Uint8Array(paddedLen);
      padded.set(body);
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
 * A minimal LOADABLE plugin package as an npm tgz. Loadable is load-bearing:
 * the installer runs the real loader against a staging copy BEFORE swapping,
 * so the entry must satisfy every check in `plugin-runtime.ts` (a factory
 * with no capabilities and no optional members — see the pane-runtime
 * fixture this mirrors).
 */
export function makePluginTgz(opts: { name: string; version: string; id?: string }): Uint8Array<ArrayBuffer> {
  const subshell = {
    apiVersion: 1,
    id: opts.id ?? opts.name.replace(/^(@[^/]+\/)?plugin-/, ""),
    type: "agent-harness",
    name: "fixture",
    description: "fixture plugin",
    entry: "index.js",
  };
  const manifest = { name: opts.name, version: opts.version, type: "module", subshell };
  const entry =
    "export default function fixture() { return { capabilities: () => [], buildCommand: (input) => [input.binary], validatePreset: () => ({ valid: true }) }; }\n";
  return makeTgz([
    { path: "package/package.json", content: JSON.stringify(manifest) },
    { path: "package/index.js", content: entry },
  ]);
}

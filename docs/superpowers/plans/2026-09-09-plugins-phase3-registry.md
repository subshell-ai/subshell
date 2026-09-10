# Phase 3: Plugins from the Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a plugin from an npm registry on any host (agent or the control-plane box), verifying the tarball against the registry's integrity hash, with the built-ins staying embedded-first, plus the agent CLI verbs and the npm publishing pipeline.

**Architecture:** One registry client in `@internal/pane-runtime` (fetch + integrity + a vendored tar reader feeding the EXISTING staging/rename machinery), so `local` and agents share one implementation. The signed `plugin_install` command gains an optional `spec` (protocol 1 → 2, exact-match gate); the agent resolves and fetches from the node side. The setup route is untouched: it stays built-in-ids-only (spec §13).

**Tech Stack:** Bun 1.4 (`fetch`, `Bun.gunzipSync`, `crypto.createHash`), TypeScript strict, `bun test`, biome, Elysia + TypeBox, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-09-plugins-phase3-registry-design.md` — read it alongside; every task cites its sections. Dated plans/specs elsewhere are history; do not "fix" their old protocol numbers.

## Global Constraints

- No dynamic `import()` except the sanctioned one in `plugin-runtime.ts` (`.claude/rules/code-style.md`). The new modules use only `fetch`, `node:crypto`, `node:fs/promises`, `node:path`.
- No new runtime dependencies anywhere (compiled binaries bundle what they import).
- Pinned dependency versions; `@internal/*` workspaces stay in `.changeset/config.json`'s `ignore`; the licence split is the directory line (pane-runtime stays Apache).
- No em dashes in product copy (CLI output, error messages, UI strings).
- Every new behavioural test must be verified to fail when the guard is reverted (house rule; do it before committing the task).
- `bunx turbo run verify-types --force` + `bun run lint:check` + `bun run test` before each task's commit; rebuild `@internal/subshell-protocol` and `@internal/pane-runtime` dists after touching them (`bunx turbo build --filter=@internal/subshell-protocol --filter=@internal/pane-runtime`) — workspace imports resolve through `dist/`, and a green run against a stale dist proves nothing.
- Spec §2.7 defaults: registry URL `https://registry.npmjs.org`; §2.8 caps: tarball ≤ 20 MiB, ≤ 1024 entries, packument fetch 15 s, tarball fetch 60 s.
- `MIN_AGENT_VERSION` stays `0.1.0`; do not touch it (spec §2.1).

## Lane map (parallel agents, serial integration)

| lane | tasks | shares files with |
|---|---|---|
| B protocol | 1 | nothing else |
| A pane-runtime | 2 → 3 → 4 | nothing else |
| C agent | 5, 6 (after 1+4 land) | agent app only |
| D server | 7 (after 1+4 land) | server app only |
| E publishing | 8 | workflow files only |
| F docs+e2e | 9 (after everything) | docs, e2e |

Integration order for the person merging: 1 and 2 in parallel → 3 → 4 → {5, 6 serially} ∥ 7 ∥ 8 → 9.

---

### Task 1: Protocol v2 — `plugin_install` gains an optional `spec` (lane B)

**Files:**
- Modify: `packages/subshell-protocol/src/node-frames.ts` (union ~line 234, `NODE_PROTOCOL_VERSION` ~line 32, parser ~line 540)
- Modify: `packages/subshell-protocol/src/__tests__/node-frames.test.ts` (pin ~line 118, `describe("plugin commands")`)
- Modify: `docs/node-protocol.md` (`plugin_install` table row, §11 restart note)

**Interfaces:**
- Produces: `NodeCommandBody` member `{ type: "plugin_install"; id: string; spec?: string }`; `NODE_PROTOCOL_VERSION = 2`. Tasks 5 and 7 read `cmd.spec`; the agent answers unchanged.

- [ ] **Step 1: Write the failing parser tests.** Append to the `describe("plugin commands")` block in `node-frames.test.ts`:

```ts
  it("accepts an optional spec alongside the id (phase 3)", () => {
    expect(
      parseNodeCommandBody({ type: "plugin_install", id: "codex", spec: "@subshell-ai/plugin-codex@2.0.0" }),
    ).toEqual({ type: "plugin_install", id: "codex", spec: "@subshell-ai/plugin-codex@2.0.0" });
    // Absent stays absent — the byte-identical v1 shape.
    expect(parseNodeCommandBody({ type: "plugin_install", id: "pi" })).toEqual({ type: "plugin_install", id: "pi" });
  });
  it("rejects a non-string spec rather than coercing", () => {
    expect(parseNodeCommandBody({ type: "plugin_install", id: "pi", spec: 3 })).toBeNull();
    expect(parseNodeCommandBody({ type: "plugin_install", id: "pi", spec: "" })).toBeNull();
  });
```

- [ ] **Step 2: Run to verify they fail.** `cd packages/subshell-protocol && bun test src/__tests__/node-frames.test.ts` — the first case drops `spec` (parser rebuilds the object literally), so it fails on the extra key.

- [ ] **Step 3: Implement.** In `node-frames.ts`, extend the union member (keep the existing docstring, add below it):

```ts
      type: "plugin_install";
      /** Plugin id, which is also its directory name on the node */
      id: string;
      /**
       * npm package spec to install from INSTEAD of the embedded copy
       * (protocol 1 → 2, phase 3): `name`, `@scope/name`, or either with
       * `@version` / `@dist-tag`. Absent means the embedded copy, exactly as
       * in v1, which is why this is the only kind of change the exact-match
       * gate can admit as a pair-release: nobody runs the old side.
       */
      spec?: string;
```

and the parser case:

```ts
    case "plugin_install": {
      if (!isStr(value.id)) return null;
      if (value.spec === undefined) return { type: "plugin_install", id: value.id };
      if (!isStr(value.spec) || value.spec === "") return null;
      return { type: "plugin_install", id: value.id, spec: value.spec };
    }
```

Then `export const NODE_PROTOCOL_VERSION = 2;` and update its docstring's
restart paragraph's last sentence to: `the numbering restarted at 1 on
2026-09-09 and 1 → 2 was the first real bump (phase 3, the registry)`.
Update the version pin test to `toBe(2)` with a comment naming phase 3.

- [ ] **Step 4: Docs.** `docs/node-protocol.md`: in the `plugin_install` row
append: `An optional spec (protocol v2) names an npm package to fetch — `name`, `@scope/name`, optionally `@version` or `@dist-tag`; absent means the embedded copy this build carries. The node does the fetching (the §8.1 trust model lives in docs/security.md)`. In §11's restart bullet add the sentence `1 → 2 was the first real bump (phase 3, registry installs)`.

- [ ] **Step 5: Verify red-then-green discipline.** Revert the parser case to the v1 shape (drop `spec`), run the new tests, watch the first fail; restore.

- [ ] **Step 6: Full check + commit.**

```bash
bunx turbo build --filter=@internal/subshell-protocol && bunx turbo run verify-types --force && bun run lint:check && bun run test
git add -A && git commit -m "feat(protocol): plugin_install carries an optional npm package spec (1 -> 2, phase 3)"
```

(Commit messages end with the `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer; expect downstream red until tasks 5/7 land only in `bun run test`'s agent/server packages if the union type forces call-site changes — it should not, the field is optional.)

---

### Task 2: The vendored tar reader (lane A)

**Files:**
- Create: `packages/pane-runtime/src/tar-vendor.ts`
- Create: `packages/pane-runtime/src/__tests__/tar-vendor.test.ts`
- Modify: `packages/pane-runtime/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractTgz(tgz: Uint8Array, opts?: TgzLimits): TarEntry[]`, `interface TarEntry { path: string; content: Uint8Array }`, `interface TgzLimits { maxTotalBytes?: number; maxEntries?: number }` (defaults 20 * 1024 * 1024 / 1024, spec §2.8). Task 4 consumes it. Throws `Error` naming the rule violated.

- [ ] **Step 0 (measurement gate, spec §7): probe the compiled binary FIRST.** Write `/tmp/tgz-probe.ts`:

```ts
const z = Bun.gzipSync(new TextEncoder().encode("hello"));
const back = new TextDecoder().decode(Bun.gunzipSync(z));
const sig = AbortSignal.timeout(50);
console.log(back === "hello" && sig.aborted === false ? "PRIMITIVES OK" : "PRIMITIVES BROKEN");
```

`bun build --compile /tmp/tgz-probe.ts -o /tmp/tgz-probe && /tmp/tgz-probe` must print `PRIMITIVES OK`. If it does not, STOP the task and report: the plan's gzip assumption came from bun 1.4 docs, and compiled-binary differences are this repo's known trap. Record the measured result in the module docstring.

- [ ] **Step 1: Write the tar-WRITER test helper** (top of `tar-vendor.test.ts`; ustar is simple enough to emit in-test, and a fixture generator we control is exactly what the hostile cases need):

```ts
/** Minimal ustar writer: enough of the format to exercise every reader rule. */
function makeTgz(entries: Array<{ path: string; content: string | Uint8Array; type?: "0" | "5" | "2" | "1" | "x"; mode?: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const body = typeof e.content === "string" ? new TextEncoder().encode(e.content) : e.content;
    const header = new Uint8Array(512);
    const put = (s: string, off: number, len: number) => header.set(new TextEncoder().encode(s.padEnd(len, "\0")).subarray(0, len), off);
    const base = e.path.replace(/^package\//, "").split("/")[0];
    put(base, 0, 100); // name (single-segment names for fixtures)
    put((e.mode ?? "644").padStart(7, "0"), 100, 8);
    put("0".padStart(7, "0"), 108, 8); // uid
    put("0".padStart(7, "0"), 116, 8); // gid
    put(body.length.toString(8).padStart(11, "0"), 124, 12); // size
    put("0".padStart(11, "0"), 136, 12); // mtime
    put("        ", 148, 8); // checksum placeholder before computing
    let sum = 0;
    for (const b of header) sum += b;
    put(sum.toString(8).padStart(7, "0") + "\0 ", 148, 8);
    put(e.type ?? "0", 156, 1); // file typeflag
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    blocks.push(header);
    // Data is block-PADDED, not just sliced: a 5-byte file still occupies a
    // full 512-byte block (the reader consumes ceil(size/512) blocks per
    // entry — a padding-mismatched fixture would drift and test nothing).
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512 || 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate
  const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    all.set(b, at);
    at += b.length;
  }
  return Bun.gzipSync(all) as Uint8Array;
}
```

- [ ] **Step 2: Write the failing tests** (same file; every one of spec §2.8's rules):

```ts
describe("extractTgz", () => {
  it("unpacks files and strips npm's package/ prefix", () => {
    const tgz = makeTgz([
      { path: "package/package.json", content: '{"name":"x"}' },
      { path: "package/dist/index.js", content: "export default 1;" },
    ]);
    const out = extractTgz(tgz);
    expect(out.map((e) => e.path).sort()).toEqual(["dist/index.js", "package.json"]);
    expect(new TextDecoder().decode(out.find((e) => e.path === "package.json")!.content)).toBe('{"name":"x"}');
  });
  it("skips directory entries but keeps their file paths", () => {
    const out = extractTgz(makeTgz([{ path: "package/dist", content: "", type: "5" }, { path: "package/dist/i.js", content: "x" }]));
    expect(out.map((e) => e.path)).toEqual(["dist/i.js"]);
  });
  it("refuses an absolute entry path", () => {
    expect(() => extractTgz(makeTgz([{ path: "/etc/passwd", content: "x" }]))).toThrow(/path/);
  });
  it("refuses a traversal path", () => {
    expect(() => extractTgz(makeTgz([{ path: "package/../../x", content: "x" }]))).toThrow(/path/);
  });
  it("refuses symlinks and hard links outright", () => {
    for (const type of ["2", "1"] as const) {
      expect(() => extractTgz(makeTgz([{ path: "package/x", content: "", type }]))).toThrow(/type/);
    }
  });
  it("refuses an oversize entry and an over-many entries (limits are injectable)", () => {
    expect(() => extractTgz(makeTgz([{ path: "package/big", content: "x".repeat(4096) }]), { maxTotalBytes: 100 })).toThrow(/size/i);
    expect(() => extractTgz(makeTgz([{ path: "a", content: "1" }, { path: "b", content: "2" }]), { maxEntries: 1 })).toThrow(/entries/i);
  });
  it("refuses a truncated archive (header past the end)", () => {
    const tgz = makeTgz([{ path: "package/a", content: "hello" }]);
    expect(() => extractTgz(tgz.subarray(0, tgz.length - 258))).toThrow();
  });
  it("honours a pax 'path' override for long names", () => {
    const long = `package/${"d".repeat(120)}/index.js`;
    const paxPayload = ` ${long.length} path=${long}\n`;
    const tgz = makeTgz([
      { path: "package/PaxHeaders.0/index.js", content: paxPayload.slice(paxPayload.indexOf(" ") + 1), type: "x" },
      { path: "package/x.js", content: "x" }, // placeholder, real long name comes from pax
    ]);
    // The writer above cannot emit a >100-char name field directly; this is
    // why the pax test builds the header via `x` typeflag and asserts the
    // reader takes the pax path for the NEXT entry.
    const out = extractTgz(tgz);
    expect(out.map((e) => e.path)).toContain("x.js");
  });
});
```

Note the pax test is deliberately two-part; if it fights the writer, build that ONE tgz byte-array by hand in the test (the header fields are documented above). Do not weaken the rule.

- [ ] **Step 3: Run, watch them fail** (`bun test src/__tests__/tar-vendor.test.ts` in `packages/pane-runtime`; import is `../tar-vendor.js`).

- [ ] **Step 4: Implement `tar-vendor.ts`** (no imports beyond what it uses; `Bun.gunzipSync` is ambient in the bun types):

```ts
/**
 * Unpacks one npm `.tgz` (gzip + ustar/pax) into validated entries.
 *
 * Vendored rather than shelled out to `tar(1)` because the agent is a
 * compiled binary in containers that may have no tar (spec §8.1), and
 * vendored rather than a dependency because the agent binary bundles what
 * it imports and this is ~120 lines of format we already must understand
 * to enforce the safety rules. PRIMITIVES MEASURED on bun 1.4.2 in a
 * `--compile` build: Bun.gzipSync/gunzipSync and AbortSignal.timeout work
 * (task-2 probe; spec §7).
 *
 * The limits and refusals are spec §2.8: regular files and directories
 * only — links and devices are refused outright because `npm pack` never
 * emits them, so accepting them would add an escape hatch for nothing;
 * every path must normalize under the root; totals are capped DURING the
 * parse, never after full expansion.
 */
export interface TarEntry {
  path: string;
  content: Uint8Array;
}
export interface TgzLimits {
  maxTotalBytes?: number;
  maxEntries?: number;
}
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1024;

export function extractTgz(tgz: Uint8Array, opts: TgzLimits = {}): TarEntry[] {
  const maxBytes = opts.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const raw = new Uint8Array(Bun.gunzipSync(tgz));
  const dec = new TextDecoder();
  const out: TarEntry[] = [];
  let off = 0;
  let pendingPath: string | undefined; // from a pax header
  let total = 0;
  const field = (blk: Uint8Array, start: number, len: number) => dec.decode(blk.subarray(start, start + len)).replace(/\0.*$/s, "");
  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512);
    off += 512;
    if (header.every((b) => b === 0)) break; // terminator
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

    if (typeflag === "5") continue; // directory: paths are implicit in file entries
    if (typeflag !== "0") throw new Error(`tar: refusing entry type '${typeflag}' (only files are installable)`);

    const rel = safeRelativePath(rawPath);
    total += size;
    if (total > maxBytes) throw new Error(`tar: unpacked size exceeds ${maxBytes} bytes`);
    if (out.length + 1 > maxEntries) throw new Error(`tar: more than ${maxEntries} entries`);
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

/** pax escapes special chars as \xNN (only \0 \n \: get escaped by tar implementations). */
function decodePax(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}
```

(The `field(...)` checksum is NOT verified: the gzip CRC already covers corruption, and a hostile-but-valid archive passes a checksum anyway — what matters are the path/type/size rules. Say this in the docstring.)

- [ ] **Step 5: Export from `index.ts`:** `export { extractTgz, type TarEntry, type TgzLimits } from "./tar-vendor.js";`

- [ ] **Step 6: Revert-verify each guard** (traversal, type refusal, size cap): comment it out, watch its test fail, restore. Then full check + commit:

```bash
cd packages/pane-runtime && bun test src/__tests__/tar-vendor.test.ts
bunx turbo build --filter=@internal/pane-runtime && bun run lint:check && bunx turbo run verify-types --force
git commit -am "feat(pane-runtime): vendored tgz reader that refuses everything npm never ships"
```

---

### Task 3: The npm registry client (lane A)

**Files:**
- Create: `packages/pane-runtime/src/npm-registry.ts`
- Create: `packages/pane-runtime/src/__tests__/npm-registry.test.ts` (with an in-test `Bun.serve` fake)
- Modify: `packages/pane-runtime/src/index.ts`

**Interfaces:**
- Consumes: nothing from task 2 (integrity is on the raw bytes).
- Produces:
  - `DEFAULT_REGISTRY_URL: string`
  - `parsePackageSpec(spec: string): { name: string; range?: string }` — throws naming the rule
  - `resolvePackageVersion(name: string, range: string | undefined, registryUrl?: string): Promise<{ version: string; tarball: string; integrity: string }>` — throws naming the URL tried
  - `fetchVerifiedTarball(resolved, registryUrl?: string): Promise<Uint8Array>` — fetches `dist.tarball` (relative to the registry base), verifies the SRI sha512
- Task 4 consumes all four; test fixtures compute integrity rather than hardcoding it.

- [ ] **Step 1: Write the failing tests** for `parsePackageSpec` first (pure):

```ts
import { describe, expect, it } from "bun:test";
import { parsePackageSpec } from "../npm-registry.js";

describe("parsePackageSpec", () => {
  it("parses bare, scoped, and version/tag-pinned specs", () => {
    expect(parsePackageSpec("pi")).toEqual({ name: "pi" });
    expect(parsePackageSpec("@subshell-ai/plugin-codex")).toEqual({ name: "@subshell-ai/plugin-codex" });
    expect(parsePackageSpec("@subshell-ai/plugin-codex@1.2.3")).toEqual({ name: "@subshell-ai/plugin-codex", range: "1.2.3" });
    expect(parsePackageSpec("thing@latest")).toEqual({ name: "thing", range: "latest" });
  });
  it("refuses semver RANGES by name — resolution is exact-version or dist-tag only", () => {
    expect(() => parsePackageSpec("thing@^1.0.0")).toThrow(/range/);
    expect(() => parsePackageSpec("thing@~1")).toThrow(/range/);
    expect(() => parsePackageSpec("thing@1.x")).toThrow(/range/);
  });
  it("refuses anything not shaped like a package name", () => {
    for (const bad of ["", " ", "@", "a b", "../x", "-x", "x@"]) expect(() => parsePackageSpec(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Implement `parsePackageSpec`:**

```ts
/** npm's own package-name grammar, anchored (scoped | plain), length-capped. */
const NAME_RE = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const TAG_RE = /^[a-z][a-z0-9._-]*$/;
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

export interface PackageSpec {
  name: string;
  /** An exact version or a dist-tag; RANGES are refused here, not half-resolved. */
  range?: string;
}

/**
 * Splits `name[@version-or-tag]`. The split point is the LAST `@` after
 * position 0 — a scoped name's `@` is at 0 by definition. `@scope/pkg` is
 * name-only; `pkg@1.2.3` and `pkg@latest` pin.
 */
export function parsePackageSpec(spec: string): PackageSpec {
  const at = spec.lastIndexOf("@");
  let name = spec;
  let range: string | undefined;
  if (at > 0) {
    name = spec.slice(0, at);
    range = spec.slice(at + 1);
  }
  if (!NAME_RE.test(name)) throw new Error(`'${spec}' is not a valid npm package name`);
  if (range !== undefined && !(VERSION_RE.test(range) || TAG_RE.test(range))) {
    throw new Error(`'${range}' is not a version or dist-tag: registry installs take exact versions or tags, not ranges`);
  }
  return range === undefined ? { name } : { name, range };
}
```

- [ ] **Step 3: The fake registry + fetch tests.** In `npm-registry.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { fetchVerifiedTarball, resolvePackageVersion } from "../npm-registry.js";

const TARBALL = new Uint8Array([1, 2, 3, 4]);
const SRI = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;
let base = "";
/** The abbreviated ("corgi") packument shape: dist-tags + per-version dist. */
function packument(overrides: Record<string, unknown> = {}) {
  return {
    "dist-tags": { latest: "1.1.0" },
    versions: {
      "1.0.0": { name: "thing", version: "1.0.0", dist: { tarball: "/thing-1.0.0.tgz", integrity: SRI } },
      "1.1.0": { name: "thing", version: "1.1.0", dist: { tarball: "/thing-1.1.0.tgz", integrity: SRI } },
      ...overrides,
    },
  };
}
let servedPackument: unknown = packument();
let brokenIntegrity = false;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/thing") return Response.json(servedPackument, { headers: { "content-type": "application/vnd.npm.install-v1+json" } });
      if (p.endsWith(".tgz")) return new Response(brokenIntegrity ? new Uint8Array([9]) : TARBALL);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));
```

Then cases (write all now, watch them fail): resolves the dist-tag `latest`; resolves an exact version; refuses an unknown version naming it and the registry base; refuses a scoped-name packument 404 naming the URL; `fetchVerifiedTarball` returns the bytes when the digest matches and throws `/integrity/i` when `brokenIntegrity` is true (restore it in a `try/finally`); resolves a packument without `dist.integrity` by REFUSING (`/integrity/i`) — no hash, no install.

- [ ] **Step 4: Implement resolution + fetch:**

```ts
export interface ResolvedVersion {
  version: string;
  tarball: string;
  integrity: string;
}

async function getPackument(name: string, registryUrl: string): Promise<Record<string, any>> {
  const url = `${registryUrl.replace(/\/+$/, "")}/${name.split("/").map(encodeURIComponent).join("/")}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`could not reach the registry at ${registryUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`the registry at ${url} answered ${res.status} for '${name}'`);
  return (await res.json()) as Record<string, any>;
}

export async function resolvePackageVersion(name: string, range: string | undefined, registryUrl = DEFAULT_REGISTRY_URL): Promise<ResolvedVersion> {
  const doc = await getPackument(name, registryUrl);
  const version =
    range === undefined ? (doc["dist-tags"]?.latest as string | undefined) : ((doc.versions?.[range] ? range : (doc["dist-tags"]?.[range] as string | undefined)) ?? undefined);
  if (typeof version !== "string") throw new Error(`'${name}' has no ${range ?? "latest"} version at ${registryUrl}`);
  const dist = doc.versions?.[version]?.dist;
  if (typeof dist?.tarball !== "string" || typeof dist?.integrity !== "string" || !dist.integrity.startsWith("sha512-")) {
    throw new Error(`'${name}@${version}' carries no sha512 integrity hash — the install needs it`);
  }
  return { version, tarball: dist.tarball, integrity: dist.integrity };
}

export async function fetchVerifiedTarball(resolved: ResolvedVersion, registryUrl = DEFAULT_REGISTRY_URL): Promise<Uint8Array> {
  const url = resolved.tarball.startsWith("http") ? resolved.tarball : `${registryUrl.replace(/\/+$/, "")}/${resolved.tarball.replace(/^\/+/, "")}`;
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`could not download ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(`tarball for ${resolved.version} exceeds 20 MiB`);
  const seen = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (seen !== resolved.integrity) {
    throw new Error(`integrity mismatch for '${resolved.version}': the registry announced a different digest — nothing was written`);
  }
  return bytes;
}
```

If `dist.tarball` points at a host other than the configured registry (mirrors rewrite tarball URLs), the bytes are fetched as announced and verified against the integrity the SAME server published; that is the §2.7 trust statement, so comment it at the `startsWith("http")` branch.

- [ ] **Step 5: Export, verify guards by reverting (integrity check off → its test fails), full check, commit:**

```bash
git commit -am "feat(pane-runtime): npm registry client — no hash match, no install"
```

---

### Task 4: `installFromRegistry`, the sidecar, and the `installPlugin` facade (lane A)

**Files:**
- Modify: `packages/pane-runtime/src/plugins-dir.ts` (extract `installStaged` from `installEmbedded`; add the new API at the end)
- Create: `packages/pane-runtime/src/__tests__/install-registry.test.ts`
- Modify: `packages/pane-runtime/src/index.ts`

**Interfaces:**
- Consumes: task 2 `extractTgz`, task 3 client, existing `readBuiltIn`/`builtInIds` (`builtin-source.ts`), `parseManifest` (`@subshell-ai/plugin-api`), `createInProcessRuntime().load(dir)` (`plugin-runtime.ts`), `semverLt` (`@internal/subshell-protocol`).
- Produces (all exported):
  - `interface InstallRecord { name: string; version: string; integrity: string; installedAt: string }`
  - `readInstallRecord(dataDir, id): Promise<InstallRecord | null>` (null = embedded or absent)
  - `installPlugin(dataDir: string, opts: { id?: string; spec?: string; registryUrl?: string }): Promise<InstalledPlugin>` — the §2.5 rules; throws when neither id nor spec resolves
  - `interface PluginUpdate { id: string; name: string; from: string; to: string | null }`
  - `resolvePluginUpdates(dataDir, opts?: { id?: string; registryUrl?: string }): Promise<PluginUpdate[]>` (`to: null` = already latest / unresolvable)
  - `installFromRegistry` stays INTERNAL to this module (the facade owns the embedded-first decision; one door).

- [ ] **Step 1: Extract the swap.** In `plugins-dir.ts`, move the staging/swap/restore body of `installEmbedded` into:

```ts
/**
 * Writes `files` into a fresh staging dir, modes it, and swaps it into
 * `<pluginsDir>/<id>` by the rename-aside dance documented on
 * `installEmbedded` (which is now a thin caller). `extraIdChecks` runs
 * against the EXISTING target before the first rename. Both install paths
 * — embedded and registry — share this so the "a killed install never
 * leaves a half-written plugin" property lives in exactly one place.
 */
async function installStaged(
  dataDir: string,
  id: string,
  files: Record<string, string | Uint8Array>,
  assertTarget?: (existing: { manifest: SubshellManifest; hasRecord: boolean } | null) => void,
): Promise<InstalledPlugin> {
  // ...move the body verbatim; writeFiles already accepts Record<string, string>,
  // so widen it to string | Uint8Array (writeFile accepts both), call
  // assertTarget(existsSync(target) ? await readTargetState(target) : null)
  // before `rename(target, retired)`, keep restore-first-then-rm and the finally.
}
```

`installEmbedded` becomes: `assertSafeId` → `readBuiltIn` → `installStaged(dataDir, id, source.files)`. Its existing tests are the regression net for the move; they must pass WITHOUT edits (revert-verify: break the restore path, watch `plugins-dir.test.ts`' interruption cases fail).

- [ ] **Step 2: Write the failing tests** (`install-registry.test.ts`). Fixture factory inside the test, reusing task 2's `makeTgz` idea via a shared test helper — move `makeTgz` into `__tests__/helpers/tgz-fixture.ts` (export it; update task 2's test to import it) and add:

```ts
/** A minimal loadable plugin package as an npm tgz. */
export function makePluginTgz(opts: { name: string; version: string; id?: string; apiVersion?: number; entryBody?: string }): Uint8Array {
  const manifest = {
    name: opts.name,
    version: opts.version,
    type: "module",
    subshell: { apiVersion: opts.apiVersion ?? 1, id: opts.id ?? opts.name.replace(/^(@[^/]+\/)?plugin-/, ""), type: "agent-harness", name: "fixture", entry: "index.js" },
  };
  const entry = opts.entryBody ?? "export default function fixture() { return { manifest: " + JSON.stringify(manifest.subshell) + ", async capabilities() { return { capabilities: [], launch: {}, profile: {} } as never } }; }\n";
  return makeTgz([
    { path: "package/package.json", content: JSON.stringify(manifest) },
    { path: "package/index.js", content: entry },
  ]);
}
```

(The factory object must satisfy the loader's capability validation — model `entryBody` on `packages/plugins/pi/src/index.ts`, which the implementer reads first; if the loader rejects the minimal shape, copy pi's real factory into the fixture rather than weakening the loader check.)
Then the cases, each against an in-test `Bun.serve` fake like task 3's:

```ts
describe("installPlugin", () => {
  it("a bare built-in id never touches the network (spec §2.5 rule 1)", async () => {
    // registryUrl points at a server whose handler FAILS THE TEST if hit.
    const p = await installPlugin(dir, { id: "pi", spec: "pi", registryUrl: trapUrl });
    expect(p.id).toBe("pi");
  });
  it("a pinned-equal version still uses embedded (rule 2), a pinned-different version goes to the registry (rule 3)", async () => {
    const embeddedVersion = (await readBuiltIn("pi"))!.files["package.json"] && JSON.parse((await readBuiltIn("pi"))!.files["package.json"]).version;
    expect((await installPlugin(dir, { id: "pi", spec: `@subshell-ai/plugin-pi@${embeddedVersion}`, registryUrl: trapUrl })).id).toBe("pi");
    // same fake serving pi's own bytes re-published as 99.0.0:
    const up = await installPlugin(dir, { id: "pi", spec: "@subshell-ai/plugin-pi@99.0.0", registryUrl: fakeUrl });
    expect(up.version).toBe("99.0.0");
    expect((await readInstallRecord(dir, "pi"))?.name).toBe("@subshell-ai/plugin-pi");
  });
  it("an unknown id resolves to the manifest's OWN id and records the sidecar (rule 4)", async () => {
    const p = await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: fakeUrl });
    expect(p.id).toBe("third");
    expect(await listInstalled(dir)).toEqual([expect.objectContaining({ id: "third" })]);
  });
  it("refuses when the caller's id disagrees with the manifest's", async () => {
    expect(installPlugin(dir, { id: "wrong", spec: "third-party@1.0.0", registryUrl: fakeUrl })).rejects.toThrow(/third/);
  });
  it("refuses to overwrite another package's claim on the id (spec §2.4)", async () => {
    await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: fakeUrl });
    await expect(installPlugin(dir, { spec: "squatter@1.0.0", registryUrl: fakeUrl2 /* same manifest id "third" */ })).rejects.toThrow(/third-party|squatter/);
  });
  it("a broken module is refused by the pre-swap load and the old copy survives intact", async () => {
    await installPlugin(dir, { id: "pi" }); // embedded, no sidecar
    await expect(installPlugin(dir, { id: "pi", spec: "@subshell-ai/plugin-pi@bad", registryUrl: badModuleUrl })).rejects.toThrow();
    expect((await readInstallRecord(dir, "pi"))).toBeNull(); // the swap never happened
    expect(await listInstalled(dir)).toEqual([expect.objectContaining({ id: "pi" })]);
  });
  it("integrity mismatch: nothing written, previous state intact", async () => {
    await expect(installPlugin(dir, { spec: "tampered@1.0.0", registryUrl: tamperedUrl })).rejects.toThrow(/integrity/i);
    expect(await listInstalled(dir)).toEqual([]);
  });
});
describe("resolvePluginUpdates", () => {
  it("names newer versions for sidecar'd installs only", async () => {
    await installPlugin(dir, { spec: "third-party@1.0.0", registryUrl: fakeUrlLatest1_2 });
    await installPlugin(dir, { id: "pi" });
    const ups = await resolvePluginUpdates(dir, { registryUrl: fakeUrlLatest1_2 });
    expect(ups).toEqual([{ id: "third", name: "third-party", from: "1.0.0", to: "1.2.0" }]);
  });
  it("reports to:null when the record is already at or above latest, and skips embedded installs entirely", async () => {
    // seed 1.2.0 with fake latest 1.1.0; plus a bare embedded pi
  });
});
```

- [ ] **Step 3: Run to verify failure** (imports resolve, functions missing → fail fast).

- [ ] **Step 4: Implement.** At the end of `plugins-dir.ts`:

```ts
import { createHash } from "node:crypto"; // top of file alongside existing imports
import { semverLt } from "@internal/subshell-protocol";
import { parseManifest } from "@subshell-ai/plugin-api";
import { createInProcessRuntime } from "./plugin-runtime.js";
import { extractTgz } from "./tar-vendor.js";
import { DEFAULT_REGISTRY_URL, fetchVerifiedTarball, parsePackageSpec, resolvePackageVersion } from "./npm-registry.js";

const RECORD_FILE = "install.json";
export interface InstallRecord { name: string; version: string; integrity: string; installedAt: string }

export async function readInstallRecord(dataDir: string, id: string): Promise<InstallRecord | null> {
  try {
    assertSafeId(id);
    return JSON.parse(await readFile(join(pluginsDir(dataDir), id, RECORD_FILE), "utf8")) as InstallRecord;
  } catch {
    return null;
  }
}

async function installFromRegistry(dataDir: string, spec: string, expectId: string | undefined, registryUrl: string): Promise<InstalledPlugin> {
  const { name, range } = parsePackageSpec(spec);
  const resolved = await resolvePackageVersion(name, range, registryUrl);
  const tgz = await fetchVerifiedTarball(resolved, registryUrl);
  const files: Record<string, string | Uint8Array> = {};
  for (const e of extractTgz(tgz)) files[e.path] = e.content;
  const pkgRaw = files["package.json"];
  if (pkgRaw === undefined) throw new Error(`'${spec}' has no package.json at its root`);
  const pkg = JSON.parse(typeof pkgRaw === "string" ? pkgRaw : new TextDecoder().decode(pkgRaw)) as Record<string, unknown>;
  const parsed = parseManifest(pkg);
  if (!parsed.ok) throw new Error(`'${spec}': ${parsed.error}`);
  const id = parsed.manifest.id;
  assertSafeId(id);
  if (expectId !== undefined && expectId !== id) throw new Error(`'${spec}' is plugin '${id}', not '${expectId}' — refusing to install it under the wrong id`);
  // The record rides INSIDE the swap so it can never describe a different
  // copy than the one it names.
  files[RECORD_FILE] = `${JSON.stringify({ name, version: resolved.version, integrity: resolved.integrity, installedAt: new Date().toISOString() } satisfies InstallRecord, null, 2)}\n`;
  // Load-check BEFORE anything moves (spec §8.1): the staging dir is a
  // plugin directory as far as the loader is concerned.
  const stagingForCheck = await mkdtemp(join(pluginsDir(dataDir), `.tmp-${id}-check-`));
  try {
    await writeFiles(stagingForCheck, files);
    const loaded = await createInProcessRuntime().load(stagingForCheck);
    if ("error" in loaded) throw new Error(`'${spec}' loaded with an error: ${loaded.error}`);
  } finally {
    await rm(stagingForCheck, { recursive: true, force: true });
  }
  return await installStaged(dataDir, id, files, (existing) => {
    if (existing?.hasRecord && existing.record?.name && existing.record.name !== name) {
      throw new Error(`'${existing.record.name}' already claims plugin id '${id}' (installed ${existing.record.version}) — uninstall it before installing '${name}' under that id`);
    }
  });
}
```

(The `assertTarget` hook's argument therefore carries `record` too: type it `(existing: { manifest: SubshellManifest; record: InstallRecord | null } | null) => void` and fill it by reading `package.json` + `install.json` from the target — adjust step 1's sketch accordingly and keep ONE definition.)

And the facade:

```ts
/**
 * The one install door (spec §2.5's four rules, stated once):
 * - spec absent → embedded `id` (the v1 meaning, unchanged);
 * - spec pins no version and names a built-in id → embedded, no network;
 * - spec pins the embedded version → embedded (no byte churn);
 * - otherwise → registry, and a pinned version the registry cannot answer is
 *   an ERROR, never a silent fallback.
 * Both hosts call this; the agent's command handler and CLI are thin.
 */
export async function installPlugin(dataDir: string, opts: { id?: string; spec?: string; registryUrl?: string }): Promise<InstalledPlugin> {
  const registryUrl = opts.registryUrl ?? DEFAULT_REGISTRY_URL;
  if (opts.spec === undefined) {
    if (opts.id === undefined) throw new Error("install needs an id or a spec");
    return await installEmbedded(dataDir, opts.id);
  }
  const { name, range } = parsePackageSpec(opts.spec);
  const builtinCandidate = opts.id ?? name;
  if ((await builtInIds()).includes(builtinCandidate)) {
    if (range === undefined) return await installEmbedded(dataDir, builtinCandidate);
    const embeddedVersion = JSON.parse((await readBuiltIn(builtinCandidate))!.files["package.json"]).version as string;
    if (range === embeddedVersion) return await installEmbedded(dataDir, builtinCandidate);
  }
  return await installFromRegistry(dataDir, opts.spec, opts.id, registryUrl);
}

export interface PluginUpdate { id: string; name: string; from: string; to: string | null }

/** Newest registry version for every sidecar'd install (embedded installs are never upgraded behind their operator). */
export async function resolvePluginUpdates(dataDir: string, opts: { id?: string; registryUrl?: string } = {}): Promise<PluginUpdate[]> {
  const out: PluginUpdate[] = [];
  for (const p of await listInstalled(dataDir)) {
    if (opts.id !== undefined && p.id !== opts.id) continue;
    const record = await readInstallRecord(dataDir, p.id);
    if (!record) continue;
    try {
      const latest = await resolvePackageVersion(record.name, undefined, opts.registryUrl ?? DEFAULT_REGISTRY_URL);
      out.push({ id: p.id, name: record.name, from: record.version, to: semverLt(record.version, latest.version) ? latest.version : null });
    } catch (err) {
      // "could not ask" is reported, never guessed at — but it is not an update.
      pluginLog().warn(`update check for '${record.name}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
```

Export `installPlugin`, `readInstallRecord`, `resolvePluginUpdates`, `type InstallRecord`, `type PluginUpdate` from `index.ts`.

- [ ] **Step 5: Revert-verify** each §2.5 rule and the collision check; **full check + commit** `"feat(pane-runtime): registry installs with an install.json record and one honest load-check"`.

---

### Task 5: Agent — command handler + `registryUrl` config (lane C)

**Files:**
- Modify: `apps/node/agent/src/commands/basics.ts` (`execPluginInstall` ~line 298)
- Modify: `apps/node/agent/src/config.ts` (`AgentConfig`)
- Modify: `apps/node/agent/src/configure.ts` + `apps/node/agent/src/cli.ts` (`--registry-url` on `configure`)
- Test: `apps/node/agent/src/__tests__/plugin-commands.test.ts`, `configure.test.ts`

**Interfaces:** Consumes task 1's `cmd.spec` and task 4's `installPlugin`. Produces `AgentConfig.registryUrl?: string` (task 6 reads it).

- [ ] **Step 1: Failing tests** in `plugin-commands.test.ts` (reuse its `ctxFor`; add an in-file fake registry Bun.serve like task 3's): a `{ type: "plugin_install", id: "third", spec: "third-party@1.0.0" }` installs against the fake and answers `ok:true` with the whole set, and a second inventory event was pushed; `spec` absent still answers the embedded copy (existing tests unchanged — the regression net); an unreachable `registryUrl` answers `ok:false` naming the URL. `configure.test.ts`: `--registry-url` rewrites the key and keeps identity fields (mirror its existing "keeps nodeId/nodeKey" test).

- [ ] **Step 2: Implement.** `execPluginInstall` body's `installEmbedded(ctx.config.dataDir, cmd.id)` becomes `installPlugin(ctx.config.dataDir, { id: cmd.id, spec: cmd.spec, registryUrl: ctx.config.registryUrl })` (import from `@internal/pane-runtime`; adjust the docstring: the command now names a registry source when `spec` is present, embedded otherwise). `AgentConfig`:

```ts
  /**
   * npm registry base for plugin installs (phase 3). Optional; unset means
   * https://registry.npmjs.org. A corporate mirror is the motivating case —
   * integrity comes from THAT host, so a plain-http mirror is the operator's
   * own trust decision (spec 2026-09-09-registry §2.7).
   */
  registryUrl?: string;
```

`configure.ts` + cli: `--registry-url` value flag on `configure` (COMMAND_FLAGS entry), validated with `new URL(v)` requiring http(s) scheme, written to the config; USAGE line updated.

- [ ] **Step 3: Revert-verify the spec branch (always-embedded → registry test fails); full check + commit** `"feat(agent): plugin installs can name a registry source; --registry-url configures the mirror"`.

---

### Task 6: Agent — `subshell plugin list|install|uninstall|update` (lane C)

**Files:**
- Modify: `apps/node/agent/src/cli.ts` (COMMANDS, SUBCOMMANDS, SUBCOMMAND_FLAGS, COMMAND_FLAGS, `arg` positional, `plugin` case, USAGE)
- Test: `apps/node/agent/src/__tests__/cli-plugin.test.ts` (new)

**Interfaces:** Consumes `installPlugin`, `listInstalled`, `readInstallRecord`, `uninstallPlugin`, `resolvePluginUpdates`, `buildPluginReports` (pane-runtime), `AgentConfig.registryUrl`, and the test seam `RunDeps` (extend).

- [ ] **Step 1: Parser extension tests** in `cli.test.ts` (which drives `parseArgs` directly): `parseArgs(["plugin","install","@scope/pkg@1.2.3"])` → `{ command: "plugin", sub: "install", arg: "@scope/pkg@1.2.3", flags: {} }`; a second bare token errors `too many arguments to 'plugin install'`; `plugin list --json` OK; `plugin install --json` refuses (`--json` valid only for list/update via SUBCOMMAND_FLAGS); `plugin bogus` names the four verbs.

- [ ] **Step 2: Implement the parser bit.** `COMMANDS` += `"plugin"`; `SUBCOMMANDS.plugin = ["install", "list", "uninstall", "update"]`; `SUBCOMMAND_FLAGS.plugin = { list: ["--json"], update: ["--json"], install: [], uninstall: [] }`; `COMMAND_FLAGS.plugin = ["--json"]`; new module constant beside SUBCOMMANDS:

```ts
/** Commands whose SUBTOKEN takes exactly one bare positional (the spec/id). */
const POSITIONAL_SUBCOMMANDS = new Set(["install", "uninstall", "update"]);
```

In the loop, AFTER the subtoken branch:

```ts
    if (sub !== undefined && !rest[i].startsWith("--") && command === "plugin" && POSITIONAL_SUBCOMMANDS.has(sub)) {
      if (arg !== undefined) throw new UsageError(`too many arguments to '${command} ${sub}'`);
      arg = rest[i];
      continue;
    }
```

with `let arg: string | undefined;`, `ParsedArgs.arg?: string`, and require-arg for install/uninstall (`plugin install` with none → UsageError naming it).

- [ ] **Step 3: Behaviour tests** in `cli-plugin.test.ts`. `run()` needs real fs; use `SUBSHELL_CONFIG_HOME`+temp dataDir like `config.test.ts` does, and a `RunDeps` field for tests only:

```ts
export interface RunDeps {
  service?: ServiceDeps;
  /** Test seam for the plugin verbs: registry base + data dir override. */
  plugin?: { registryUrl?: string; dataDir?: string };
}
```

Cases: `plugin install pi` (embedded path, offline-safe: the fake trap registry MUST NOT be hit); `plugin install third-party@1.0.0` against the Bun.serve fake → prints `installed third@1.0.0 (third-party)`; `plugin list --json` → `[{ id, version, broken?, package?, packageVersion? }]` (package fields only for sidecar'd installs); `plugin uninstall third` → prints removal, exit 0, and uninstalling absent prints the same success (idempotence is the contract); `plugin update --json` reports `[]` for embedded-only installs.

- [ ] **Step 4: Implement the `plugin` case** in `run()`'s switch: load config (absent config → exit 1 naming `subshell enroll`, matching `status`'s behaviour), `dataDir = deps.plugin?.dataDir ?? cfg.dataDir`, `registryUrl = deps.plugin?.registryUrl ?? cfg.registryUrl`. dispatch on `parsed.sub`: `list` → `listInstalled` + per-id `readInstallRecord`; `install` → `installPlugin(dataDir, { id: parsed.arg && (await builtInIds()).includes(parsed.arg) ? parsed.arg : undefined, spec: parsed.arg, registryUrl })` — plus the restart-required log line pattern from `execPluginInstall` (a stale copy IS loaded now if… it is not loaded here; instead print `note: a running agent keeps its loaded copy until restart` when the id was already installed before); `uninstall` → `uninstallPlugin` (id must equal arg; `assertSafeId` errors exit 1); `update` → `resolvePluginUpdates`, then for each with `to` non-null `installPlugin(dataDir, { spec: \`${u.name}@${u.to}\`, registryUrl })`; `--json` prints the arrays verbatim; human output is one line per plugin: `<id> <version>` + ` (from <package>@<packageVersion>)` when a record exists. Update USAGE:

```
  subshell plugin list [--json]
  subshell plugin install <name|@scope/pkg[@version]> [--json omitted]
  subshell plugin uninstall <id>
  subshell plugin update [<id>] [--json]
```

- [ ] **Step 5: Revert-verify (embedded trap test: make the facade always fetch → the trap server's test-fail fires). Full check + commit** `"feat(agent): subshell plugin — list, install, uninstall, update from the terminal"`.

---

### Task 7: Server — spec passthrough on both doors + local registry install + `status` line (lane D)

**Files:**
- Modify: `apps/server/api/src/constants.ts`
- Modify: `apps/server/api/src/services/nodes/local-plugins.ts`
- Modify: `apps/server/api/src/services/nodes/plugin-sync.ts`
- Modify: `apps/server/api/src/api/nodes/set-node-plugin.route.ts`
- Modify: `apps/server/api/src/commands/status.ts`
- Tests: `plugin-sync` / `local-plugins` / `node-harnesses-route` / status tests beside each

**Interfaces:** Consumes `installPlugin` (pane-runtime) and protocol `spec`. The setup route is NOT touched (spec §13); say so in the route docstring.

- [ ] **Step 1: constants.ts** beside `NODE_ARTIFACTS_DIR`:

```ts
/**
 * The npm registry `local` fetches plugin installs from (phase 3). The URL
 * doubles as the integrity authority — see the security doc's registry
 * paragraph. The agent-side counterpart lives in its own config.json
 * (`registryUrl`), same default, two homes because two processes.
 */
export const SUBSHELL_PLUGIN_REGISTRY_URL = env
  .get("SUBSHELL_PLUGIN_REGISTRY_URL")
  .default("https://registry.npmjs.org")
  .asString()
  .replace(/\/+$/, "");
```

- [ ] **Step 2: Failing tests first.** `local-plugins.test.ts`: `installLocalPlugin("third", "third-party@1.0.0")` against an in-test fake registry installs, mirrors, and seeds profiles; a spec that fails integrity leaves the node row unchanged. `node-harnesses-route` style route test (admin cookie): `POST /api/nodes/local/plugins { pluginId, spec }` → 200 and the mirror gains the plugin; `spec: "bad@^1"` → 400 naming it. `plugin-sync` agent-path test (scripted node, same idiom as `commands` tests server-side): body `{pluginId, spec}` sends `{ type: "plugin_install", id, spec }` verbatim (assert the captured command object). Setup-route tests must still pass untouched — its built-in-only refusal tests are the §13 guard; if any currently sends a `spec`, it must 400.

- [ ] **Step 3: Implement.** `installLocalPlugin(pluginId: string, spec?: string)`: `await installPlugin(SUBSHELL_SERVER_DATA_DIR, { id: pluginId, spec, registryUrl: SUBSHELL_PLUGIN_REGISTRY_URL })` replacing `installEmbedded` (keep mirror + profile seeding). `installNodePlugin(node, pluginId, spec?)`: local branch — when `spec` undefined keep the exact `builtInIds()` 400 check; when present, `try { parsePackageSpec(spec) } catch { throw new HarnessStateError(String(err…), 400) }` then proceed; agent branch `send(node, spec === undefined ? { type: "plugin_install", id: pluginId } : { type: "plugin_install", id: pluginId, spec })`. Route: `PluginBodySchema` += `spec: t.Optional(t.String({ description: "npm package spec to fetch on the node (name, @scope/name, optionally @version/@dist-tag); absent installs this build's embedded copy" }))`; pass `body.spec`; audit metadata adds `spec` when present; extend the route docstring with: `**The setup route deliberately keeps NO spec passthrough (spec §13): it answers with no credential at all on a fresh instance, so it stays held to embedded built-in ids. This route is cookie-admin/owner-gated, which is what makes forwarding a package name safe.**`
- `commands/status.ts`: add `pluginRegistry: SUBSHELL_PLUGIN_REGISTRY_URL` to `StatusView` and the line `plugin registry      = <url>` beside `mcp entrypoint`; extend the existing status test's expectations.

- [ ] **Step 4: Revert-verify** the spec-400 and the embedded-only guard still closes the setup door. Full check + commit `"feat(server): plugin install routes accept a registry spec; local installs from the same door"`.

---

### Task 8: The npm publishing pipeline (lane E)

**Files:**
- Modify: `.github/workflows/release.yml` (changesets job ~line 122)
- Modify: `package.json` (root scripts)

**Interfaces:** none consumed; produces the CI path that publishes `@subshell-ai/plugin-*` + `@subshell-ai/plugin-api` via OIDC. The plugin packages already carry `publishConfig.access: public`; `privatePackages.tag: false` already keeps `@internal/*` untagged; nothing in `.changeset/config.json` changes (verified: the `ignore` list holds only `@internal/*`).

- [ ] **Step 1: Edit the changesets job.** Replace the action block with:

```yaml
      - run: rm -f "$HOME/.npmrc"   # OIDC, never a token: npm must not find an auth to prefer (spec §8.3)

      - uses: changesets/action@fdf536a68c4154480c89b42547f8102cf0d8bc47 # v2.1.1
        with:
          # Publish exists from phase 3 on: the five plugin packages and
          # @subshell-ai/plugin-api ship to npm via OIDC trusted publishing
          # (no NPM_TOKEN anywhere). Trusted publishing must be configured
          # per package on npmjs.com by a human FIRST; until then the
          # publish step 403s, which is loud, correct, and expected.
          version-script: bun run version-packages
          publish-script: bun run publish-packages
          commit-message: "chore: release package(s)"
          pr-title: "chore: release package(s)"
          create-github-releases: false
          # A published version with no tag is unreviewable; `changesets tag`
          # only tags PUBLISHABLE packages (privatePackages.tag is false), so
          # the @internal workspaces stay tagless and the app tags remain the
          # publish job's own `<app>-v*` namespace.
          push-git-tags: true
```

and add `id-token: write` to that job's `permissions` block (alongside its existing `contents: write`). Root `package.json` scripts: `"publish-packages": "changeset publish"`.

- [ ] **Step 2: Verify the workflow parses** (`bunx --bun js-yaml` via node, or `actionlint` if on PATH — else a `bun -e` YAML check with any parser already in node_modules) and that `bun run publish-packages --help` exits 0 (changesets CLI present).

- [ ] **Step 3: Commit** `"ci(publishing): the version PR can now publish the plugin packages to npm via OIDC"` + push. Record in the commit body the human step from §8.3 (npmjs trusted-publishing config per package; a 403 until then).

---

### Task 9: Docs, e2e, and the whole-suite pass (lane F)

**Files:**
- Modify: `docs/security.md` (registry paragraph, spec §5), `.claude/rules/security-context.md` (two lines), `docs/architecture.md` (§9 distribution sentence), `apps/node/agent/AGENTS.md` (CLI table rows), `apps/server/api/AGENTS.md` (the route/constants sentence)
- Modify: `e2e/ports.ts`, `e2e/stack.ts`, `e2e/global-setup.ts` (whichever wires env + teardown)
- Create: `e2e/tests/14-registry-install.spec.ts`, `e2e/fixtures/plugin-demo/` (package.json + index.js + tsconfig-free plain JS)

- [ ] **Step 1: Docs.** `docs/security.md`: carry master-spec §13's four bullets into the new Nodes-registry paragraph plus the two sentences from THIS plan's spec §5 (registry URL is operator-configurable, integrity is only as strong as the channel to the registry you configured; the id-switches-across-uninstall note). `.claude/rules/security-context.md`: one bullet: installing from the registry is owner-only via the node routes, setup stays embedded-only. `apps/node/agent/AGENTS.md`: add `subshell plugin list|install|uninstall|update` rows to the CLI table with one line each.

- [ ] **Step 2: e2e fake registry in the stack.** `e2e/ports.ts`: `PORTS = { backend: 3199, fakeRegistry: 3198 }`. The fake runs inside `stack.ts` (bun process, Bun.serve) and serves ONE package `e2e-demo` whose tgz it builds at boot: `Bun.spawnSync(["bun", "pm", "pack", "--pack-destination", tmp])` in `e2e/fixtures/plugin-demo/` (fixture: `package.json` with a `subshell` block `{"apiVersion":1,"id":"e2e-demo","type":"agent-harness","name":"E2E demo","entry":"index.js"}` + an `index.js` default-exporting a minimal factory modelled on `packages/plugins/pi/src/index.ts` — read it and mirror its exact export shape), reads `package.tgz` bytes, computes `sha512-<b64>` with `node:crypto`, answers `/e2e-demo` (abbreviated packument, latest 1.0.0, tarball `/e2e-demo-1.0.0.tgz`) and that tarball path. Server child env: `SUBSHELL_PLUGIN_REGISTRY_URL: "http://127.0.0.1:3198"`. Stop the fake in teardown. The fixture must pass the loader's load-check — verify by installing it once from a unit-level test in the same run before relying on it in e2e (this task's step 3 test IS that check).

- [ ] **Step 3: Write `14-registry-install.spec.ts`** (admin state, same shape as 13; no web UI sends a spec yet — phase 4 adds the input, and this spec's comment says so):

```ts
import { expect, test } from "@playwright/test";
import { ADMIN_STATE } from "./helpers";

test.use({ storageState: ADMIN_STATE });

/**
 * Registry installs through the control plane's owned door (spec
 * 2026-09-09-registry). The bytes come from stack.ts's fake registry
 * (port 3198) — no public network in the suite, ever. There is no web
 * input for a spec yet (phase 4 owns the UI); this spec pins the API +
 * mirror half, which is everything the card will later drive.
 */
test("install a third-party plugin from the registry on the host, and the node reports it", async ({ page, request }) => {
  await request.post("/api/nodes/local/plugins", { data: { pluginId: "e2e-demo", spec: "e2e-demo@1.0.0" } }).then((r) => expect(r.ok(), await r.text()).toBe(true));
  await expect.poll(async () => {
    const res = await request.get("/api/nodes/local");
    if (!res.ok()) return false;
    const view = (await res.json()) as { harnesses: { harnessId: string }[] };
    return view.harnesses.some((h) => h.harnessId === "e2e-demo");
  }, { timeout: 10_000 }).toBe(true);
  await page.goto("/nodes/local");
  await expect(page.locator("div.rounded-lg", { has: page.getByText("Plugins", { exact: true }) }).getByText("E2E demo", { exact: true })).toBeVisible();
  // The install record rode the swap:
  const res = await request.delete("/api/nodes/local/plugins/e2e-demo");
  expect(res.ok(), await res.text()).toBe(true);
  await expect.poll(async () => {
    const view = (await (await request.get("/api/nodes/local")).json()) as { harnesses: { harnessId: string }[] };
    return view.harnesses.some((h) => h.harnessId === "e2e-demo");
  }).toBe(false);
});
```

(DELETE path: check the existing DELETE route's param shape in `set-node-plugin.route.ts` and mirror it exactly; adjust the request if the path differs.)

- [ ] **Step 4: Full verification:** `bunx turbo run verify-types --force && bun run lint:check && bun run test`, then `bun run test:e2e` (all specs; 01/12/13/14 all green; the zero-byte bun-1.4.2 baseline remains the only known unit failure). Tick this plan's checkboxes as they complete and the spec §16 lines they satisfy.

- [ ] **Step 5: Stand the code review** over the whole phase's diff (`/code-review` against the commit range from `9d26f1b`'s successor through HEAD), act on findings with revert-verified tests, commit, push.

---

## Self-Review notes (plan author, 2026-09-09)

- **Spec coverage:** §2.1 → tasks 1/5/7; §2.2 module table → 2/3/4 (with the `registry.ts` name collision resolved in the spec); §2.3 → no code, stated in task 7's route docstring; §2.4 sidecar/collision → 4; §2.5 four rules → 4 (test per rule); §2.6 → 4 (resolve) + 6 (verb); §2.7 → 5 (agent) + 7 (server) + 9 (security prose); §2.8 → 2 (every rule a fixture); §3 failure table → tests in 3/4; §4 publishing → 8; §5 docs → 9; §6 testing → each task + 9; §7 landmines → task 2 step 0 (compiled probe), global constraint (no new deps), task 4 (load-check pre-swap), task 1 (census note: the protocol tests ARE the census for command shape).
- **Known drafting hedges, deliberate:** task 4's fixture entry factory says "model on pi's src, copy it if the minimal shape fails validation" — that is an instruction to read a specific in-repo file, not a TBD; the alternative (pasting pi's factory from memory) is how wrong plans get written.
- **Type consistency:** `installPlugin(dataDir, {id?, spec?, registryUrl?})`, `InstallRecord`, `PluginUpdate`, `parsePackageSpec` names are used identically in tasks 4/5/6/7; the agent's `RunDeps.plugin` seam is defined in task 6 only.

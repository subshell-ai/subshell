/**
 * Compiled-binary streaming probe for the node archive transfer
 * (docs/superpowers/specs/2026-10-01-node-archive-transfer-design.md §1).
 *
 * WHY THIS EXISTS. Every gzip primitive measured in a COMPILED Bun agent so far
 * is SYNC and whole-buffer: `Bun.gzipSync`/`gunzipSync` (the tar-vendor note)
 * and streaming fetch + `Bun.CryptoHasher` (the update path). A sync writer
 * means the full uncompressed tar lives in RAM - dead at GB scale. Whether a
 * STREAMING gzip transform survives `bun build --compile --bytecode` was never
 * measured. This probe measures it, so the archive writer's shape is decided
 * by data. Dev-only tooling: it is never imported by shipped code.
 *
 * RUN:
 *   bun build --compile --bytecode --minify ./scripts/archive-streaming-probe.ts --outfile /tmp/archive-probe
 *   ARCHIVE_PROBE_MB=400 /tmp/archive-probe        # the gate
 *   ARCHIVE_PROBE_MB=400 bun ./scripts/archive-streaming-probe.ts   # source reference
 *
 * Each candidate phase runs in a fresh child so peak RSS (VmHWM) attributes to
 * exactly one primitive. VERDICT (read from the printed table):
 *   - a phase is USABLE when round-trip=OK AND peak RSS stays far under the
 *     input size (streaming, not buffering - the whole-buffer phase is the
 *     negative control showing what non-streaming costs);
 *   - the archive writer uses the best USABLE streaming phase (zlib preferred,
 *     cstream second);
 *   - if neither streams, the writer falls back to multi-member gzipSync (the
 *     concatenation row's round-trip is then load-bearing: Bun must accept
 *     member-stacked gzip, which is legal per RFC 1952).
 * The chosen verdict is recorded in the archive format module's header.
 *
 * MEASURED VERDICT (bun 1.4.2, Linux x64, `--bytecode --minify`, 400 MB /
 * 100 files, PRIMITIVES OK):
 *   zlib        round-trip OK   peakRSS  62.2MB  <- streaming, flat at baseline
 *   cstream     round-trip OK   peakRSS  98.9MB  <- streaming, second choice
 *   members     round-trip OK   peakRSS 1240.0MB (the member-wise verify shape
 *                                         of THIS probe, not the primitive)
 *   wholebuffer round-trip OK   peakRSS 1640.6MB <- negative control, non-streaming
 * DECISION: the archive writer and extractor STREAM through node:zlib
 * createGzip/createGunzip (with node:stream pipeline); the multi-member
 * gzipSync fallback is NOT needed. One incidental finding the members phase
 * caught: Bun.gunzipSync silently decompresses ONLY THE FIRST MEMBER of a
 * member-stacked gzip (system gunzip accepts the stack) - never assume the
 * sync one-shot reads a concatenated stream. Re-run this probe if Bun's Node
 * zlib compat or the compile flags change.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const MB = 1024 * 1024;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a probe knob, never read by shipped code or turbo
const TOTAL_BYTES = Number(process.env.ARCHIVE_PROBE_MB ?? "400") * MB;
const FILE_BYTES = 4 * MB;
const CHUNK = 1 * MB;
const PHASES = ["zlib", "cstream", "members", "wholebuffer"] as const;
type Phase = (typeof PHASES)[number];

function peakRssBytes(): number {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"));
    if (m?.[1]) return Number(m[1]) * 1024;
  } catch {
    // no procfs (macOS dev box): sampled RSS is the best available
  }
  return process.memoryUsage().rss;
}

const fmt = (b: number): string => `${(b / MB).toFixed(1)}MB`;

/** Deterministic, hard-to-compress bytes (LCG-fed; NOT zero-fill). */
function syntheticBlock(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 24) ^ (i & 0xff);
  }
  return out;
}

interface Tree {
  dir: string;
  files: string[];
  total: number;
  sha256: string;
}

function makeTree(): Tree {
  const dir = mkdtempSync(join(tmpdir(), "archive-probe-"));
  const hasher = createHash("sha256");
  const files: string[] = [];
  let total = 0;
  let seed = 1;
  while (total < TOTAL_BYTES) {
    const size = Math.min(FILE_BYTES, TOTAL_BYTES - total);
    const path = join(dir, `f${String(files.length).padStart(5, "0")}.bin`);
    const block = syntheticBlock(size, seed++);
    writeFileSync(path, block);
    hasher.update(block);
    files.push(path);
    total += size;
  }
  return { dir, files, total, sha256: hasher.digest("hex") };
}

function hashingSink(hasher: ReturnType<typeof createHash>): Writable {
  return new Writable({
    write(chunk: Uint8Array, _enc, cb) {
      hasher.update(chunk);
      cb();
    },
  });
}

async function phaseZlib(tree: Tree, gzPath: string): Promise<boolean> {
  // pipeline (not a hand-rolled drain loop): the probe measures whether Bun's
  // node:zlib streams WORK compiled, and Bun's own composition is the honest
  // consumer to test. A hang here still answers the gate's question.
  try {
    await pipeline(
      (async function* () {
        for (const f of tree.files) yield readFileSync(f);
      })(),
      createGzip(),
      createWriteStream(gzPath),
    );
    const hasher = createHash("sha256");
    await pipeline(createReadStream(gzPath), createGunzip(), hashingSink(hasher));
    return hasher.digest("hex") === tree.sha256;
  } catch (err) {
    console.log(`    zlib phase threw: ${(err as Error).message}`);
    return false;
  }
}

async function phaseCstream(tree: Tree, gzPath: string): Promise<boolean> {
  if (typeof CompressionStream === "undefined") {
    console.log("    CompressionStream is undefined in this binary");
    return false;
  }
  try {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    const pump = (async () => {
      for (const f of tree.files) await writer.write(readFileSync(f));
      await writer.close();
    })();
    const out = Bun.file(gzPath).writer();
    const reader = cs.readable.getReader();
    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await out.write(value);
      }
      await out.end();
    })();
    await Promise.all([pump, drain]);
    const inStream = Bun.file(gzPath).stream().pipeThrough(new DecompressionStream("gzip"));
    const hasher = createHash("sha256");
    const r = inStream.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      hasher.update(value);
    }
    return hasher.digest("hex") === tree.sha256;
  } catch (err) {
    console.log(`    cstream phase threw: ${(err as Error).message}`);
    return false;
  }
}

function phaseMembers(tree: Tree, gzPath: string): boolean {
  try {
    // Write member-stacked gzip: one RFC 1952 member per CHUNK of each file.
    const fd = openSync(gzPath, "w");
    const memberEnds: number[] = [];
    let written = 0;
    for (const f of tree.files) {
      const data = readFileSync(f);
      for (let off = 0; off < data.length; off += CHUNK) {
        const member = Bun.gzipSync(data.subarray(off, off + CHUNK));
        writeSync(fd, member);
        written += member.length;
        memberEnds.push(written);
      }
    }
    closeSync(fd);
    // MEASURED ON bun 1.4.2 (this very probe, source mode): `Bun.gunzipSync`
    // silently returns ONLY THE FIRST MEMBER of a stacked stream - the whole
    // stack round-trips through streaming and system gunzip, but not through
    // the sync one-shot. So the fallback's contract is MEMBER-WISE readback
    // (the create answer would carry the member offsets), and this phase
    // verifies exactly that: every member gunzips back to its own chunk, the
    // concatenation hashes to the source, and system gunzip (when present -
    // informational only, never required) accepts the whole stack.
    const stackBytes = readFileSync(gzPath);
    const hasher = createHash("sha256");
    let cursor = 0;
    let memberIndex = 0;
    for (const end of memberEnds) {
      const member = stackBytes.subarray(cursor, end);
      cursor = end;
      hasher.update(Bun.gunzipSync(member));
      memberIndex++;
    }
    if (cursor !== stackBytes.length) {
      console.log("    member offsets do not tile the file");
      return false;
    }
    const okBun = hasher.digest("hex") === tree.sha256;
    const sys = Bun.spawnSync(["gunzip", "-t"], { stdin: new Blob([stackBytes]) });
    if (sys.exitCode === 0) console.log(`    ${memberIndex} members; system gunzip -t: OK (informational)`);
    else if (sys.exitCode > 1) console.log("    system gunzip absent on this box (skipped)");
    else console.log(`    system gunzip REJECTED the stack: ${sys.stderr.toString().slice(0, 120)}`);
    return okBun;
  } catch (err) {
    console.log(`    members phase threw: ${(err as Error).message}`);
    return false;
  }
}

async function phaseWholeBuffer(tree: Tree): Promise<boolean> {
  // NEGATIVE CONTROL: the non-streaming shape. Same work, RAM proportional to
  // input - this row's RSS is the number the design refuses to accept.
  const parts: Uint8Array[] = [];
  const hasher = createHash("sha256");
  for (const f of tree.files) {
    const d = readFileSync(f);
    parts.push(d);
    hasher.update(d);
  }
  const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    whole.set(p, off);
    off += p.length;
  }
  const gz = Bun.gzipSync(whole);
  return Bun.gunzipSync(gz).length === tree.total && hasher.digest("hex") === tree.sha256;
}

async function runPhase(phase: Phase, tree: Tree): Promise<boolean> {
  const gzPath = join(tree.dir, `${phase}.gz`);
  switch (phase) {
    case "zlib":
      return await phaseZlib(tree, gzPath);
    case "cstream":
      return await phaseCstream(tree, gzPath);
    case "members":
      return phaseMembers(tree, gzPath);
    case "wholebuffer":
      return await phaseWholeBuffer(tree);
  }
}

async function childMain(phase: Phase): Promise<void> {
  const tree = makeTree();
  try {
    const ok = await runPhase(phase, tree);
    console.log(`RESULT ${JSON.stringify({ phase, ok, peakRss: peakRssBytes() })}`);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
}

function driverMain(): void {
  const isCompiled = !process.argv[1]?.endsWith(".ts");
  console.log(
    `archive-streaming-probe: input=${fmt(TOTAL_BYTES)} files=${Math.ceil(TOTAL_BYTES / FILE_BYTES)} ` +
      `mode=${isCompiled ? "COMPILED" : "source"} execPath=${process.execPath}`,
  );
  const rows: { phase: Phase; ok: boolean | string; peak: number }[] = [];
  const self = process.argv[1] ?? "";
  for (const phase of PHASES) {
    const child = Bun.spawnSync([process.execPath, ...(isCompiled || self === "" ? [] : [self])], {
      env: { ...process.env, ARCHIVE_PROBE_PHASE: phase },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = child.stdout.toString();
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) {
      console.error(`phase ${phase} produced no RESULT:\n${out}${child.stderr.toString()}`);
      rows.push({ phase, ok: "NO-RESULT", peak: 0 });
      continue;
    }
    for (const note of out.split("\n").filter((l) => l.startsWith("    "))) console.log(note);
    const parsed = JSON.parse(line.slice("RESULT ".length)) as { ok: boolean; peakRss: number };
    rows.push({ phase, ok: parsed.ok, peak: parsed.peakRss });
  }
  console.log("phase         round-trip  peakRSS");
  for (const r of rows) console.log(`${r.phase.padEnd(13)}  ${String(r.ok).padEnd(11)}  ${fmt(r.peak)}`);
  const streaming = rows.filter((r) => (r.phase === "zlib" || r.phase === "cstream") && r.ok === true);
  const verdict =
    streaming.length > 0
      ? `VERDICT: streaming gzip usable via ${streaming.map((r) => r.phase).join("+")}; writer may stream`
      : rows.find((r) => r.phase === "members")?.ok === true
        ? "VERDICT: no streaming primitive round-tripped; writer = multi-member gzipSync fallback"
        : "VERDICT: NOTHING round-tripped; STOP and re-read the design (§1)";
  console.log(verdict);
}

// Entry: top-level await is refused by `bun build --compile`, so the async
// child path is driven through a voided promise with a hard exit-code set.
void (async () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the driver's child-handoff, internal to this script
  const phase = process.env.ARCHIVE_PROBE_PHASE as Phase | undefined;
  if (phase) {
    await childMain(phase);
  } else {
    driverMain();
  }
})().catch((err: unknown) => {
  console.error(`archive-probe fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});

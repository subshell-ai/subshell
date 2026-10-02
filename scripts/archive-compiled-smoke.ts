/**
 * The compiled-binary archive smoke (spec 2026-10-01 §7): the node agent ships
 * as `bun build --compile`, and the compiled runtime has burned this repo
 * before (sync-gzip-only measurement in archive-streaming-probe.ts, the zod
 * bundler trap). This drives the transfer archive's real writer and extractor
 * INSIDE a compiled binary - a tree with a >100-byte pax name and a 4 MiB
 * file - and asserts the extracted bytes. Prints "SMOKE OK".
 *
 *   bun build --compile scripts/archive-compiled-smoke.ts --outfile /tmp/s2-smoke && /tmp/s2-smoke
 *
 * It imports the pane-runtime SOURCE, not the package barrel: the barrel
 * resolves through dist/, and a stale dist once let this smoke run yesterday's
 * code while still printing SMOKE OK. The multi-MB file exists to keep the
 * extractor's backpressure wait honest: a dead once()-listener per write cycle
 * tripped MaxListenersExceededWarning in the compiled binary at the 11th.
 */
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTarGz } from "../packages/pane-runtime/src/tar-extractor.js";
import { writeTarGz } from "../packages/pane-runtime/src/tar-writer.js";

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "s2-smoke-"));
  try {
    const src = join(base, "src");
    mkdirSync(join(src, "deep"), { recursive: true });
    writeFileSync(join(src, "small.txt"), "hello compiled world\n");
    const longName = `deep/${"seg-".repeat(30)}pax-name.txt`; // > 100 bytes: the pax header path
    writeFileSync(join(src, longName), "pax payload");
    const big = new Uint8Array(4 * 1024 * 1024).fill(0xab);
    writeFileSync(join(src, "deep", "big.bin"), big);

    const tgz = join(base, "out.tar.gz");
    const st = performance.now();
    const { entries } = await writeTarGz(
      [{ path: "deep" }],
      [
        { path: "small.txt", sourcePath: join(src, "small.txt"), size: 21 },
        { path: longName, sourcePath: join(src, longName), size: 11 },
        { path: "deep/big.bin", sourcePath: join(src, "deep", "big.bin"), size: big.byteLength },
      ],
      createWriteStream(tgz),
      { maxFileBytes: 2 ** 31, maxTotalBytes: 2 ** 32, maxEntries: 1000 },
    );
    const writeMs = Math.round(performance.now() - st);
    if (entries !== 4) throw new Error(`expected 4 entries (3 files + 1 dir), got ${entries}`);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(readFileSync(tgz));
    const sha = hasher.digest("hex");
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("digest shape wrong");

    const out = join(base, "out");
    const r = await extractTarGz(tgz, out, { maxFileBytes: 2 ** 31, maxTotalBytes: 2 ** 32, maxEntries: 1000 });
    if (r.files !== 3) throw new Error(`extracted ${r.files} files, expected 3`);
    if (readFileSync(join(out, "small.txt"), "utf8") !== "hello compiled world\n") throw new Error("small.txt drift");
    if (readFileSync(join(out, longName), "utf8") !== "pax payload") throw new Error("pax name drift");
    const landed = readFileSync(join(out, "deep", "big.bin"));
    if (landed.byteLength !== big.byteLength) throw new Error("big.bin size drift");
    for (let i = 0; i < landed.byteLength; i += 4096) if (landed[i] !== 0xab) throw new Error("big.bin byte drift");

    console.log(`SMOKE OK (write ${writeMs} ms, archive ${sha.slice(0, 12)}…, extracted ${r.bytes} bytes)`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("SMOKE FAIL", err);
  process.exit(1);
});

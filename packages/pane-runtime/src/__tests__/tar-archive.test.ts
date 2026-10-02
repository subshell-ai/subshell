import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCK,
  blockPadding,
  buildHeader,
  isZeroBlock,
  needsPax,
  parseHeader,
  paxOverridePath,
  paxRecord,
  safeTransferPath,
} from "../tar-blocks.js";
import { extractTarGz } from "../tar-extractor.js";
import { extractTgz } from "../tar-vendor.js";
import { type ArchiveLimits, writeTarGz } from "../tar-writer.js";
import { handBuiltTgz, makeTgz } from "./helpers/tgz-fixture.js";

/**
 * The transfer archive format core (spec 2026-10-01 §3): shared blocks, the
 * streaming writer, and the guarded streaming extractor. The extractor's
 * refusals are the security surface, so they are exercised with CRAFTED hostile
 * archives (the tgz-fixture helpers), not just round-trips.
 */

const LIMITS: ArchiveLimits = { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxEntries: 500 };
const dir = mkdtempSync(join(tmpdir(), "tar-archive-"));

async function fileTo(path: string, data: string | Uint8Array): Promise<void> {
  writeFileSync(path, typeof data === "string" ? data : Buffer.from(data));
}

/** Write `dirs`/`files` to a .gz in `dir`, returning the archive path. */
async function buildArchive(
  name: string,
  dirs: Parameters<typeof writeTarGz>[0],
  files: Parameters<typeof writeTarGz>[1],
  limits: ArchiveLimits = LIMITS,
): Promise<{ path: string; entries: number; tarBytes: number; gzBytes: number }> {
  const path = join(dir, `${name}.tar.gz`);
  const sink = createWriteStream(path);
  const res = await writeTarGz(dirs, files, sink, limits);
  return { path, ...res, gzBytes: statSync(path).size };
}

describe("tar-blocks: path guard", () => {
  it("normalizes clean relative paths", () => {
    expect(safeTransferPath("a/b/c.txt")).toBe("a/b/c.txt");
    expect(safeTransferPath("./a//b/./c")).toBe("a/b/c");
    expect(safeTransferPath("package/index.js")).toBe("package/index.js"); // NO npm strip here
  });
  it("refuses absolute, traversal, empty, and NUL/newline-bearing paths", () => {
    expect(() => safeTransferPath("/etc/passwd")).toThrow(/absolute/);
    expect(() => safeTransferPath("../escape")).toThrow(/traversal/);
    expect(() => safeTransferPath("a/../../escape")).toThrow(/traversal/);
    expect(() => safeTransferPath("")).toThrow(/empty/);
    expect(() => safeTransferPath("a\0b")).toThrow(/absolute|empty/);
    // A newline is refused because a pax `path=` override is one
    // newline-delimited line: a long name carrying one would be TRUNCATED at
    // the newline on read (silent wrong-name landing). Both writer and
    // extractor share this guard, so neither side mangles the other's bytes.
    expect(() => safeTransferPath("a\nb")).toThrow(/absolute|empty/);
    expect(() => safeTransferPath(`${"x".repeat(120)}\nname`)).toThrow(/absolute|empty/);
  });
});

describe("tar-blocks: headers and pax", () => {
  it("buildHeader -> parseHeader round-trips the transfer fields", () => {
    const bytes = new TextEncoder().encode("hello/world.txt");
    const block = buildHeader({ nameBytes: bytes, size: 1234, mode: 0o640, mtimeSeconds: 111, typeflag: "0" });
    const h = parseHeader(block);
    expect(h.name).toBe("hello/world.txt");
    expect(h.size).toBe(1234);
    expect(h.mode).toBe(0o640);
    expect(h.mtime).toBe(111);
    expect(h.typeflag).toBe("0");
  });
  it("refuses a name that overflows the 100-byte field", () => {
    expect(() =>
      buildHeader({ nameBytes: new Uint8Array(101), size: 0, mode: 0o644, mtimeSeconds: 0, typeflag: "0" }),
    ).toThrow(/name field overflow/);
  });
  it("paxRecord's declared length equals its actual byte length", () => {
    for (const value of ["short", "x".repeat(200), "ünïcøde/path/名前"]) {
      const rec = paxRecord("path", value);
      const declared = Number.parseInt(new TextDecoder().decode(rec.subarray(0, rec.indexOf(0x20))), 10);
      expect(rec.length).toBe(declared);
      expect(paxOverridePath(rec)).toBe(value);
    }
  });
  it("needsPax triggers past 100 UTF-8 bytes, not at the boundary", () => {
    expect(needsPax("a".repeat(100))).toBe(false);
    expect(needsPax("a".repeat(101))).toBe(true);
    expect(needsPax("é".repeat(50))).toBe(false); // 50 chars but exactly 100 bytes: fits
    expect(needsPax("é".repeat(51))).toBe(true); // 102 bytes: the byte count decides, not the char count
  });
  it("isZeroBlock and blockPadding", () => {
    expect(isZeroBlock(new Uint8Array(BLOCK))).toBe(true);
    expect(
      isZeroBlock(buildHeader({ nameBytes: new Uint8Array(3), size: 0, mode: 0, mtimeSeconds: 0, typeflag: "0" })),
    ).toBe(false);
    expect(blockPadding(0)).toBe(0);
    expect(blockPadding(5)).toBe(BLOCK - 5);
    expect(blockPadding(BLOCK)).toBe(0);
  });
});

describe("writer + extractor round-trip", () => {
  let archive: { path: string; entries: number; tarBytes: number; gzBytes: number };
  const longName = `deep/nested/dir/${"seg-".repeat(20)}final-long-file-name.txt`; // > 100 bytes -> pax

  beforeAll(async () => {
    const small = join(dir, "src_small.txt");
    const big = join(dir, "src_big.bin");
    mkdirSync(join(dir, "src"), { recursive: true });
    fileTo(small, "tiny content\n");
    const bigData = new Uint8Array(5000).map((_, i) => i & 0xff);
    writeFileSync(big, Buffer.from(bigData));
    const nestedLong = join(dir, "src", longName.replace(/^.*\//, "")); // real file name
    fileTo(nestedLong, "long-name payload");

    archive = await buildArchive(
      "roundtrip",
      [{ path: "emptydir" }, { path: "deep/nested/dir" }],
      [
        { path: "small.txt", sourcePath: small, size: statSync(small).size, mode: 0o600 },
        { path: "nested/big.bin", sourcePath: big, size: bigData.length },
        { path: longName, sourcePath: nestedLong, size: statSync(nestedLong).size },
      ],
    );
  });

  it("produces a non-trivial compressed archive", () => {
    expect(archive.gzBytes).toBeGreaterThan(0);
    expect(archive.entries).toBe(5); // 2 dirs + 3 files
  });

  it("extracts every file with correct bytes, and honors recorded modes", async () => {
    const out = join(dir, "out1");
    const r = await extractTarGz(archive.path, out, LIMITS);
    expect(r.files).toBe(3);
    expect(readFileSync(join(out, "small.txt"), "utf8")).toBe("tiny content\n");
    expect(statSync(join(out, "small.txt")).mode & 0o777).toBe(0o600);
    // No mtime was stated in this archive (the writer's 0 default) — the file
    // keeps its write time; a stated one is restored (see the next test).
    expect(statSync(join(out, "small.txt")).mtimeMs).toBeGreaterThan(1_700_000_000_000);
    const bigOut = readFileSync(join(out, "nested/big.bin"));
    expect(bigOut.length).toBe(5000);
    expect(bigOut[4999]).toBe(4999 & 0xff);
    // The pax long name survives and lands at the right place.
    expect(readFileSync(join(out, longName), "utf8")).toBe("long-name payload");
    expect(statSync(join(out, "emptydir")).isDirectory()).toBe(true);
    expect(statSync(join(out, "deep/nested/dir")).isDirectory()).toBe(true);
  });

  it("restores recorded mtimes and leaves unstated (0) ones at write time", async () => {
    const small = join(dir, "src_small.txt");
    const arc = await buildArchive(
      "mtime",
      [],
      [
        { path: "stated.txt", sourcePath: small, size: statSync(small).size, mtimeSeconds: 111 },
        { path: "unstated.txt", sourcePath: small, size: statSync(small).size },
      ],
    );
    const out = join(dir, "out-mtime");
    await extractTarGz(arc.path, out, LIMITS);
    expect(Math.floor(statSync(join(out, "stated.txt")).mtimeMs / 1000)).toBe(111);
    expect(statSync(join(out, "unstated.txt")).mtimeMs).toBeGreaterThan(1_700_000_000_000);
  });

  it("is byte-identical to itself across a rebuild (deterministic layout)", async () => {
    const small = join(dir, "src_small.txt");
    const again = await buildArchive(
      "roundtrip-again",
      [{ path: "emptydir" }, { path: "deep/nested/dir" }],
      [{ path: "small.txt", sourcePath: small, size: statSync(small).size, mode: 0o600 }],
    );
    const expect2 = await buildArchive(
      "roundtrip-again-2",
      [{ path: "emptydir" }, { path: "deep/nested/dir" }],
      [{ path: "small.txt", sourcePath: small, size: statSync(small).size, mode: 0o600 }],
    );
    expect(readFileSync(again.path)).toEqual(readFileSync(expect2.path));
  });

  it("its output parses under the existing vendored reader too (cross-tool sanity)", () => {
    // A small archive with no `package/` top dir: extractTgz reads regular files
    // and skips dirs; a pax name is handled by that reader as well. Proves the
    // ustar bytes are spec-shaped, not merely self-consistent.
    const entries = extractTgz(new Uint8Array(readFileSync(archive.path)), {
      maxTotalBytes: 16_000_000,
      maxEntries: 500,
    });
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toContain("small.txt");
    expect(paths).toContain("nested/big.bin");
    expect(paths).toContain(longName);
    const smallEntry = entries.find((e) => e.path === "small.txt");
    expect(new TextDecoder().decode(smallEntry?.content ?? new Uint8Array())).toBe("tiny content\n");
  });

  it("extracts a multi-MB file without stacking listeners on the destination", async () => {
    // The backpressure wait once raced two events.once() calls; the loser's
    // listener stayed attached, so one 4 MiB file piled dead "error" listeners
    // on a single WriteStream and tripped MaxListenersExceededWarning at the
    // 11th in the COMPILED binary. The wait now removes both listeners itself;
    // this asserts the process never hears a listener warning during extract.
    const warnings: string[] = [];
    const spy = (w: Error): void => {
      warnings.push(w.name);
    };
    process.on("warning", spy);
    try {
      const src = join(dir, "src_4mb.bin");
      writeFileSync(src, Buffer.alloc(4 * 1024 * 1024, 0xcd));
      const arc = await buildArchive("mb4", [], [{ path: "big.bin", sourcePath: src, size: 4 * 1024 * 1024 }]);
      const out = join(dir, "out-4mb");
      const r = await extractTarGz(arc.path, out, LIMITS);
      expect(r.files).toBe(1);
      expect(readFileSync(join(out, "big.bin")).every((b) => b === 0xcd)).toBe(true);
    } finally {
      process.off("warning", spy);
    }
    expect(warnings.filter((n) => n.includes("MaxListeners"))).toEqual([]);
  });
});

describe("writer refusals", () => {
  it("refuses to place an entry at a traversal path", async () => {
    const src = join(dir, "ok.txt");
    fileTo(src, "x");
    await expect(buildArchive("evil-path", [], [{ path: "../escape.txt", sourcePath: src, size: 1 }])).rejects.toThrow(
      /traversal/,
    );
  });
  it("refuses when the true file size drifts from the declared size", async () => {
    const src = join(dir, "drift.txt");
    fileTo(src, "actual content that is long");
    await expect(buildArchive("drift", [], [{ path: "d.txt", sourcePath: src, size: 3 }])).rejects.toThrow(/drifted/);
  });
  it("refuses a declared size past the per-file cap", async () => {
    const src = join(dir, "cap.txt");
    fileTo(src, "content");
    await expect(
      buildArchive("cap", [], [{ path: "c.txt", sourcePath: src, size: 99_000_000 }], {
        ...LIMITS,
        maxFileBytes: 1024,
      }),
    ).rejects.toThrow(/per-file cap/);
  });
});

describe("extractor refusals (hostile archives)", () => {
  const hostile = async (name: string, tgz: Uint8Array<ArrayBuffer>, limits: ArchiveLimits = LIMITS) => {
    const p = join(dir, `${name}.tar.gz`);
    writeFileSync(p, Buffer.from(tgz));
    const out = join(dir, `${name}-out`);
    mkdirSync(out, { recursive: true });
    return await extractTarGz(p, out, limits);
  };

  it("refuses a traversal name", async () => {
    await expect(hostile("h-trav", makeTgz([{ path: "../evil.txt", content: "nope" }]))).rejects.toThrow(/traversal/);
  });
  it("refuses an absolute name", async () => {
    await expect(hostile("h-abs", makeTgz([{ path: "/etc/evil.txt", content: "nope" }]))).rejects.toThrow(/absolute/);
  });
  it("refuses a pax override that escapes, even though the header name looked safe", async () => {
    const paxBody = paxRecord("path", "../../escaped.txt");
    const archive = handBuiltTgz([
      { name: "./PaxHeaders/.x", typeflag: "x", body: paxBody },
      { name: "innocent.txt", typeflag: "0", body: new TextEncoder().encode("nope") },
    ]);
    await expect(hostile("h-pax", archive)).rejects.toThrow(/traversal/);
  });
  it("refuses a symlink entry", async () => {
    await expect(hostile("h-sym", makeTgz([{ path: "link", content: "/etc/passwd", type: "2" }]))).rejects.toThrow(
      /refusing entry type '2'/,
    );
  });
  it("refuses a declared size past the per-file cap", async () => {
    const body = new Uint8Array(4096);
    await expect(
      hostile("h-bigfile", makeTgz([{ path: "big.bin", content: body }]), { ...LIMITS, maxFileBytes: 1024 }),
    ).rejects.toThrow(/per-file cap/);
  });
  it("refuses past the entry-count cap without extracting the excess", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    await expect(hostile("h-count", makeTgz(entries), { ...LIMITS, maxEntries: 5 })).rejects.toThrow(
      /more than 5 entries/,
    );
  });
  it("refuses when the total body exceeds the archive cap", async () => {
    const body = new Uint8Array(3000).fill(7);
    await expect(
      hostile(
        "h-total",
        makeTgz([
          { path: "a.bin", content: body },
          { path: "b.bin", content: body },
        ]),
        {
          ...LIMITS,
          maxTotalBytes: 4096,
        },
      ),
    ).rejects.toThrow(/total exceeds/);
  });
  it("tolerates a truncated archive by throwing, not by writing garbage", async () => {
    // Header claims 100 bytes, the stream provides 50 and stops: the body
    // reader must not fabricate. Built by hand because the fixture's frame()
    // always sizes the header to the body it is given.
    const e = new TextEncoder();
    const hdr = new Uint8Array(BLOCK);
    hdr.set(e.encode("short.txt"), 0);
    hdr.set(e.encode("0000644\0"), 100); // mode
    hdr.set(e.encode("0000144"), 124); // size = octal 144 = 100
    hdr.set(e.encode("0000000\0"), 136); // mtime
    hdr.fill(0x20, 148, 156);
    hdr.set(e.encode("0"), 156);
    hdr.set(e.encode("ustar\0"), 257);
    hdr.set(e.encode("00"), 263);
    let sum = 0;
    for (const b of hdr) sum += b;
    hdr.set(e.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    const tgz = Bun.gzipSync(new Uint8Array([...hdr, ...new Uint8Array(50)])); // missing 50 bytes + terminator
    await expect(hostile("h-trunc", tgz)).rejects.toThrow(/truncated/);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

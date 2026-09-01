import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureGitExcluded,
  remoteUniqueName,
  resolveUploadPath,
  safeUploadName,
  UploadError,
  uploadsDirFor,
  writeUpload,
} from "../uploads.service.js";

const created: string[] = [];

/** Makes a throwaway working directory, cleaned up after each test. */
function tempWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mote-upload-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-27T14:32:10Z");

/** Byte length, not UTF-16 code units — the filesystem limit is in bytes. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

describe("uploadsDirFor", () => {
  it("nests uploads under .mote in the working directory", () => {
    expect(uploadsDirFor("/ws")).toBe("/ws/.mote/uploads");
  });
});

describe("safeUploadName", () => {
  it("timestamp-prefixes a clean name", () => {
    expect(safeUploadName("screenshot.png", null, NOW)).toBe("20260827-143210-screenshot.png");
  });

  it("replaces spaces so the path never needs quoting", () => {
    expect(safeUploadName("my holiday photo.png", null, NOW)).toBe("20260827-143210-my-holiday-photo.png");
  });

  it("strips directory components", () => {
    const name = safeUploadName("../../etc/passwd", null, NOW);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("strips control characters", () => {
    expect(safeUploadName("a\x00b\x1bc.txt", null, NOW)).toBe("20260827-143210-abc.txt");
  });

  it("defuses a Windows reserved name", () => {
    expect(safeUploadName("CON.txt", null, NOW)).not.toBe("20260827-143210-CON.txt");
  });

  it("keeps the extension when the reserved stem can't be sniffed", () => {
    // "aux.log" is a plausible real filename (not an attack); sanitize-filename
    // blanks the reserved "aux" stem, but the extension must survive so the
    // upload isn't silently turned into an unlabeled blob.
    expect(safeUploadName("aux.log", null, NOW)).toBe("20260827-143210-pasted.log");
  });

  it("falls back to 'pasted' when nothing usable survives", () => {
    expect(safeUploadName("???", "png", NOW)).toBe("20260827-143210-pasted.png");
  });

  it("prefers the sniffed extension over a lying client one", () => {
    expect(safeUploadName("totally-an-image.png", "pdf", NOW)).toBe("20260827-143210-totally-an-image.pdf");
  });

  it("keeps the name under the 255-byte filesystem limit", () => {
    expect(safeUploadName(`${"a".repeat(400)}.png`, null, NOW).length).toBeLessThanOrEqual(255);
  });

  it("bounds a pathologically long extension to the 255-byte limit", () => {
    const name = safeUploadName(`a.${"x".repeat(300)}`, null, NOW);
    expect(byteLength(name)).toBeLessThanOrEqual(255);
  });

  it("bounds a long stem AND a long extension together", () => {
    const name = safeUploadName(`${"s".repeat(300)}.${"x".repeat(300)}`, null, NOW);
    expect(byteLength(name)).toBeLessThanOrEqual(255);
  });

  it("bounds an extension exactly at the old (unbounded) limit", () => {
    const name = safeUploadName(`a.${"x".repeat(255)}`, null, NOW);
    expect(byteLength(name)).toBeLessThanOrEqual(255);
  });
});

describe("remoteUniqueName", () => {
  it("appends an 8-hex suffix before the extension, keeping the timestamp prefix", () => {
    expect(remoteUniqueName("20260827-143210-photo.jpeg")).toMatch(/^20260827-143210-photo-[0-9a-f]{8}\.jpeg$/);
  });

  it("never repeats a suffix — two same-second relays get distinct names", () => {
    // The deterministic core of the fix: the agent receiver overwrites by
    // contract, and two uploads inside one second share the timestamp
    // prefix, so only the random tag can keep the second from clobbering
    // the first. Same input string ⇒ different outputs, no clock involved.
    expect(remoteUniqueName("20260827-143210-dup.bin")).not.toBe(remoteUniqueName("20260827-143210-dup.bin"));
  });

  it("appends at the end when the name has no extension", () => {
    expect(remoteUniqueName("20260827-143210-noext")).toMatch(/^20260827-143210-noext-[0-9a-f]{8}$/);
  });

  it("truncates the stem so the suffixed name still fits the 255-byte component limit", () => {
    // 255 spelled as a literal (same discipline as the route test's CHUNK):
    // the helper must respect the budget, not tack 9 chars onto a maximal name.
    const stem = "x".repeat(255 - "20260827-143210-".length - ".bin".length);
    const got = remoteUniqueName(`${stem}.bin`);
    expect(byteLength(got)).toBeLessThanOrEqual(255);
    expect(got).toMatch(/-[0-9a-f]{8}\.bin$/);
  });
});

describe("resolveUploadPath", () => {
  it("resolves inside the working directory uploads dir", () => {
    expect(resolveUploadPath("/ws", "a.png")).toBe("/ws/.mote/uploads/a.png");
  });

  it("rejects a name that would escape the working directory", () => {
    expect(() => resolveUploadPath("/ws", "../../../etc/passwd")).toThrow(UploadError);
  });

  it("rejects an absolute name", () => {
    expect(() => resolveUploadPath("/ws", "/etc/passwd")).toThrow(UploadError);
  });
});

describe("ensureGitExcluded", () => {
  it("does nothing when the working directory is not a git repo", () => {
    const ws = tempWorkDir();
    ensureGitExcluded(ws);
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("appends .mote/ to .git/info/exclude", () => {
    const ws = tempWorkDir();
    mkdirSync(join(ws, ".git", "info"), { recursive: true });
    writeFileSync(join(ws, ".git", "info", "exclude"), "# existing\n");
    ensureGitExcluded(ws);
    expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".mote/");
  });

  it("creates info/exclude when absent", () => {
    const ws = tempWorkDir();
    mkdirSync(join(ws, ".git"), { recursive: true });
    ensureGitExcluded(ws);
    expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".mote/");
  });

  it("is idempotent", () => {
    const ws = tempWorkDir();
    mkdirSync(join(ws, ".git", "info"), { recursive: true });
    ensureGitExcluded(ws);
    ensureGitExcluded(ws);
    const body = readFileSync(join(ws, ".git", "info", "exclude"), "utf8");
    expect(body.match(/\.mote\//g)).toHaveLength(1);
  });
});

describe("writeUpload", () => {
  it("writes the file into the working directory and reports its path", async () => {
    const ws = tempWorkDir();
    const file = new File(["hello upload"], "notes.txt", { type: "text/plain" });
    const result = await writeUpload({ workingRealPath: ws, file, now: NOW });
    expect(result.path).toBe(join(ws, ".mote/uploads/20260827-143210-notes.txt"));
    expect(result.name).toBe("20260827-143210-notes.txt");
    expect(result.size).toBe(file.size);
    expect(readFileSync(result.path, "utf8")).toBe("hello upload");
  });

  it("names a PNG from its magic bytes when the client sends no usable name", async () => {
    const ws = tempWorkDir();
    // 8-byte PNG signature followed by a stub IHDR chunk header.
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const file = new File([png], "", { type: "application/octet-stream" });
    const result = await writeUpload({ workingRealPath: ws, file, now: NOW });
    expect(result.name).toBe("20260827-143210-pasted.png");
  });

  it("suffixes on collision instead of overwriting", async () => {
    const ws = tempWorkDir();
    const first = await writeUpload({
      workingRealPath: ws,
      file: new File(["one"], "dup.txt", { type: "text/plain" }),
      now: NOW,
    });
    const second = await writeUpload({
      workingRealPath: ws,
      file: new File(["two"], "dup.txt", { type: "text/plain" }),
      now: NOW,
    });
    expect(second.path).not.toBe(first.path);
    expect(second.name).toBe("20260827-143210-dup-2.txt");
    expect(readFileSync(first.path, "utf8")).toBe("one");
  });

  it("preserves every payload when concurrent uploads share a name (TOCTOU regression)", async () => {
    // Regression for a race where a synchronous existsSync() collision check
    // followed by an awaited write let two concurrent uploads resolving to
    // the same candidate both pass the check before either file landed,
    // silently losing one payload. This mirrors a multi-file drop uploaded
    // via Promise.all, or two same-second pasted screenshots.
    const ws = tempWorkDir();
    const N = 16;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeUpload({
          workingRealPath: ws,
          file: new File([`payload-${i}`], "shot.txt", { type: "text/plain" }),
          now: NOW,
        }),
      ),
    );

    const uniquePaths = new Set(results.map((r) => r.path));
    expect(uniquePaths.size).toBe(N);

    const survivingPayloads = new Set(results.map((r) => readFileSync(r.path, "utf8")));
    expect(survivingPayloads.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(survivingPayloads.has(`payload-${i}`)).toBe(true);
    }
  });
});

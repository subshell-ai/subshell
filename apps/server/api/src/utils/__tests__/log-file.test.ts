import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CappedFileTransport, parseServerLogLine, readServerLogTail, SERVER_LOG_CAP_BYTES } from "@/utils/log-file.js";

const made: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "subshell-log-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseServerLogLine", () => {
  it("reads timestamp, level, message and keeps the rest as data", () => {
    expect(
      parseServerLogLine(
        '{"timestamp":"2026-09-12T10:00:00.000Z","level":"info","message":"hi","context":{"requestId":"r1"}}',
      ),
    ).toEqual({
      ts: "2026-09-12T10:00:00.000Z",
      level: "info",
      message: "hi",
      data: { context: { requestId: "r1" } },
    });
  });
  it("returns a non-JSON line as raw", () => {
    expect(parseServerLogLine("half a li")).toEqual({ ts: "", level: "raw", message: "half a li" });
  });
});

describe("readServerLogTail", () => {
  it("returns the last N lines oldest first, and the file size", async () => {
    const path = join(dir(), "server.log");
    writeFileSync(
      path,
      `${[1, 2, 3, 4, 5].map((i) => JSON.stringify({ timestamp: `t${i}`, level: "info", message: `m${i}` })).join("\n")}\n`,
    );
    const r = await readServerLogTail(path, 2);
    expect(r.lines.map((l) => l.message)).toEqual(["m4", "m5"]);
    expect(r.bytes).toBeGreaterThan(0);
  });
  it("answers empty for a missing file", async () => {
    expect(await readServerLogTail("/nonexistent/server.log", 10)).toEqual({ lines: [], bytes: 0 });
  });
  it("the cap is 200 KB", () => {
    expect(SERVER_LOG_CAP_BYTES).toBe(204_800);
  });
});

describe("CappedFileTransport", () => {
  it("writes one JSON line per log, creating the directory and the file 0600", () => {
    const path = join(dir(), "logs", "server.log");
    const t = new CappedFileTransport(path, SERVER_LOG_CAP_BYTES);
    t.shipToLogger({ logLevel: "info", messages: ["hello"], data: { context: { a: 1 } }, hasData: true } as never);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = parseServerLogLine(text.trim());
    expect(parsed.message).toBe("hello");
    expect(parsed.level).toBe("info");
    expect(parsed.data).toEqual({ context: { a: 1 } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces the file when full: one file, under the cap, and the first line is whole", () => {
    const path = join(dir(), "server.log");
    const cap = 4_096;
    const t = new CappedFileTransport(path, cap);
    for (let i = 0; i < 400; i++) {
      t.shipToLogger({ logLevel: "info", messages: [`line ${i} ${"x".repeat(100)}`], hasData: false } as never);
    }
    const text = readFileSync(path, "utf8");
    expect(statSync(path).size).toBeLessThanOrEqual(cap);
    // Truncation starts a NEW file rather than leaving a severed head, so the
    // first line is always parseable — a partial line can only ever be the
    // last one, from a crash mid-append.
    expect(parseServerLogLine(text.split("\n")[0] ?? "").level).toBe("info");
  });

  it("drops a line below its level, and honours a level changed after construction", () => {
    const path = join(dir(), "server.log");
    const t = new CappedFileTransport(path, SERVER_LOG_CAP_BYTES);
    t._sendToLogger({ logLevel: "debug", messages: ["quiet"], hasData: false } as never);
    expect(() => readFileSync(path)).toThrow();
    t.level = "debug";
    t._sendToLogger({ logLevel: "debug", messages: ["loud"], hasData: false } as never);
    expect(readFileSync(path, "utf8")).toContain("loud");
  });
});

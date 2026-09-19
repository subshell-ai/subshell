import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LOG_CAP_BYTES, CappedFileTransport, readNodeLogSlice } from "../log-file.js";

/** A throwaway directory per case, so nothing here shares a file. */
function dir(): string {
  return mkdtempSync(join(tmpdir(), "subshell-agent-log-"));
}

/** Ship one line through the transport the way LogLayer does. */
function ship(transport: CappedFileTransport, message: string): void {
  transport.shipToLogger({
    logLevel: "info" as never,
    messages: [message],
    data: undefined,
    hasData: false,
  } as never);
}

describe("the agent's own log file", () => {
  it("writes JSON lines the plane's parser can read", () => {
    const path = join(dir(), "agent.log");
    const t = new CappedFileTransport(path, AGENT_LOG_CAP_BYTES);
    ship(t, "connected to the plane");
    const line = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
    expect(line.message).toBe("connected to the plane");
    expect(line.level).toBe("info");
    expect(typeof line.timestamp).toBe("string");
  });

  // 0600, like the pane logs and like the server's own file: it holds whatever
  // this agent said about this machine, and the whole reason the plane may
  // serve it is that the set of people who can read it did not change.
  it("creates the file 0600", () => {
    const path = join(dir(), "agent.log");
    ship(new CappedFileTransport(path, AGENT_LOG_CAP_BYTES), "x");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // REPLACED, not rotated. A rotating transport keeps every rotated file, each
  // one past the cap — which is the behaviour the server measured and rejected.
  it("replaces the file rather than growing past the cap", () => {
    const path = join(dir(), "agent.log");
    const t = new CappedFileTransport(path, 300);
    for (let i = 0; i < 50; i++) ship(t, `line ${i} ${"x".repeat(40)}`);
    const size = statSync(path).size;
    expect(size).toBeLessThanOrEqual(300);
    // And what survives is the NEWEST lines, not the oldest: the file starts
    // over, so the last line written is always in it.
    expect(readFileSync(path, "utf8")).toContain("line 49");
  });

  // A log write must never take the daemon down. The console transport beside
  // it still has the line, so there is nothing to report and nowhere to report
  // it that would not recurse.
  it("swallows a write it cannot make", () => {
    const t = new CappedFileTransport("/proc/nonexistent/agent.log", AGENT_LOG_CAP_BYTES);
    expect(() => ship(t, "x")).not.toThrow();
  });
});

describe("reading a slice of it", () => {
  it("is empty rather than an error when nothing has been logged", async () => {
    const slice = await readNodeLogSlice(join(dir(), "absent.log"), 0, 100);
    expect(slice).toEqual({ text: "", nextByte: 0, size: 0, truncated: false });
  });

  it("returns the requested range and the offset to continue from", async () => {
    const path = join(dir(), "agent.log");
    writeFileSync(path, "abcdefghij");
    const first = await readNodeLogSlice(path, 0, 4);
    expect(first.text).toBe("abcd");
    expect(first.nextByte).toBe(4);
    expect(first.size).toBe(10);
    const rest = await readNodeLogSlice(path, first.nextByte, 100);
    expect(rest.text).toBe("efghij");
    expect(rest.nextByte).toBe(10);
  });

  it("reports nothing new at the end of the file", async () => {
    const path = join(dir(), "agent.log");
    writeFileSync(path, "abc");
    expect(await readNodeLogSlice(path, 3, 100)).toEqual({ text: "", nextByte: 3, size: 3, truncated: false });
  });

  // The file is truncated at the cap, so an offset taken before a replacement
  // does not point at older content — it points past the end of a shorter
  // file. Without this flag a reader would sit there reporting an empty tail
  // forever, which looks exactly like an idle agent.
  it("says truncated when the caller's offset is past the end", async () => {
    const path = join(dir(), "agent.log");
    writeFileSync(path, "short");
    const slice = await readNodeLogSlice(path, 9_000, 100);
    expect(slice.truncated).toBe(true);
    expect(slice.nextByte).toBe(0);
    expect(slice.text).toBe("");
  });
});

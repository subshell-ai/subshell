import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionMeta, SessionMetaStore } from "../session-meta.js";

const base = mkdtempSync(join(tmpdir(), "mote-meta-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Fresh store over a throwaway dataDir; each test gets its own to stay isolated. */
function freshStore(name: string): { store: SessionMetaStore; dataDir: string } {
  const dataDir = join(base, name);
  mkdirSync(dataDir, { recursive: true });
  return { store: new SessionMetaStore(dataDir), dataDir };
}

function meta(id: string): SessionMeta {
  return {
    sessionId: id,
    cwd: `/work/${id}`,
    socket: `/run/mote/${id}.sock`,
    harnessId: "claude-code",
    name: `sess-${id}`,
    startedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("SessionMetaStore", () => {
  it("record → get round-trip; meta lands at sessions/<id>.meta.json with a trailing newline", async () => {
    const { store, dataDir } = freshStore("roundtrip");
    await store.record(meta("s1"));
    expect(await store.get("s1")).toEqual(meta("s1"));
    const file = join(dataDir, "sessions", "s1.meta.json");
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(meta("s1"));
  });

  it("record writes 0600 file inside a 0700 dir even when umask interfered", async () => {
    const { store, dataDir } = freshStore("modes");
    await store.record(meta("s1"));
    const file = join(dataDir, "sessions", "s1.meta.json");
    const dir = join(dataDir, "sessions");
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("get on an unknown id returns undefined without throwing", async () => {
    const { store } = freshStore("unknown");
    expect(await store.get("nope")).toBeUndefined();
  });

  it("junk JSON → get is undefined with exactly one log line, and list skips it", async () => {
    const { store, dataDir } = freshStore("junk");
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(join(dataDir, "sessions", "bad.meta.json"), "{not json");
    await store.record(meta("good"));
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...parts: unknown[]) => {
      lines.push(parts.join(" "));
    };
    try {
      expect(await store.get("bad")).toBeUndefined();
    } finally {
      console.log = orig;
    }
    expect(lines.length).toBe(1);
    const listed = await store.list();
    expect(listed.map((m) => m.sessionId)).toEqual(["good"]);
  });

  it("list scans the sessions dir, .meta.json only, sorted by id; empty when dir absent", async () => {
    const { store, dataDir } = freshStore("list");
    await store.record(meta("s2"));
    await store.record(meta("s1"));
    writeFileSync(join(dataDir, "sessions", "s3.log"), "pane output, not meta\n");
    writeFileSync(join(dataDir, "sessions", "readme.txt"), "unrelated\n");
    expect((await store.list()).map((m) => m.sessionId)).toEqual(["s1", "s2"]);
    const { store: empty } = freshStore("list-empty");
    expect(await empty.list()).toEqual([]);
  });

  it("forget removes the meta file and is idempotent", async () => {
    const { store, dataDir } = freshStore("forget");
    const dir = join(dataDir, "sessions");
    await store.record(meta("s1"));
    await store.forget("s1");
    expect(await store.get("s1")).toBeUndefined();
    expect(existsSync(dir)).toBe(true); // the sessions dir itself survives
    await store.forget("s1"); // missing is not an error
    await store.forget("never-existed");
  });

  it("cwdOf returns the recorded cwd, undefined for unknown ids", async () => {
    const { store } = freshStore("cwd");
    await store.record(meta("s1"));
    expect(await store.cwdOf("s1")).toBe("/work/s1");
    expect(await store.cwdOf("nope")).toBeUndefined();
  });

  it("log/mcp paths mirror the spec §7 layout", () => {
    const store = new SessionMetaStore("/d");
    expect(store.logPath("s1")).toBe("/d/sessions/s1.log");
    expect(store.mcpPath("s1")).toBe("/d/mcp/s1.json");
  });
});

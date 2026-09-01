import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionId, type SessionMeta, SessionMetaStore } from "../session-meta.js";

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

const UUID = "2b8f1c9a-4d3e-4a5b-9c6d-7e8f9a0b1c2d";

describe("SessionMetaStore", () => {
  it("record → get round-trip; meta lands at sessions/<id>.meta.json with a trailing newline", async () => {
    const { store, dataDir } = freshStore("roundtrip");
    await store.record(meta(UUID));
    expect(await store.get(UUID)).toEqual(meta(UUID));
    const file = join(dataDir, "sessions", `${UUID}.meta.json`);
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(meta(UUID));
  });

  it("record writes 0600 file inside a 0700 dir even when umask interfered", async () => {
    const { store, dataDir } = freshStore("modes");
    await store.record(meta(UUID));
    const file = join(dataDir, "sessions", `${UUID}.meta.json`);
    const dir = join(dataDir, "sessions");
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("get on an unknown id returns undefined without throwing", async () => {
    const { store } = freshStore("unknown");
    expect(await store.get("dead")).toBeUndefined();
  });

  it("junk JSON → get is undefined with exactly one log line, and list skips it", async () => {
    const { store, dataDir } = freshStore("junk");
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(join(dataDir, "sessions", "bad.meta.json"), "{not json");
    await store.record(meta("f00d"));
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
    expect(listed.map((m) => m.sessionId)).toEqual(["f00d"]);
  });

  it("list scans the sessions dir, .meta.json only, sorted by id; empty when dir absent", async () => {
    const { store, dataDir } = freshStore("list");
    await store.record(meta("a2"));
    await store.record(meta("a1"));
    writeFileSync(join(dataDir, "sessions", "a3.log"), "pane output, not meta\n");
    writeFileSync(join(dataDir, "sessions", "readme.txt"), "unrelated\n");
    expect((await store.list()).map((m) => m.sessionId)).toEqual(["a1", "a2"]);
    const { store: empty } = freshStore("list-empty");
    expect(await empty.list()).toEqual([]);
  });

  it("forget removes the meta file and is idempotent", async () => {
    const { store, dataDir } = freshStore("forget");
    const dir = join(dataDir, "sessions");
    await store.record(meta(UUID));
    await store.forget(UUID);
    expect(await store.get(UUID)).toBeUndefined();
    expect(existsSync(dir)).toBe(true); // the sessions dir itself survives
    await store.forget(UUID); // missing is not an error
    await store.forget("beef");
  });

  it("cwdOf returns the recorded cwd, undefined for unknown ids", async () => {
    const { store } = freshStore("cwd");
    await store.record(meta("a1"));
    expect(await store.cwdOf("a1")).toBe("/work/a1");
    expect(await store.cwdOf("dead")).toBeUndefined();
  });

  it("log/mcp paths mirror the spec §7 layout", () => {
    const store = new SessionMetaStore("/d");
    expect(store.logPath("a1")).toBe("/d/sessions/a1.log");
    expect(store.mcpPath("a1")).toBe("/d/mcp/a1.json");
  });

  it("isSessionId — uuid-ish guard at the untrusted boundary", () => {
    expect(isSessionId(UUID)).toBe(true);
    expect(isSessionId("A1-b")).toBe(true); // case-tolerant hex + hyphen
    expect(isSessionId("s1")).toBe(false); // alphabetic junk is not uuid-ish
    expect(isSessionId("../x")).toBe(false);
    expect(isSessionId("")).toBe(false);
    expect(isSessionId(`${"a".repeat(64)}b`)).toBe(false); // bounded length
  });

  it("hostile ids throw at every path-interpolating entry point", () => {
    const store = new SessionMetaStore("/d");
    expect(() => store.logPath("../../x")).toThrow("invalid session id");
    expect(() => store.mcpPath("../x")).toThrow("invalid session id");
  });

  it("record/get/forget/cwdOf reject hostile ids; uuid-shaped ids round-trip", async () => {
    const { store, dataDir } = freshStore("id-guard");
    await expect(store.record({ ...meta("x"), sessionId: "../x" })).rejects.toThrow("invalid session id");
    expect(existsSync(join(dataDir, "sessions"))).toBe(false); // rejected before any fs side effect
    await expect(store.get("../x")).rejects.toThrow("invalid session id");
    await expect(store.forget("../../x")).rejects.toThrow("invalid session id");
    await expect(store.cwdOf("../x")).rejects.toThrow("invalid session id");
    await store.record(meta(UUID));
    expect(await store.get(UUID)).toEqual(meta(UUID));
    expect(await store.cwdOf(UUID)).toBe(`/work/${UUID}`);
  });

  it("list stays junk-tolerant: bad file names are skipped, never thrown", async () => {
    const { store, dataDir } = freshStore("list-junk");
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    // Well-formed JSON inside, but the FILE name is not a session id — skipped, no throw.
    writeFileSync(join(dataDir, "sessions", "not-an-uuid.meta.json"), JSON.stringify(meta("a1")));
    writeFileSync(join(dataDir, "sessions", "broken.meta.json"), "{nope");
    await store.record(meta("a1"));
    expect((await store.list()).map((m) => m.sessionId)).toEqual(["a1"]);
  });
});

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSubshellId, type SubshellMeta, SubshellMetaStore } from "../subshell-meta.js";

const base = mkdtempSync(join(tmpdir(), "subshell-meta-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Fresh store over a throwaway dataDir; each test gets its own to stay isolated. */
function freshStore(name: string): { store: SubshellMetaStore; dataDir: string } {
  const dataDir = join(base, name);
  mkdirSync(dataDir, { recursive: true });
  return { store: new SubshellMetaStore(dataDir), dataDir };
}

function meta(id: string): SubshellMeta {
  return {
    subshellId: id,
    cwd: `/work/${id}`,
    socket: `/run/subshell/${id}.sock`,
    harnessId: "claude-code",
    name: `sess-${id}`,
    startedAt: "2026-09-01T00:00:00.000Z",
  };
}

const UUID = "2b8f1c9a-4d3e-4a5b-9c6d-7e8f9a0b1c2d";

describe("SubshellMetaStore", () => {
  it("record → get round-trip; meta lands at subshells/<id>.meta.json with a trailing newline", async () => {
    const { store, dataDir } = freshStore("roundtrip");
    await store.record(meta(UUID));
    expect(await store.get(UUID)).toEqual(meta(UUID));
    const file = join(dataDir, "subshells", `${UUID}.meta.json`);
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(meta(UUID));
  });

  it("record writes 0600 file inside a 0700 dir even when umask interfered", async () => {
    const { store, dataDir } = freshStore("modes");
    await store.record(meta(UUID));
    const file = join(dataDir, "subshells", `${UUID}.meta.json`);
    const dir = join(dataDir, "subshells");
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
    mkdirSync(join(dataDir, "subshells"), { recursive: true });
    writeFileSync(join(dataDir, "subshells", "bad.meta.json"), "{not json");
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
    expect(listed.map((m) => m.subshellId)).toEqual(["f00d"]);
  });

  it("pre-rename meta (sessionId key) migrates on read; junk still rejected", async () => {
    const { store, dataDir } = freshStore("legacy-key");
    mkdirSync(join(dataDir, "subshells"), { recursive: true });
    const legacy = {
      sessionId: UUID,
      cwd: `/work/${UUID}`,
      socket: `/run/subshell/${UUID}.sock`,
      harnessId: "claude-code",
      name: `sess-${UUID}`,
      startedAt: "2026-09-01T00:00:00.000Z",
    };
    writeFileSync(join(dataDir, "subshells", `${UUID}.meta.json`), `${JSON.stringify(legacy)}\n`);
    // The rollout's `mv` carries pre-rename bytes; get/list must see a valid
    // meta with subshellId populated (from sessionId), never a silent miss.
    // (`legacy` differs from `meta(UUID)` only by the key name.)
    expect(await store.get(UUID)).toEqual(meta(UUID));
    // Genuinely malformed stays malformed: no subshellId, no sessionId string.
    writeFileSync(join(dataDir, "subshells", "f00d.meta.json"), JSON.stringify({ ...legacy, sessionId: 42 }));
    expect(await store.get("f00d")).toBeUndefined();
    expect((await store.list()).map((m) => m.subshellId)).toEqual([UUID]);
  });

  it("list scans the subshells dir, .meta.json only, sorted by id; empty when dir absent", async () => {
    const { store, dataDir } = freshStore("list");
    await store.record(meta("a2"));
    await store.record(meta("a1"));
    writeFileSync(join(dataDir, "subshells", "a3.log"), "pane output, not meta\n");
    writeFileSync(join(dataDir, "subshells", "readme.txt"), "unrelated\n");
    expect((await store.list()).map((m) => m.subshellId)).toEqual(["a1", "a2"]);
    const { store: empty } = freshStore("list-empty");
    expect(await empty.list()).toEqual([]);
  });

  it("forget removes the meta file and is idempotent", async () => {
    const { store, dataDir } = freshStore("forget");
    const dir = join(dataDir, "subshells");
    await store.record(meta(UUID));
    await store.forget(UUID);
    expect(await store.get(UUID)).toBeUndefined();
    expect(existsSync(dir)).toBe(true); // the subshells dir itself survives
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
    const store = new SubshellMetaStore("/d");
    expect(store.logPath("a1")).toBe("/d/subshells/a1.log");
    expect(store.mcpPath("a1")).toBe("/d/mcp/a1.json");
  });

  it("isSubshellId — uuid-ish guard at the untrusted boundary", () => {
    expect(isSubshellId(UUID)).toBe(true);
    expect(isSubshellId("A1-b")).toBe(true); // case-tolerant hex + hyphen
    expect(isSubshellId("s1")).toBe(false); // alphabetic junk is not uuid-ish
    expect(isSubshellId("../x")).toBe(false);
    expect(isSubshellId("")).toBe(false);
    expect(isSubshellId(`${"a".repeat(64)}b`)).toBe(false); // bounded length
  });

  it("hostile ids throw at every path-interpolating entry point", () => {
    const store = new SubshellMetaStore("/d");
    expect(() => store.logPath("../../x")).toThrow("invalid subshell id");
    expect(() => store.mcpPath("../x")).toThrow("invalid subshell id");
  });

  it("record/get/forget/cwdOf reject hostile ids; uuid-shaped ids round-trip", async () => {
    const { store, dataDir } = freshStore("id-guard");
    await expect(store.record({ ...meta("x"), subshellId: "../x" })).rejects.toThrow("invalid subshell id");
    expect(existsSync(join(dataDir, "subshells"))).toBe(false); // rejected before any fs side effect
    await expect(store.get("../x")).rejects.toThrow("invalid subshell id");
    await expect(store.forget("../../x")).rejects.toThrow("invalid subshell id");
    await expect(store.cwdOf("../x")).rejects.toThrow("invalid subshell id");
    await store.record(meta(UUID));
    expect(await store.get(UUID)).toEqual(meta(UUID));
    expect(await store.cwdOf(UUID)).toBe(`/work/${UUID}`);
  });

  it("list stays junk-tolerant: bad file names are skipped, never thrown", async () => {
    const { store, dataDir } = freshStore("list-junk");
    mkdirSync(join(dataDir, "subshells"), { recursive: true });
    // Well-formed JSON inside, but the FILE name is not a subshell id — skipped, no throw.
    writeFileSync(join(dataDir, "subshells", "not-an-uuid.meta.json"), JSON.stringify(meta("a1")));
    writeFileSync(join(dataDir, "subshells", "broken.meta.json"), "{nope");
    await store.record(meta("a1"));
    expect((await store.list()).map((m) => m.subshellId)).toEqual(["a1"]);
  });

  it("get×forget race: a fallback read in flight across forget never poisons the mirror", async () => {
    // FORCED interleaving of the flake that killed the real-tmux smoke test
    // (and the fake-tmux watcher test): the watcher forgets the meta, a
    // 10 ms poll's fallback read — already dispatched with the file still
    // present — resolves AFTER the eviction. An unconditional refill caches
    // the deleted record forever (the file is gone, nothing re-reads), so
    // the poll's `get() === undefined` never arrives and the wait times out.
    // Two instances over one dir keep `store` on the file-read fallback path.
    const { store, dataDir } = freshStore("forget-race");
    const sibling = new SubshellMetaStore(dataDir);
    for (let i = 0; i < 200; i++) {
      const id = crypto.randomUUID();
      await sibling.record(meta(id)); // file exists; store has never seen this id
      const inFlight = store.get(id); // mem miss → the readFile is already queued
      await store.forget(id); // evict + unlink land
      await inFlight; // the stale refill (if any) has happened by now
      expect(await store.get(id)).toBeUndefined(); // a poisoned mirror fails the loop here
    }
  });

  it("get×record race: a fallback read in flight across record cannot overwrite the new record", async () => {
    // Same guard, other direction: a read that resolved with PRE-overwrite
    // bytes must not cache them after record's final write landed.
    const { store, dataDir } = freshStore("record-race");
    const sibling = new SubshellMetaStore(dataDir);
    for (let i = 0; i < 200; i++) {
      const id = crypto.randomUUID();
      await sibling.record(meta(id));
      const inFlight = store.get(id); // reads toward the sibling's bytes
      await store.record({ ...meta(id), name: "v2" }); // store takes over the id mid-read
      await inFlight;
      expect((await store.get(id))?.name).toBe("v2");
    }
  });
});

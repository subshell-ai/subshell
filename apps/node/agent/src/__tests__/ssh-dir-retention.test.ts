import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPHAN_SSH_DIR_MIN_AGE_MS, sweepOrphanSshDirs } from "../ssh-dir-retention.js";
import type { SubshellMeta, SubshellMetaStore } from "../subshell-meta.js";

const HOUR_MS = 3_600_000;

// Dir names are uuid-shaped: `isSubshellId` gates the name shape, so the
// tests use ids that pass it and stray names that cannot (same discipline as
// the pane-log retention tests beside this file).
const ID_TRACKED = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_YOUNG = "bbbbbbbb-0000-4000-8000-000000000002";
const ID_AGED = "cccccccc-0000-4000-8000-000000000003";
const ID_NESTED = "dddddddd-0000-4000-8000-000000000004";
const ID_SYMLINK = "eeeeeeee-0000-4000-8000-000000000005";
const ID_OUTSIDE = "ffffffff-0000-4000-8000-000000000006";

function meta(id: string): SubshellMeta {
  return {
    subshellId: id,
    cwd: "/tmp/whatever",
    socket: "sock1",
    harnessId: "ssh",
    name: id,
    startedAt: new Date(0).toISOString(),
  };
}

let dataDir: string;
let sshDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "subshell-ssh-sweep-"));
  sshDir = join(dataDir, "ssh");
  mkdirSync(sshDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Create `<ssh>/<id>` (with a `config` file, the pane's real shape), backdated `ageMs`. */
function makePaneDir(id: string, ageMs: number): string {
  const dir = join(sshDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config"), "Host *\n");
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

/** One sweep against the temp dir with a fake meta store (the retention tests' style). */
async function sweep(ids: string[], nowMs = Date.now()) {
  return await sweepOrphanSshDirs(
    dataDir,
    { list: async () => ids.map(meta) } as unknown as Pick<SubshellMetaStore, "list">,
    nowMs,
  );
}

describe("sweepOrphanSshDirs", () => {
  it("keeps the dir of an id PRESENT in meta, however aged (live/queued panes are never garbage)", async () => {
    const dir = makePaneDir(ID_TRACKED, 30 * 24 * HOUR_MS);
    expect(await sweep([ID_TRACKED])).toEqual({ removed: 0 });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "config"))).toBe(true);
  });

  it("keeps an orphan younger than the hour floor (the execLaunch write-before-meta-record window)", async () => {
    const dir = makePaneDir(ID_YOUNG, ORPHAN_SSH_DIR_MIN_AGE_MS / 60); // one minute old, untracked
    expect(await sweep([])).toEqual({ removed: 0 });
    expect(existsSync(dir)).toBe(true);
  });

  it("removes an aged orphan (the delete-after-death leak this sweep exists for)", async () => {
    const dir = makePaneDir(ID_AGED, HOUR_MS + 60_000);
    expect(await sweep([])).toEqual({ removed: 1 });
    expect(existsSync(dir)).toBe(false); // DIR gone, not just the config file
  });

  it("removes a validly-named orphan dir NESTED JUNK AND ALL (the rm is recursive)", async () => {
    const dir = join(sshDir, ID_NESTED);
    mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
    writeFileSync(join(dir, "nested", "deeper", "junk"), "x");
    const t = (Date.now() - HOUR_MS - 60_000) / 1000;
    utimesSync(dir, t, t);
    expect(await sweep([])).toEqual({ removed: 1 });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves non-id names untouched (stray shapes are nobody's to remove)", async () => {
    // Names the name-gate cannot match: dots, and letters outside hex.
    // (An "a/b" child name cannot exist; the nested case is a parent dir that
    // is itself not id-shaped, kept with everything under it.)
    const strays = ["..config", "cfg", `${ID_AGED}.log`, "ssh-host-config"];
    for (const name of strays) mkdirSync(join(sshDir, name), { recursive: true });
    mkdirSync(join(sshDir, "cfg", "b"), { recursive: true });
    const aged = makePaneDir(ID_AGED, HOUR_MS + 60_000); // the one entry that IS eligible
    const t = (Date.now() - HOUR_MS - 60_000) / 1000;
    for (const name of strays) utimesSync(join(sshDir, name), t, t);
    expect(await sweep([])).toEqual({ removed: 1 });
    expect(existsSync(aged)).toBe(false);
    for (const name of strays) expect(existsSync(join(sshDir, name))).toBe(true);
    expect(existsSync(join(sshDir, "cfg", "b"))).toBe(true);
  });

  it("the name-gate is case-insensitive hex (an UPPER-CASE id shape is eligible, guard truth)", async () => {
    // `isNodeSubshellId` accepts [0-9a-fA-F-]: uppercase is NOT a stray shape,
    // and the sweep's rule is the guard's rule, pinned rather than assumed.
    const upper = makePaneDir("AAAAAAAA-0000-4000-8000-000000000001", HOUR_MS + 60_000);
    expect(await sweep([])).toEqual({ removed: 1 });
    expect(existsSync(upper)).toBe(false);
  });

  it("does not follow an id-named SYMLINK at a real dir elsewhere (lstat gate, never rm through it)", async () => {
    const outside = join(dataDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "not ssh garbage");
    symlinkSync(outside, join(sshDir, ID_SYMLINK));
    const t = (Date.now() - HOUR_MS - 60_000) / 1000;
    lutimesSync(join(sshDir, ID_SYMLINK), t, t); // age the LINK (utimesSync would follow it to the target)
    expect(await sweep([])).toEqual({ removed: 0 });
    expect(existsSync(outside)).toBe(true); // the target survives, contents and all
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(existsSync(join(sshDir, ID_SYMLINK))).toBe(true); // and the link itself is left, not unlinked through
  });

  it("an absent ssh dir is a silent no-op (a node that never hosted an ssh pane)", async () => {
    rmSync(sshDir, { recursive: true, force: true });
    expect(await sweep([])).toEqual({ removed: 0 });
  });

  it("a tracked id does not shield another id's aged orphan (the gate is per-name)", async () => {
    const tracked = makePaneDir(ID_TRACKED, HOUR_MS + 60_000);
    const orphan = makePaneDir(ID_OUTSIDE, HOUR_MS + 60_000);
    expect(await sweep([ID_TRACKED])).toEqual({ removed: 1 });
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it("the age floor is exclusive: YOUNGER keeps, exactly-one-hour-old goes", async () => {
    const now = Date.now();
    // mtime pinned to EXACTLY `now - 1h`: the guard is "younger than an hour",
    // so this boundary row is eligible (only strict youth is kept).
    const dir = join(sshDir, ID_AGED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config"), "Host *\n");
    const t = (now - ORPHAN_SSH_DIR_MIN_AGE_MS) / 1000;
    utimesSync(dir, t, t);
    expect(await sweep([], now)).toEqual({ removed: 1 });
    expect(existsSync(dir)).toBe(false);
  });
});

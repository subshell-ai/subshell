import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathAllowed, realpathRoots } from "../path-policy.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "mote-policy-")));
const dataDir = join(base, "data");
const tracked = join(base, "work", "proj");
const outside = join(base, "elsewhere");
beforeAll(() => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tracked, { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("path policy (spec §7)", () => {
  const roots = async () => realpathRoots([dataDir, tracked]);
  it("allows files under a root, present or yet-to-be-created", async () => {
    expect(await pathAllowed(join(dataDir, "mcp/x.json"), await roots())).toBe(true);
    expect(await pathAllowed(join(tracked, "uploads/new.png"), await roots())).toBe(true); // parent absent
    expect(await pathAllowed(dataDir, await roots())).toBe(true); // a root itself
  });
  it("rejects escapes by .., by prefix-sibling, and by unknown roots", async () => {
    expect(await pathAllowed(join(dataDir, "..", "escape"), await roots())).toBe(false);
    expect(await pathAllowed(`${dataDir}-sibling/file`, await roots())).toBe(false); // /data vs /data-sibling
    expect(await pathAllowed(join(outside, "x"), await roots())).toBe(false);
  });
  it("rejects a symlinked ancestor that lands outside every root", async () => {
    const link = join(tracked, "out");
    symlinkSync(outside, link);
    expect(await pathAllowed(join(link, "x"), await roots())).toBe(false);
    expect(await pathAllowed(join(link, "x"), [tracked])).toBe(false); // un-normalized roots realpath'd inside
  });
  it("refuses a `..` segment outright — resolve()-collapse is symlink-blind", async () => {
    const link = join(tracked, "l");
    symlinkSync(outside, link);
    // Reviewer scenario: resolve() lexically collapses tracked/l/../evil to
    // tracked/evil (inside), but the kernel walks l → outside and opens outside/evil.
    // NB: string-built, not join() — join normalizes the `..` away before the gate sees it.
    expect(await pathAllowed(`${link}/../evil`, await roots())).toBe(false);
    // A plain `..` with no symlink anywhere still denies, as before.
    expect(await pathAllowed(`${dataDir}/../x`, await roots())).toBe(false);
  });
  it("rejects a leaf symlink whose target exists (realpath-first-iteration regression pin)", async () => {
    const link = join(tracked, "ext");
    symlinkSync(outside, link);
    expect(await pathAllowed(link, await roots())).toBe(false);
  });
  it("rejects a dangling leaf symlink — realpath fails, but a later open(O_CREAT) would follow it out", async () => {
    const link = join(tracked, "dangling");
    symlinkSync(join(outside, "ghost"), link);
    expect(await pathAllowed(link, await roots())).toBe(false);
  });
});

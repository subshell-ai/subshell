import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  allowedDirsPath,
  DIR_REFUSED_MESSAGE,
  launchDirAllowed,
  readAllowedDirs,
  writeAllowedDirs,
} from "../allowed-dirs.js";

const made: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subshell-allowed-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistence", () => {
  it("round-trips a normalized set", () => {
    const dataDir = freshDataDir();
    expect(writeAllowedDirs(dataDir, ["/srv/work/", "/home/theo"])).toEqual(["/home/theo", "/srv/work"]);
    expect(readAllowedDirs(dataDir)).toEqual(["/home/theo", "/srv/work"]);
  });

  it("writes the file 0600 — it names the only directories that may run code here", () => {
    const dataDir = freshDataDir();
    writeAllowedDirs(dataDir, ["/a"]);
    expect(statSync(allowedDirsPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("reads unrestricted when no file has ever been written", () => {
    // The backwards-compatible default. A node that has never been given
    // rules must behave exactly as it did before the feature existed.
    expect(readAllowedDirs(freshDataDir())).toEqual([]);
  });

  it("reads unrestricted from a corrupt file rather than bricking every launch", () => {
    // Fail-OPEN is deliberate here and worth pinning: this list is a
    // restriction an owner opts into, not an authentication decision. A disk
    // hiccup must not take the node offline for every launch.
    const dataDir = freshDataDir();
    writeFileSync(allowedDirsPath(dataDir), "{not json");
    expect(readAllowedDirs(dataDir)).toEqual([]);
  });

  it("re-normalizes on read, so a hand-edited file cannot install an unsound rule", () => {
    const dataDir = freshDataDir();
    writeFileSync(allowedDirsPath(dataDir), JSON.stringify({ version: 1, dirs: ["/a/", "/a/b", "../escape", 42] }));
    expect(readAllowedDirs(dataDir)).toEqual(["/a"]);
  });

  it("replaces wholesale — a smaller set leaves nothing stale", () => {
    const dataDir = freshDataDir();
    writeAllowedDirs(dataDir, ["/a", "/b"]);
    writeAllowedDirs(dataDir, ["/b"]);
    expect(readAllowedDirs(dataDir)).toEqual(["/b"]);
  });

  it("clears back to unrestricted", () => {
    const dataDir = freshDataDir();
    writeAllowedDirs(dataDir, ["/a"]);
    expect(writeAllowedDirs(dataDir, [])).toEqual([]);
    expect(readAllowedDirs(dataDir)).toEqual([]);
  });
});

describe("launchDirAllowed", () => {
  it("allows anything when there are no rules", async () => {
    expect(await launchDirAllowed("/anywhere", [])).toBe(true);
  });

  it("allows a root and its descendants, refusing outside", async () => {
    const root = freshDataDir();
    mkdirSync(join(root, "inside/deep"), { recursive: true });
    const outside = freshDataDir();

    expect(await launchDirAllowed(root, [root])).toBe(true);
    expect(await launchDirAllowed(join(root, "inside"), [root])).toBe(true);
    expect(await launchDirAllowed(join(root, "inside/deep"), [root])).toBe(true);
    expect(await launchDirAllowed(outside, [root])).toBe(false);
  });

  it("refuses a symlink that escapes an allowed root", async () => {
    // The reason this delegates to the fs-aware pathAllowed rather than the
    // protocol package's lexical dirAllowed: `resolve()` collapse is
    // symlink-blind, and a rule that looks like it confines but does not is
    // worse than no rule at all.
    const root = freshDataDir();
    const outside = freshDataDir();
    mkdirSync(join(outside, "secret"), { recursive: true });
    symlinkSync(join(outside, "secret"), join(root, "escape"));

    expect(await launchDirAllowed(join(root, "escape"), [root])).toBe(false);
  });

  it("refuses a literal `..` segment rather than collapsing it", async () => {
    const root = freshDataDir();
    mkdirSync(join(root, "a"), { recursive: true });
    // Built by concatenation, NOT `join`: node's join collapses `..` at the
    // string level, so a joined path never reaches the policy carrying one —
    // the input that matters here is a raw wire string that still does.
    expect(await launchDirAllowed(`${root}/a/../a`, [root])).toBe(false);
    expect(await launchDirAllowed(`${root}/../${basename(root)}`, [root])).toBe(false);
  });

  it("allows a not-yet-existing directory under a root — existence is a separate check", async () => {
    // `pathAllowed` walks up to the deepest existing ancestor by design (its
    // `write_file` contract). For a launch that is the right division: the
    // allowlist answers "may this location be used at all", while whether the
    // directory exists is stat_dir's/tmux's answer, with its own error.
    const root = freshDataDir();
    expect(await launchDirAllowed(join(root, "nope"), [root])).toBe(true);
  });

  it("still refuses a not-yet-existing directory outside every root", async () => {
    const root = freshDataDir();
    const outside = freshDataDir();
    expect(await launchDirAllowed(join(outside, "nope"), [root])).toBe(false);
  });

  it("has a single refusal message every executor shares", () => {
    expect(DIR_REFUSED_MESSAGE).toContain("allowed directories");
  });
});

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInstanceRestoreDestination, readInstanceRestoreResult } from "../journal.js";

/**
 * The journal guard refuses a symlink at the target file and at its immediate
 * directory, but tolerates symlinked ancestors. macOS symlinks `/var` (where
 * `TMPDIR`, and so the release smoke's data dir, lives) to `/private/var`;
 * refusing any ancestor symlink aborted boot for every path under one. A crafted
 * restore instead repoints the journal/result file or its owning directory, and
 * both still throw.
 */
describe("restore journal path guard", () => {
  const validResult = {
    transactionId: "00000000-0000-0000-0000-000000000000",
    outcome: "completed",
    completedAt: "2026-10-03T00:00:00.000Z",
  } as const;
  const actual = { databasePath: "/x/db", dataDir: "/x", configPath: "/x/config.env" };

  function tempConfig(): { root: string; config: string } {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    const config = join(root, "config");
    mkdirSync(config, { mode: 0o700 });
    return { root, config };
  }

  it("resolves the result through a symlinked ancestor (macOS /var)", () => {
    const { root, config } = tempConfig();
    try {
      symlinkSync(root, join(root, "link-root")); // an ancestor symlink, like /var → /private/var
      writeFileSync(join(config, "restore-result.json"), JSON.stringify(validResult), { mode: 0o600 });
      const viaAncestorLink = join(root, "link-root", "config", "restore-journal.json");
      expect(readInstanceRestoreResult(viaAncestorLink)).toEqual(validResult);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink at the result file", () => {
    const { root, config } = tempConfig();
    try {
      const protectedFile = join(root, "protected");
      writeFileSync(protectedFile, "protected-content", { mode: 0o600 });
      symlinkSync(protectedFile, join(config, "restore-result.json"));
      expect(() => readInstanceRestoreResult(join(config, "restore-journal.json"))).toThrow("symlink");
      expect(readFileSync(protectedFile, "utf8")).toBe("protected-content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink at the journal's own directory", () => {
    const { root, config } = tempConfig();
    try {
      writeFileSync(join(config, "restore-result.json"), JSON.stringify(validResult), { mode: 0o600 });
      const linkDir = join(root, "link-dir");
      symlinkSync(config, linkDir); // the immediate parent of the journal path is a symlink
      expect(() => readInstanceRestoreResult(join(linkDir, "restore-journal.json"))).toThrow("symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink at the journal file itself", () => {
    const { root, config } = tempConfig();
    try {
      const journal = join(config, "restore-journal.json");
      symlinkSync(join(root, "missing-target"), journal);
      expect(() => assertInstanceRestoreDestination(journal, actual)).toThrow("symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

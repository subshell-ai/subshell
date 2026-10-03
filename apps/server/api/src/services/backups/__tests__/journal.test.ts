import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstanceRestoreResult } from "../journal.js";

/**
 * The journal guard walks the path refusing symlinks, but it must refuse only
 * the target and its owning directory — not the ancestors above it. macOS
 * symlinks `/var` (where `TMPDIR`, and so the release smoke's data dir, lives)
 * to `/private/var`; refusing any ancestor symlink made the server abort at
 * boot for every path under one. A crafted restore, by contrast, repoints the
 * journal/result FILE or a directory the app owns, and both still throw.
 */
describe("restore journal path guard", () => {
  it("resolves the result through a symlinked ancestor (macOS /var) and refuses a symlink at the result itself", () => {
    const realRoot = mkdtempSync(join(tmpdir(), "journal-real-"));
    try {
      const config = join(realRoot, "config");
      mkdirSync(config, { mode: 0o700 });
      const linkRoot = join(realRoot, "link-root");
      symlinkSync(realRoot, linkRoot); // an ancestor symlink, like /var → /private/var

      const result = {
        transactionId: "00000000-0000-0000-0000-000000000000",
        outcome: "completed",
        completedAt: "2026-10-03T00:00:00.000Z",
      } as const;
      writeFileSync(join(config, "restore-result.json"), JSON.stringify(result), { mode: 0o600 });

      // Reach the same result through the symlinked ancestor: it must resolve, not throw.
      const viaAncestorLink = join(linkRoot, "config", "restore-journal.json");
      expect(readInstanceRestoreResult(viaAncestorLink)).toEqual(result);

      // A symlink AT the result is still refused, and the link survives untouched.
      rmSync(join(config, "restore-result.json"));
      const protectedFile = join(realRoot, "protected");
      writeFileSync(protectedFile, "protected-content", { mode: 0o600 });
      const resultPath = join(config, "restore-result.json");
      symlinkSync(protectedFile, resultPath);
      expect(() => readInstanceRestoreResult(join(config, "restore-journal.json"))).toThrow("symlink");
      expect(readFileSync(protectedFile, "utf8")).toBe("protected-content");
    } finally {
      rmSync(realRoot, { recursive: true, force: true });
    }
  });
});

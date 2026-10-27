import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { forensicsEnabled, recordAttachPaint, setForensicsEnabledForTests } from "@/api/ws/attach-forensics.js";
import { logger } from "@/shared/logger.js";

/**
 * Attach forensics (2026-09-01) — the per-attach evidence dump that makes the
 * NEXT "still garbled" report provable to a layer instead of a 50/50 guess:
 * the pane's grid as the viewer found it vs. the exact replay bytes shipped.
 *
 * These write under the real `/tmp/subshell-attach-debug` root (that path IS the
 * documented contract an operator greps), namespaced by a synthetic subshell id
 * this suite removes afterwards.
 */

const ROOT = "/tmp/subshell-attach-debug";
const SID = `test-forensics-${process.pid}`;

afterEach(() => {
  setForensicsEnabledForTests(false);
  rmSync(`${ROOT}/${SID}`, { recursive: true, force: true });
});

describe("attach forensics", () => {
  it("is OFF by default: an attach writes nothing (the dumps are real terminal output)", () => {
    // Screen contents can hold secrets, and every attach writing to /tmp
    // would churn the disk — the dump is opt-in per instance.
    expect(forensicsEnabled()).toBe(false);
    recordAttachPaint({
      subshellId: SID,
      preResize: "BEFORE",
      replay: "AFTER",
      repainted: true,
      nudged: false,
      cursor: null,
    });
    expect(existsSync(`${ROOT}/${SID}`)).toBe(false);
  });

  it("when armed, dumps the pre-resize grid and the exact replay bytes side by side", () => {
    setForensicsEnabledForTests(true);
    recordAttachPaint({
      subshellId: SID,
      preResize: "GARBLED-AT-ENTRY",
      replay: "CLEAN-AFTER-REPAINT",
      repainted: true,
      nudged: true,
      cursor: { x: 3, y: 2 },
    });

    // One timestamped directory per attach, so successive attaches on one
    // subshell are comparable rather than overwriting each other.
    const attaches = [...new Bun.Glob("*/*.txt").scanSync(`${ROOT}/${SID}`)];
    expect(attaches.sort()).toHaveLength(2);
    const dir = `${ROOT}/${SID}/${attaches[0].split("/")[0]}`;
    expect(readFileSync(`${dir}/pre-resize.txt`, "utf8")).toBe("GARBLED-AT-ENTRY");
    expect(readFileSync(`${dir}/replay.txt`, "utf8")).toBe("CLEAN-AFTER-REPAINT");
  });

  it("records an attach with no pre-resize capture honestly rather than dropping the dump", () => {
    // A stale client sends no geometry ⇒ no resize ⇒ nothing to capture
    // "before" it. The replay half is still the evidence that matters.
    setForensicsEnabledForTests(true);
    recordAttachPaint({
      subshellId: SID,
      preResize: null,
      replay: "REPLAY",
      repainted: false,
      nudged: false,
      cursor: { x: 0, y: 0 },
    });

    const files = [...new Bun.Glob("*/*.txt").scanSync(`${ROOT}/${SID}`)];
    const dir = `${ROOT}/${SID}/${files[0].split("/")[0]}`;
    expect(readFileSync(`${dir}/pre-resize.txt`, "utf8")).toBe("<no pre-resize capture>");
    expect(readFileSync(`${dir}/replay.txt`, "utf8")).toBe("REPLAY");
  });

  it("a dump failure never breaks the attach", () => {
    // The dump is diagnostics. An unwritable root (read-only fs, quota) must
    // degrade to "no evidence", never to a refused terminal.
    setForensicsEnabledForTests(true);
    expect(() =>
      recordAttachPaint({
        // A path segment that cannot be created as a directory component.
        subshellId: `${SID}/\0bad`,
        preResize: null,
        replay: "R",
        repainted: false,
        nudged: false,
        cursor: { x: 7, y: 1 },
      }),
    ).not.toThrow();
  });

  it("names the shipped cursor on the journal line, because a missing restore IS a diagnosis", () => {
    // The `painted` line is what a "still garbled" report gets read from;
    // `cursor=none` there means the replay shipped without its absolute
    // restore, the known degrade that puts every later relative-positioned
    // frame (a TUI's pinned-block repaints) on the wrong rows.
    const seen: string[] = [];
    const spy = spyOn(logger, "info").mockImplementation((msg: string) => {
      seen.push(msg);
    });
    try {
      recordAttachPaint({
        subshellId: SID,
        preResize: null,
        replay: "R",
        repainted: false,
        nudged: false,
        cursor: { x: 3, y: 2 },
      });
      recordAttachPaint({
        subshellId: SID,
        preResize: null,
        replay: "R",
        repainted: false,
        nudged: false,
        cursor: null,
      });
    } finally {
      spy.mockRestore();
    }
    expect(seen.some((l) => l.includes("cursor=3,2"))).toBe(true);
    expect(seen.some((l) => l.includes("cursor=none"))).toBe(true);
  });
});

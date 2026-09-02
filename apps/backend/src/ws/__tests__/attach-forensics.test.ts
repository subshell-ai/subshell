import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { forensicsEnabled, recordAttachPaint, setForensicsEnabledForTests } from "@/ws/attach-forensics.js";

/**
 * Attach forensics (2026-09-01) — the per-attach evidence dump that makes the
 * NEXT "still garbled" report provable to a layer instead of a 50/50 guess:
 * the pane's grid as the viewer found it vs. the exact replay bytes shipped.
 *
 * These write under the real `/tmp/subshell-attach-debug` root (that path IS the
 * documented contract an operator greps), namespaced by a synthetic session id
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
    recordAttachPaint({ sessionId: SID, preResize: "BEFORE", replay: "AFTER", repainted: true, nudged: false });
    expect(existsSync(`${ROOT}/${SID}`)).toBe(false);
  });

  it("when armed, dumps the pre-resize grid and the exact replay bytes side by side", () => {
    setForensicsEnabledForTests(true);
    recordAttachPaint({
      sessionId: SID,
      preResize: "GARBLED-AT-ENTRY",
      replay: "CLEAN-AFTER-REPAINT",
      repainted: true,
      nudged: true,
    });

    // One timestamped directory per attach, so successive attaches on one
    // session are comparable rather than overwriting each other.
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
    recordAttachPaint({ sessionId: SID, preResize: null, replay: "REPLAY", repainted: false, nudged: false });

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
        sessionId: `${SID}/\0bad`,
        preResize: null,
        replay: "R",
        repainted: false,
        nudged: false,
      }),
    ).not.toThrow();
  });
});

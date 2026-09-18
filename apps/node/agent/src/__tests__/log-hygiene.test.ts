import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogHygieneDeps, tightenServiceLogMode } from "../log-hygiene.js";
import { DEFAULT_DEPS, launchLogPath } from "../service.js";

/**
 * The repair for the mode launchd creates the daemon's log file with.
 *
 * Every case runs against injected seams; the one test that touches a real
 * file points `home` at a temp directory, which is also what the production
 * `chmodFile` guard insists on while `NODE_ENV=test`.
 */

/** A deps object with recording seams and nothing real behind them. */
function deps(over: Partial<LogHygieneDeps> = {}): LogHygieneDeps & { chmods: [string, number][] } {
  const chmods: [string, number][] = [];
  return {
    platform: "darwin",
    home: "/home/u",
    fileExists: async () => true,
    chmodFile: async (path, mode) => {
      chmods.push([path, mode]);
    },
    chmods,
    ...over,
  };
}

describe("tightenServiceLogMode", () => {
  test("chmods the file the plist names, and only that file", async () => {
    const d = deps();
    const res = await tightenServiceLogMode(d);
    expect(res).toMatchObject({ path: launchLogPath("/home/u"), tightened: true, reason: "tightened" });
    expect(d.chmods).toEqual([["/home/u/Library/Logs/subshell.log", 0o600]]);
  });

  // systemd redirects nothing — the output is in the journal, so there is no
  // file whose mode could be wrong.
  test("does nothing where the manager writes no file", async () => {
    const d = deps({ platform: "linux" });
    const res = await tightenServiceLogMode(d);
    expect(res).toEqual({ path: null, tightened: false, reason: "no-file" });
    expect(d.chmods).toEqual([]);
  });

  // launchd creates it on the first line; before that there is nothing to
  // repair, and creating one would be this agent writing into ~/Library/Logs
  // on a machine that may have no service at all.
  test("does not create a log that is not there", async () => {
    const d = deps({ fileExists: async () => false });
    const res = await tightenServiceLogMode(d);
    expect(res).toMatchObject({ tightened: false, reason: "absent" });
    expect(d.chmods).toEqual([]);
  });

  // The seam is optional so a hand-built deps object in a suite cannot reach
  // the real filesystem through this path.
  test("a deps object with no chmod seam touches nothing", async () => {
    const res = await tightenServiceLogMode({ platform: "darwin", home: "/home/u", fileExists: async () => true });
    expect(res).toMatchObject({ tightened: false, reason: "no-seam" });
  });

  // A file owned by someone else, or a read-only mount: the daemon still
  // starts, and the caller has something to log.
  test("a refused chmod is a value, never a throw", async () => {
    const boom = new Error("EPERM");
    const res = await tightenServiceLogMode(
      deps({
        chmodFile: async () => {
          throw boom;
        },
      }),
    );
    expect(res).toMatchObject({ tightened: false, reason: "failed", error: boom });
  });

  // The whole point, end to end: a 0644 file that launchd would have created
  // comes out 0600. Real fs, temp home — never the developer's own.
  test("a 0644 log really becomes 0600 through the production seam", async () => {
    const home = mkdtempSync(join(tmpdir(), "subshell-loghygiene-"));
    const path = launchLogPath(home);
    await mkdir(join(home, "Library", "Logs"), { recursive: true });
    writeFileSync(path, "[subshell] started\n");
    chmodSync(path, 0o644);

    // `platform` explicitly, never the host's: `tightenServiceLogMode` answers
    // `null` for the path off darwin (`log-hygiene.ts` — systemd redirects to
    // no file), so inheriting DEFAULT_DEPS' platform made this pass on a Mac
    // and fail on the Linux runner. The sibling case below already spells it.
    const res = await tightenServiceLogMode({ ...DEFAULT_DEPS(async () => true), platform: "darwin", home });
    expect(res).toMatchObject({ tightened: true, reason: "tightened" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // The guard that keeps a suite off the real machine: the production seam
  // refuses a path outside the temp dir while NODE_ENV=test, exactly as
  // `writeFile` and `removeFile` do.
  test("the production seam refuses a chmod outside the temp dir under test", async () => {
    const res = await tightenServiceLogMode({
      ...DEFAULT_DEPS(async () => true),
      platform: "darwin",
      home: "/Users/somebody",
      fileExists: async () => true,
    });
    expect(res.reason).toBe("failed");
    expect(String((res.error as Error).message)).toInclude("refusing to touch");
  });
});

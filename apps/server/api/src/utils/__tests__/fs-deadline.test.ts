import { describe, expect, it } from "bun:test";
import { FsDeadlineError, newReadBudget, withFsDeadline } from "@/utils/fs-deadline.js";

/**
 * The guard the folder picker stands on: a read that never answers must reject
 * with a NAMED error inside a bounded time, off the event loop. These are the
 * primitive's own contracts; the route/classification behaviour is pinned in
 * `files-route.test.ts`.
 */
describe("withFsDeadline", () => {
  it("passes a value that settles before the deadline", async () => {
    expect(await withFsDeadline(() => Promise.resolve(42), { ms: 1_000 })).toBe(42);
  });

  it("rejects a read that never settles, with FsDeadlineError", async () => {
    const started = Date.now();
    await expect(withFsDeadline(() => new Promise<string>(() => {}), { ms: 20 })).rejects.toBeInstanceOf(
      FsDeadlineError,
    );
    // Bounded: it gave up near the deadline, not on the 10s default.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("propagates a real rejection unchanged (it is not a timeout)", async () => {
    const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    await expect(withFsDeadline(() => Promise.reject(err), { ms: 1_000 })).rejects.toBe(err);
  });

  it("a thunk that throws synchronously rejects with THAT error, not a timeout", async () => {
    // The abandoned timer must not later fire a FsDeadlineError onto this.
    const boom = new Error("threw synchronously");
    await expect(
      withFsDeadline(
        () => {
          throw boom;
        },
        { ms: 5 },
      ),
    ).rejects.toBe(boom);
  });

  it("honours SUBSHELL_FS_READ_TIMEOUT_MS as the default budget", async () => {
    const saved = process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
    process.env.SUBSHELL_FS_READ_TIMEOUT_MS = "20";
    try {
      // No `ms` given: the env value drives it, so a never-settling read fails
      // fast rather than waiting the 10s default.
      await expect(withFsDeadline(() => new Promise<string>(() => {}))).rejects.toBeInstanceOf(FsDeadlineError);
    } finally {
      if (saved === undefined) delete process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
      else process.env.SUBSHELL_FS_READ_TIMEOUT_MS = saved;
    }
  });

  it("ignores a malformed env budget rather than trusting it", async () => {
    // "0"/garbage must not disable the guard (an unbounded read is the wedge
    // this exists to stop); a fast read still resolves, proving it did not
    // collapse to a 0ms instant-fail either.
    const saved = process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
    process.env.SUBSHELL_FS_READ_TIMEOUT_MS = "not-a-number";
    try {
      expect(await withFsDeadline(() => Promise.resolve("ok"))).toBe("ok");
    } finally {
      if (saved === undefined) delete process.env.SUBSHELL_FS_READ_TIMEOUT_MS;
      else process.env.SUBSHELL_FS_READ_TIMEOUT_MS = saved;
    }
  });
});

describe("newReadBudget (one shared clock, no per-read stacking)", () => {
  it("lets an early read pass and a later overrun fail on the SAME budget", async () => {
    const budget = newReadBudget(40);
    // First read well within budget.
    expect(await withFsDeadline(() => Promise.resolve("first"), { signal: budget })).toBe("first");
    // Burn past the single absolute deadline, then start another read: it gets
    // only the budget that is left, which is none, so it fails immediately
    // rather than restarting a fresh 40ms window.
    await new Promise((r) => setTimeout(r, 60));
    await expect(withFsDeadline(() => Promise.resolve("second"), { signal: budget })).rejects.toBeInstanceOf(
      FsDeadlineError,
    );
  });

  it("an already-aborted budget rejects without calling make", async () => {
    const budget = newReadBudget(1);
    await new Promise((r) => setTimeout(r, 20)); // let it expire
    let called = false;
    await expect(
      withFsDeadline(
        () => {
          called = true;
          return Promise.resolve("x");
        },
        { signal: budget },
      ),
    ).rejects.toBeInstanceOf(FsDeadlineError);
    // The pre-aborted check short-circuits before the operation starts.
    expect(called).toBe(false);
  });
});

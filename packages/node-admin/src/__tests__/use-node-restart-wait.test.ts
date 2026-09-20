import { describe, expect, it } from "bun:test";
import { isNewNodeProcess } from "../hooks/use-node-restart-wait";

/**
 * The drift decision, pinned (spec 2026-09-12 § 6.3).
 *
 * The server's `isNewBoot` needs a five-second tolerance because
 * `admin/status` re-derives `bootedAt` on every read. This one must NOT have
 * one: the agent freezes `startedAt` at daemon start and resends the same
 * string on every `ready`, so equality is exact — and a tolerance would
 * swallow a fast systemd restart, whose new value lands seconds after the old.
 */
describe("isNewNodeProcess", () => {
  it("calls an unchanged startedAt the same process", () => {
    expect(isNewNodeProcess("2026-09-12T10:00:00.000Z", "2026-09-12T10:00:00.000Z")).toBe(false);
  });

  it("catches a restart that completed inside the server waiter's tolerance", () => {
    // Three seconds apart: `isNewBoot` would call this the same boot. Here it
    // is a genuinely new process, and missing it would hang the wait for 60 s.
    expect(isNewNodeProcess("2026-09-12T10:00:00.000Z", "2026-09-12T10:00:03.000Z")).toBe(true);
  });

  it("treats a missing baseline as a new process", () => {
    // No baseline means the page never saw a report; the node answering at
    // all is the only evidence available.
    expect(isNewNodeProcess(undefined, "2026-09-12T10:00:00.000Z")).toBe(true);
  });
});

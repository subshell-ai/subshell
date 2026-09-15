import { afterEach, describe, expect, it } from "bun:test";
import { type ConfirmOptions, setConfirmHandler } from "@/lib/confirm";
import { confirmStartMaintenance } from "@/lib/node-confirmations";

/**
 * The prompt that precedes the one node act with a blast radius beyond the
 * person clicking it: starting maintenance stops every subshell on the
 * machine, including ones this viewer cannot see. So the count is the
 * headline of the description, and the three shapes it can have — a number,
 * zero, and "the count never answered" — each have to read as a sentence.
 */
function captured(): { seen: ConfirmOptions[]; restore: () => void } {
  const seen: ConfirmOptions[] = [];
  const previous = setConfirmHandler((options) => {
    seen.push(options);
    return Promise.resolve(true);
  });
  return { seen, restore: () => setConfirmHandler(previous) };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("confirmStartMaintenance", () => {
  it("asks the question with the node's name in the title, not in a paragraph", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "mac mini", isLocal: false, runningSubshells: 2 });
    expect(c.seen[0]?.title).toBe('Start maintenance on "mac mini"?');
    expect(c.seen[0]?.confirmLabel).toBe("Start maintenance");
    expect(c.seen[0]?.danger).toBe(true);
  });

  it("names the count, and says it in subshells rather than in 'running'", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "mac mini", isLocal: false, runningSubshells: 3 });
    const description = c.seen[0]?.description ?? "";
    // Parked rows are counted server-side, so "3 running" would be a claim
    // the number does not support.
    expect(description).toContain("3 subshells running here will be stopped and their owners notified.");
    expect(description).not.toContain("3 running");
    expect(description).toContain("Nobody can launch here until maintenance ends.");
    expect(description).toContain("Everything else about the node keeps working.");
  });

  it("says one subshell in the singular", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "mac mini", isLocal: false, runningSubshells: 1 });
    expect(c.seen[0]?.description).toContain("1 subshell running here will be stopped");
  });

  it("drops the stopping clause entirely at zero", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "mac mini", isLocal: false, runningSubshells: 0 });
    const description = c.seen[0]?.description ?? "";
    expect(description).toContain("Nothing is running here.");
    expect(description).not.toContain("stopped");
    expect(description).toContain("Nobody can launch here until maintenance ends.");
  });

  it("hedges when the count never answered, rather than claiming a zero it does not have", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "mac mini", isLocal: false, runningSubshells: undefined });
    const description = c.seen[0]?.description ?? "";
    expect(description).toContain("Any subshells running here will be stopped and their owners notified.");
    expect(description).not.toContain("Nothing is running here.");
  });

  it("tells an admin the host's switch applies to them too", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "Server", isLocal: true, runningSubshells: 0 });
    expect(c.seen[0]?.description).toContain("This applies to admins too.");
  });

  it("leaves the admins clause off an agent node, where it would name nobody", async () => {
    const c = captured();
    restore = c.restore;
    await confirmStartMaintenance({ name: "mac mini", isLocal: false, runningSubshells: 0 });
    expect(c.seen[0]?.description).not.toContain("admins");
  });

  it("passes the dialog's answer through — a dismissed prompt stops the act", async () => {
    const previous = setConfirmHandler(() => Promise.resolve(false));
    restore = () => setConfirmHandler(previous);
    expect(await confirmStartMaintenance({ name: "n", isLocal: false, runningSubshells: 1 })).toBe(false);
  });
});

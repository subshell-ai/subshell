import { expect, test } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import type { SshAnswer } from "@/services/ssh-launch.service.js";
import { createSshSetupTracker } from "@/services/ssh-setup-progress.js";

test("reopening or retrying an ongoing setup joins one operation, with owner-scoped stage and result", async () => {
  const tracker = createSshSetupTracker();
  let finish!: (answer: SshAnswer<{ nodeId: string }>) => void;
  let calls = 0;
  const run = () =>
    tracker.run("owner", "pane", (stage) => {
      calls++;
      stage("installing");
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
  const first = run();
  await Promise.resolve();
  expect(tracker.read("owner", "pane")?.stage).toBe("installing");
  expect(tracker.read("other", "pane")).toBeNull();
  const second = run();
  expect(calls).toBe(1);
  finish({ ok: true, value: { nodeId: "new-node" } });
  await Promise.all([first, second]);
  expect(tracker.read("owner", "pane")).toMatchObject({ stage: "complete", nodeId: "new-node", error: null });
  await run();
  expect(calls).toBe(1);
});

test("failures may be retried; unexpected errors never disclose installer secrets", async () => {
  const tracker = createSshSetupTracker();
  await tracker.run("o", "p", async () => {
    throw new Error("secret setup key");
  });
  expect(JSON.stringify(tracker.read("o", "p"))).not.toContain("secret setup key");
  expect(tracker.read("o", "p")?.stage).toBe("failed");
  await tracker.run("o", "p", async () => ({
    ok: false,
    refusal: { status: 409, code: BackendErrorCodes.SSH_UPGRADE_FAILED, message: "Install tmux first." },
  }));
  expect(tracker.read("o", "p")?.error).toBe("Install tmux first.");
  await tracker.run("o", "p", async () => ({ ok: true, value: { nodeId: "n" } }));
  expect(tracker.read("o", "p")?.stage).toBe("complete");
});

test("completed status expires after an hour", async () => {
  let now = 0;
  const tracker = createSshSetupTracker(() => now);
  await tracker.run("o", "p", async () => ({ ok: true, value: { nodeId: "n" } }));
  now = 3_600_001;
  expect(tracker.read("o", "p")).toBeNull();
});

import { expect, spyOn, test } from "bun:test";
import { RuntimeSessionLauncher } from "../runtime-session-launcher.js";
import type { SshRuntimeSession } from "../session.js";

/** No runtime is touched: spy at the launcher's existing capture/input transport seam. */
function fixture() {
  const launcher = new RuntimeSessionLauncher({} as SshRuntimeSession);
  const capture = spyOn(launcher, "capture").mockResolvedValue("ready>");
  const input = spyOn(launcher, "sendInput").mockResolvedValue();
  return { launcher, capture, input };
}

test("initial prompt waits for output and submits exactly once", async () => {
  const { launcher, capture, input } = fixture();
  capture.mockResolvedValueOnce("");
  expect(await launcher.deliverPrompt("socket", "pane", "Review this project", 100, 1)).toBe(true);
  expect(input.mock.calls).toEqual([
    ["socket", "pane", "Review this project"],
    ["socket", "pane", "\r"],
  ]);
});

test("uncertain input failure never replays the prompt", async () => {
  const { launcher, input } = fixture();
  input.mockRejectedValue(new Error("connection lost"));
  expect(await launcher.deliverPrompt("socket", "pane", "Review", 100, 1)).toBe(false);
  expect(input).toHaveBeenCalledTimes(1);
});

test("no readiness means no input", async () => {
  const { launcher, capture, input } = fixture();
  capture.mockResolvedValue("");
  expect(await launcher.deliverPrompt("socket", "pane", "Review", 5, 1)).toBe(false);
  expect(input).not.toHaveBeenCalled();
});

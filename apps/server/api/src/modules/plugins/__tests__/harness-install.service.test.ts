import { describe, expect, it, mock } from "bun:test";
import {
  harnessInstallCommand,
  installHarnessOnNode,
  refuseHarnessInstall,
} from "@/modules/plugins/harness-install.service.js";
import { claimHarnessRun, HarnessRunRefused } from "@/modules/plugins/harness-run-lock.js";

describe("harnessInstallCommand", () => {
  it("answers the built-in installer line and nothing for a shell or unknown id", async () => {
    expect(await harnessInstallCommand("claude-code")).toContain("claude.ai/install.sh");
    expect(await harnessInstallCommand("terminal")).toBeUndefined();
    expect(await harnessInstallCommand("not-a-plugin")).toBeUndefined();
  });
});

describe("refuseHarnessInstall", () => {
  it("refuses an unknown id and a plugin that drives no program", async () => {
    expect((await refuseHarnessInstall("not-a-plugin"))?.status).toBe(404);
    expect((await refuseHarnessInstall("terminal"))?.status).toBe(400);
  });
});

describe("installHarnessOnNode", () => {
  it("sends harness_install with the manifest line, validates the id, and refreshes detection", async () => {
    const send = mock(async (_nodeId: string, cmd: { type: string; harnessId: string; command: string }) => {
      expect(cmd.type).toBe("harness_install");
      expect(cmd.harnessId).toBe("claude-code");
      expect(cmd.command).toContain("claude.ai/install.sh");
      return { harnessId: "claude-code", ok: true, exitCode: 0, output: "installed", durationMs: 5, timedOut: false };
    });
    const detect = mock(async () => {});
    const result = await installHarnessOnNode("node-a", "claude-code", undefined, { send: send as never, detect });
    expect(result).toMatchObject({ harnessId: "claude-code", ok: true });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("skips the detection refresh when the run timed out", async () => {
    // `runBounded` kills only the direct child, so the vendor pipeline may
    // still be installing; a detect taken now could cache a half-installed
    // answer. The next page load or periodic pass repairs it once it settles.
    const detect = mock(async () => {});
    const result = await installHarnessOnNode("node-a", "claude-code", undefined, {
      send: (async () => ({
        harnessId: "claude-code",
        ok: false,
        exitCode: null,
        output: "",
        durationMs: 600_000,
        timedOut: true,
      })) as never,
      detect,
    });
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(detect).not.toHaveBeenCalled();
  });

  it("throws on a malformed answer or an echoed id for another harness", async () => {
    await expect(
      installHarnessOnNode("node-a", "claude-code", undefined, {
        send: (async () => ({ nope: true })) as never,
        detect: async () => {},
      }),
    ).rejects.toThrow(/malformed/);
    await expect(
      installHarnessOnNode("node-a", "claude-code", undefined, {
        send: (async () => ({
          harnessId: "codex",
          ok: true,
          exitCode: 0,
          output: "",
          durationMs: 1,
          timedOut: false,
        })) as never,
        detect: async () => {},
      }),
    ).rejects.toThrow(/codex/);
  });
});

describe("claimHarnessRun", () => {
  it("shares one slot across install and update, names the holder, and releases", () => {
    const first = claimHarnessRun("node-a", "claude-code", "update");
    if (first instanceof HarnessRunRefused) throw new Error("first claim refused");
    const second = claimHarnessRun("node-a", "codex", "install");
    expect(second).toBeInstanceOf(HarnessRunRefused);
    if (second instanceof HarnessRunRefused) expect(second.message).toContain("claude-code");
    first.release();
    const after = claimHarnessRun("node-a", "codex", "install");
    expect(after).not.toBeInstanceOf(HarnessRunRefused);
    if (!(after instanceof HarnessRunRefused)) after.release();
  });
});

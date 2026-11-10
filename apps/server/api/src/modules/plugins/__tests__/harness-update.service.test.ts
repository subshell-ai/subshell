import { afterEach, describe, expect, it } from "bun:test";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { AgentInstallRefused, refuseInstall } from "@/modules/plugins/agent-install.service.js";
import {
  claimHarnessUpdate,
  HarnessUpdateRefused,
  harnessUpdateCommand,
  runUpdateCommand,
} from "@/modules/plugins/harness-update.service.js";
import { claimLocalRun, resetLocalRunForTests } from "@/modules/plugins/local-run-lock.js";

describe("harnessUpdateCommand", () => {
  it("falls back to the installer for a built-in that declares no update verb", () => {
    // Claude's own installer is an idempotent updater, which is why the
    // adapter's fallback is safe rather than a guess.
    expect(harnessUpdateCommand("claude-code")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });

  it("answers undefined for a harness with nothing to update, and for an unknown id", () => {
    // A plain shell drives no CLI; an ssh pane drives none either.
    expect(harnessUpdateCommand("terminal")).toBeUndefined();
    expect(harnessUpdateCommand("not-a-plugin")).toBeUndefined();
  });
});

describe("claimHarnessUpdate", () => {
  it("serializes updates per node, names the holder, and releases idempotently", () => {
    const first = claimHarnessUpdate("node-a", "claude-code");
    if (first instanceof HarnessUpdateRefused) throw new Error("the first claim was refused");
    try {
      // One package manager can serve two harnesses, so the slot is the NODE's.
      const second = claimHarnessUpdate("node-a", "codex");
      expect(second).toBeInstanceOf(HarnessUpdateRefused);
      if (!(second instanceof HarnessUpdateRefused)) return;
      expect(second.status).toBe(409);
      expect(second.message).toContain("claude-code");

      // A different node has its own filesystem and its own slot.
      const other = claimHarnessUpdate("node-b", "codex");
      expect(other).not.toBeInstanceOf(HarnessUpdateRefused);
      if (!(other instanceof HarnessUpdateRefused)) other.release();
    } finally {
      first.release();
      first.release();
    }
    const reclaimed = claimHarnessUpdate("node-a", "codex");
    expect(reclaimed).not.toBeInstanceOf(HarnessUpdateRefused);
    if (!(reclaimed instanceof HarnessUpdateRefused)) reclaimed.release();
  });
});

describe("the control-plane host's shared run slot", () => {
  afterEach(resetLocalRunForTests);

  it("refuses a local update while an install holds the slot", () => {
    const release = claimLocalRun('install "codex"');
    if (!release) throw new Error("the slot was unexpectedly taken");
    const claim = claimHarnessUpdate(LOCAL_NODE_ID, "claude-code");
    expect(claim).toBeInstanceOf(HarnessUpdateRefused);
    if (claim instanceof HarnessUpdateRefused) {
      expect(claim.status).toBe(409);
      expect(claim.message).toContain('install "codex"');
    }
    release();

    const free = claimHarnessUpdate(LOCAL_NODE_ID, "claude-code");
    expect(free).not.toBeInstanceOf(HarnessUpdateRefused);
    if (!(free instanceof HarnessUpdateRefused)) free.release();
  });

  it("refuses an install while a local update holds the slot", async () => {
    const claim = claimHarnessUpdate(LOCAL_NODE_ID, "claude-code");
    if (claim instanceof HarnessUpdateRefused) throw new Error("the update claim was refused");
    try {
      const refused = await refuseInstall("codex");
      expect(refused).toBeInstanceOf(AgentInstallRefused);
      expect(refused?.status).toBe(409);
    } finally {
      claim.release();
    }
    expect(await refuseInstall("codex")).toBeUndefined();
  });
});

describe("runUpdateCommand", () => {
  it("answers a non-zero exit as a result, with the combined output", async () => {
    const result = await runUpdateCommand("codex", "printf 'oops\\n' >&2; exit 7");
    expect(result).toMatchObject({
      harnessId: "codex",
      ok: false,
      exitCode: 7,
      timedOut: false,
    });
    expect(result.output).toContain("oops");
  });

  it("answers success and the command's stdout", async () => {
    const result = await runUpdateCommand("claude-code", "printf 'updated\\n'");
    expect(result).toMatchObject({ harnessId: "claude-code", ok: true, exitCode: 0 });
    expect(result.output).toContain("updated");
  });
});

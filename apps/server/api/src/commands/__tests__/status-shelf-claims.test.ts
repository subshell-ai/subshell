import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_NODE_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { runStatus } from "@/commands/status.js";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { resetShelfProbeForTests } from "@/lib/node-artifact-serve.js";

/**
 * `subshell-server status` shows the operator WHAT THE SHELF CLAIMS before a
 * fleet discovers it (spec 2026-10-09): the same connect facts the serve
 * resolver enforces, rendered per published copy. Silence means every copy
 * could honestly be served, so the pin cuts both ways.
 *
 * The stub is planted in the real artifacts dir for the duration of one call
 * and removed inside the same function — same posture as the download-route
 * shelf suite — and the config dir is pinned to a temp like `status-db-safety`
 * does, so status never opens the developer's live database from a test.
 */
const TARGET = "linux-x64";
const binaryPath = join(NODE_ARTIFACTS_DIR, `subshell-node-cli-${TARGET}`);

const shelfScript = (version: string, protocol: number) =>
  `#!/bin/sh\necho "subshell ${version} (node protocol v${protocol})"\n`;

/** Runs the real human render against one planted shelf copy; returns its lines. */
function statusLines(shelfBody: string | null): string[] {
  resetShelfProbeForTests();
  mkdirSync(NODE_ARTIFACTS_DIR, { recursive: true });
  rmSync(binaryPath, { force: true });
  if (shelfBody !== null) {
    writeFileSync(binaryPath, shelfBody);
    chmodSync(binaryPath, 0o755);
  }
  const configDir = mkdtempSync(join(tmpdir(), "status-shelf-"));
  writeFileSync(join(configDir, "config.env"), `DATABASE_PATH=${join(configDir, "absent.db")}\n`, "utf8");
  const prev = process.env.SUBSHELL_SERVER_CONFIG_DIR;
  process.env.SUBSHELL_SERVER_CONFIG_DIR = configDir;
  const lines: string[] = [];
  try {
    runStatus((line) => lines.push(line), { platform: "linux", probePort: () => null });
  } finally {
    if (prev === undefined) delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
    else process.env.SUBSHELL_SERVER_CONFIG_DIR = prev;
    rmSync(binaryPath, { force: true });
    resetShelfProbeForTests();
  }
  // Only THIS target's claim lines: a developer's machine may hold real
  // copies of the other triples, and this test planted exactly one stub.
  return lines.filter((line) => line.startsWith(`  ${TARGET}:`));
}

describe("status renders what the shelf claims", () => {
  it("names a wrong-protocol copy and says machines will be refused at connect", () => {
    const claims = statusLines(shelfScript("1.0.0", NODE_PROTOCOL_VERSION - 1));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("1.0.0");
    expect(claims[0]).toContain(`protocol v${NODE_PROTOCOL_VERSION - 1}`);
    expect(claims[0]).toContain("refused at connect");
  });

  it("names a copy below the server's node floor", () => {
    const claims = statusLines(shelfScript("0.0.1", NODE_PROTOCOL_VERSION));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("0.0.1");
    expect(claims[0]).toContain(MIN_NODE_VERSION);
    expect(claims[0]).toContain("floor");
  });

  it("marks an unmeasurable copy as answering no version", () => {
    const claims = statusLines("not an executable at all");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain("answers no version");
  });

  it("stays silent about a copy that could honestly be served", () => {
    expect(statusLines(shelfScript("10.0.0", NODE_PROTOCOL_VERSION))).toHaveLength(0);
  });
});

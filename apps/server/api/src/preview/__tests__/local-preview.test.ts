import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewLaneEvent } from "@internal/pane-runtime";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { LocalPreviewRuntime } from "@/preview/local-preview.js";

const id = crypto.randomUUID();
const ref = "1".repeat(32);
const roots: string[] = [];
const runtimes: LocalPreviewRuntime[] = [];
function setup(over: Partial<ConstructorParameters<typeof LocalPreviewRuntime>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "local-preview-"));
  roots.push(dataDir);
  const runtime = new LocalPreviewRuntime({
    dataDir,
    enabled: async () => true,
    pane: async () => ({ id, nodeId: "local", alive: 1, status: "running", tmuxSocket: "owned" }) as SubshellTable,
    panePid: async () => process.pid,
    ...over,
  });
  runtimes.push(runtime);
  return runtime;
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.forward.closeAll("viewer-left");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the server's machine-local preview runtime", () => {
  it("checks the DB switch before inspecting a process", async () => {
    let reads = 0;
    const runtime = setup({
      enabled: async () => false,
      pane: async () => {
        reads++;
        return undefined;
      },
    });
    await expect(runtime.execute({ type: "preview_ports_get", paneId: id }, () => {})).rejects.toThrow(
      "preview-node-off",
    );
    expect(reads).toBe(0);
  });

  it("refuses a remote or dead pane before scanning ports", async () => {
    let scans = 0;
    for (const row of [
      { nodeId: "other", alive: 1 },
      { nodeId: "local", alive: 0 },
    ]) {
      const runtime = setup({
        pane: async () => ({ id, status: "running", tmuxSocket: "owned", ...row }) as SubshellTable,
        scan: async () => {
          scans++;
          return { ports: [], cdpPort: null, screen: null };
        },
      });
      await expect(runtime.execute({ type: "preview_ports_get", paneId: id }, () => {})).rejects.toThrow(
        "preview-pane-gone",
      );
    }
    expect(scans).toBe(0);
  });

  it("discovers this process's real listening port without a node connection", async () => {
    if (process.platform !== "linux") return;
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no test address");
      const answer = (await setup().execute({ type: "preview_ports_get", paneId: id }, () => {})) as {
        ports: { port: number }[];
      };
      expect(answer.ports.some((p) => p.port === address.port)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("forwards real bytes and still closes after the switch goes off", async () => {
    const server = createServer((socket) => socket.on("data", (bytes) => socket.write(bytes)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let enabled = true;
    const runtime = setup({ enabled: async () => enabled });
    const events: PreviewLaneEvent[] = [];
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no test address");
      const command: NodeCommandBody = {
        type: "preview_open",
        paneId: id,
        ref,
        kind: "forward",
        port: address.port,
        lifetimeMs: 60_000,
      };
      expect(await runtime.execute(command, (event) => events.push(event))).toEqual({ ref, pending: true });
      runtime.forward.ingestInboundFrame({
        type: "preview_data",
        ref,
        dir: "in",
        blob: Buffer.from("local echo").toString("base64"),
      });
      const deadline = Date.now() + 3000;
      while (!events.some((event) => event.type === "preview_data") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const frame = events.find((event) => event.type === "preview_data");
      expect(frame?.type === "preview_data" ? Buffer.from(frame.blob, "base64").toString() : null).toBe("local echo");
      enabled = false;
      expect(await runtime.execute({ type: "preview_close", ref, reason: "viewer-left" }, () => {})).toEqual({
        ref,
        closed: true,
      });
      expect(runtime.forward.laneCount()).toBe(0);
    } finally {
      runtime.forward.closeAll("viewer-left");
      server.close();
    }
  });
});

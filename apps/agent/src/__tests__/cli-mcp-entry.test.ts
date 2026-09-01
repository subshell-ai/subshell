import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end liveness of the `mote-agent mcp` ENTRY (the regression T18 parity
 * found): `runMoteMcp()` RESOLVES once the stdio transport is connected — the
 * connection itself (the SDK's stdin listener) is what keeps the process
 * alive. If the entry treats that resolution as "command finished" and calls
 * `process.exit`, the live transport dies milliseconds after `ready` and every
 * pane-side MCP client gets a dead connection.
 *
 * Spawns the real source entry (`src/main.ts mcp` — same shape as the compiled
 * binary) against a stub control plane. Pre-fix this child exits 0 right after
 * writing the ready line and never answers `initialize`; the assertion on the
 * JSON-RPC response is the proof of life (and of a working handshake).
 *
 * No live backend: the only REST call `runMoteMcp` makes BEFORE connect is the
 * best-effort `POST /api/identities` (server.ts) — a 2xx JSON stub answers it
 * cleanly. The 12 h token-extension timer is unref'd and never fires here.
 */
const AGENT_MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

test("`mote-agent mcp` stays alive after connect and answers initialize", async () => {
  const stub = Bun.serve({
    port: 0,
    // server.ts only needs a 2xx JSON body back from POST /api/identities.
    fetch: () => Response.json({ ok: true }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), "mote-mcp-entry-"));
  const child = Bun.spawn([process.execPath, AGENT_MAIN, "mcp"], {
    cwd: dataDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MOTE_API_KEY: "mote_entry_test",
      MOTE_BASE_URL: `http://127.0.0.1:${stub.port}`,
      MOTE_SESSION_ID: "entry-test-1",
      MOTE_SESSION_NAME: "entry-test",
      MOTE_DATA_DIR: dataDir,
    },
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cli-mcp-entry-test", version: "0.0.1" },
        },
      })}\n`,
    );

    const response = await Promise.race([
      readInitializeResponse(child),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("no JSON-RPC initialize response within 10 s")), 10_000),
      ),
    ]);

    expect(response.result.serverInfo.name).toBe("mote");
  } finally {
    child.kill();
    stub.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);

/** Resolves with the initialize response line from the child's stdout (JSON-RPC over stdio, newline-delimited). */
async function readInitializeResponse(child: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<{
  result: { serverInfo: { name: string } };
  id: number;
}> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      // The exact pre-fix failure mode: the entry exited 0 after `ready`, so
      // stdout EOFs with no response ever written.
      throw new Error(`child stdout closed before answering initialize (exit ${child.exitCode}); saw: ${pending}`);
    }
    pending += decoder.decode(value, { stream: true });
    for (const line of pending.split("\n")) {
      if (!line.trim()) continue;
      let msg: { id?: number; result?: { serverInfo?: { name?: string } } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1 && msg.result?.serverInfo) {
        return msg as { result: { serverInfo: { name: string } }; id: number };
      }
    }
    pending = pending.slice(pending.lastIndexOf("\n") + 1);
  }
}

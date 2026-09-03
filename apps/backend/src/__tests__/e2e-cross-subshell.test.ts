import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * The headline e2e for cross-subshell comms: a REAL backend process on a real
 * port, a real file database, and two REAL `subshell mcp` child processes (one
 * per fake subshell) driven over stdio by the official MCP client. Everything
 * the assertions below check crosses a process boundary — no in-process
 * stubs. Storage is additionally audited at the byte level: the plaintext
 * marker must appear nowhere in the database files.
 */

/** apps/backend root (this file lives in src/__tests__). */
const BACKEND_DIR = new URL("../../", import.meta.url).pathname;
const BUN = process.execPath;

/** A tool round-trip: call, unwrap the JSON text content, type it. */
async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new Error(`tool ${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

interface ReadResult {
  posts: { seq: number; author: string; text: string; at: string }[];
  undecryptable: number;
  nextSince: number;
}

describe("cross-subshell e2e (two subshell mcp processes)", () => {
  const TIMEOUT = 90_000;
  let dir: string;
  let dbPath: string;
  let port: number;
  let backend: ReturnType<typeof Bun.spawn>;
  let subshells: { id: string; token: string }[];
  let clientA: Client;
  let clientB: Client;

  /** Env every child process needs: dev NODE_ENV (a test NODE_ENV would force
   * the in-memory DB and ignore DATABASE_PATH — see constants.ts) + the file DB. */
  function childEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? tmpdir(),
      NODE_ENV: "development",
      DATABASE_PATH: dbPath,
      ...extra,
    };
  }

  /** Run the seed script and return its JSON stdout (it prints exactly one line). */
  async function seed<T>(mode: string, ...args: string[]): Promise<T> {
    const proc = Bun.spawn({
      cmd: [BUN, "src/scripts/e2e-seed.ts", mode, ...args],
      cwd: BACKEND_DIR,
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`seed ${mode} exited ${code}: ${err.slice(0, 500)}`);
    return JSON.parse(out) as T;
  }

  /** Spawn one `subshell mcp` child for a seeded subshell and connect an MCP client. */
  async function connectMcp(index: number): Promise<Client> {
    const s = subshells[index];
    const client = new Client({ name: `e2e-client-${index}`, version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: BUN,
      args: ["src/mcp/main.ts"],
      cwd: BACKEND_DIR,
      env: childEnv({
        SUBSHELL_API_KEY: s.token,
        SUBSHELL_ID: s.id,
        SUBSHELL_BASE_URL: `http://127.0.0.1:${port}`,
        SUBSHELL_NAME: index === 0 ? "e2e-A" : "e2e-B",
        SUBSHELL_DATA_DIR: join(dir, `mcp-${index}`),
      }),
      stderr: "ignore",
    });
    await client.connect(transport);
    return client;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "subshell-e2e-"));
    dbPath = join(dir, "subshell.db");

    // Claim a free port, release it, hand the number to the backend child.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const free = probe.port;
    if (!free) throw new Error("could not claim a free port");
    port = free;
    await probe.stop();

    backend = Bun.spawn({
      cmd: [BUN, "src/index.ts"],
      cwd: BACKEND_DIR,
      env: childEnv({ SERVER_PORT: String(port), HOST: "127.0.0.1" }),
      stdout: "ignore",
      stderr: Bun.file(join(dir, "backend.log")),
    });

    // Wait until the HTTP listener answers (any status proves it is up). The
    // budget is generous because this boots a REAL backend while the rest of
    // the suite's packages build/test in parallel under turbo — 20 s was
    // routinely starved of CPU and failed here in isolation-fast (<2 s) cases.
    // The outer beforeAll cap (TIMEOUT) still bounds total time.
    const deadline = Date.now() + Math.min(TIMEOUT - 5_000, 60_000);
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/setup`);
        up = res.status < 500;
      } catch {
        await Bun.sleep(250);
      }
    }
    if (!up) throw new Error(`backend did not come up: ${await Bun.file(join(dir, "backend.log")).text()}`);

    const seeded = await seed<{ subshells: { id: string; token: string }[] }>("create");
    subshells = seeded.subshells;
    expect(subshells.length).toBe(2);

    clientA = await connectMcp(0);
    clientB = await connectMcp(1);
  }, TIMEOUT);

  afterAll(async () => {
    await clientA?.close().catch(() => {});
    await clientB?.close().catch(() => {});
    backend?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "A and B converse over an encrypted channel, plaintext never touches the disk",
    async () => {
      // A creates the channel and posts; B joins and long-polls a read.
      expect(await call<{ name: string }>(clientA, "create_channel", { name: "e2e" })).toEqual({ name: "e2e" });
      expect(await call<{ joined: boolean }>(clientB, "join_channel", { name: "e2e" })).toEqual({ joined: true });
      const posted = await call<{ seq: number }>(clientA, "post_channel", { name: "e2e", text: "hello-from-A" });
      expect(posted.seq).toBe(1);

      const readByB = await call<ReadResult>(clientB, "read_channel", { name: "e2e", wait_seconds: 15 });
      expect(readByB.undecryptable).toBe(0);
      const helloA = readByB.posts.find((p) => p.text === "hello-from-A");
      expect(helloA).toBeTruthy();
      expect(helloA?.author).toBe(`sess:${subshells[0].id}`);

      // B replies; A reads its own post plus the reply (sealed to self too).
      await call(clientB, "post_channel", { name: "e2e", text: "hello-from-B" });
      const readByA = await call<ReadResult>(clientA, "read_channel", { name: "e2e", wait_seconds: 15 });
      expect(readByA.undecryptable).toBe(0);
      expect(readByA.posts.map((p) => p.text)).toContain("hello-from-B");

      // The subshell-CRUD face works over the same bearer path.
      const listed = await call<{ id: string; name: string }[]>(clientA, "list_subshells");
      expect(listed.map((s) => s.name).sort()).toEqual(["e2e-A", "e2e-B"]);

      // Byte-level audit of the storage: envelopes present, plaintext absent.
      const audit = await seed<{ envelopeCount: number; envelopesValid: boolean; leaked: boolean }>(
        "ciphertext",
        "hello-from-A",
      );
      expect(audit.envelopeCount).toBe(2);
      expect(audit.envelopesValid).toBe(true);
      expect(audit.leaked).toBe(false);
    },
    TIMEOUT,
  );
});

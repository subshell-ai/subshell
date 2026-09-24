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

/** apps/server/api root (this file lives in src/__tests__). */
const BACKEND_DIR = new URL("../../", import.meta.url).pathname;
const BUN = process.execPath;
const TIMEOUT = 90_000;

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

const dir = mkdtempSync(join(tmpdir(), "subshell-e2e-"));
const dbPath = join(dir, "subshell.db");
const backendLog = join(dir, "backend.log");

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

/**
 * Boot the real backend BEFORE the suite is declared (top-level await).
 *
 * Why top level, and not inside `beforeAll` where this used to live: bun's
 * `skipIf` reads its condition at DECLARATION time and the runtime has no
 * skip — an EADDRINUSE discovered inside a hook can only fail, never skip.
 * The race this file can genuinely suffer on a loaded machine is the
 * claim-a-port / release / hand-off window below: the probe proves a port
 * free, releases it, and another process can claim it before the child
 * binds. When that happens the honest report is a SKIP naming the port
 * (the suite is not broken, the machine was busy), not a red and never a
 * vacuous pass. Every other cause still fails red with the backend's own
 * log. The skip reason rides the boolean here because bun's
 * `describe.skipIf` takes one; the port and the log are what a reader
 * greps for in `backend.log`, kept under the temp dir this file names in
 * its failure text.
 *
 * The wait budget stays as measured: this boots a REAL backend while the
 * rest of the suite's packages build/test in parallel under turbo — 20 s
 * was routinely starved of CPU and failed here in isolation-fast (<2 s)
 * cases. The child's stderr lands in `backend.log`; `src/index.ts` prints
 * a boot crash to stderr SYNCHRONOUSLY precisely because that log is the
 * only verdict this file can read (pino's async destination used to lose
 * the fatal line to `process.exit(1)` truncation — a dead child left an
 * empty log and the failure was undiagnosable).
 */
let port = 0;
let backend: ReturnType<typeof Bun.spawn> | undefined;
const boot = await (async () => {
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
    stderr: Bun.file(backendLog),
  });

  // Wait until the answer is unmistakably OUR backend. The old check was
  // "any status < 500 on /api/setup", which is precisely what the race
  // defeats: whoever squats the released port answers 404, that reads as
  // "up", and the suite died later at the first real call with a confusing
  // error. `GET /api/setup/status` answers {needsSetup, hasUsers} JSON from
  // the route graph itself, so a body carrying that boolean is the backend
  // serving real routes — and an answer WITHOUT it is the squatter.
  const deadline = Date.now() + Math.min(TIMEOUT - 5_000, 60_000);
  let up = false;
  let squatter = false;
  while (Date.now() < deadline && !up && !squatter) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`);
      if (res.status < 500) {
        const body = (await res.json().catch(() => null)) as { needsSetup?: unknown } | null;
        if (typeof body?.needsSetup === "boolean") up = true;
        else squatter = true;
      } else {
        await Bun.sleep(250);
      }
    } catch {
      await Bun.sleep(250);
    }
  }
  const log = up ? "" : await Bun.file(backendLog).text();
  // Port contention has two faces: the child could not bind (bun's message
  // is "Failed to start server. Is port <n> in use?" — it never spells
  // EADDRINUSE, so match both spellings for future versions), or somebody
  // else is answering on the port. Both are the machine being busy, and
  // both SKIP rather than go red — and the old `up` check would have gone
  // red on the SECOND face, later and more confusingly.
  const portBusy = !up && (squatter || /EADDRINUSE|in use\?/i.test(log));
  return { up, portBusy };
})();

// The backend child and the temp dir belong to the MODULE now — a skipped
// suite never runs its own hooks — so their reaper is top level.
afterAll(() => {
  backend?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(boot.portBusy)("cross-subshell e2e (two subshell mcp processes)", () => {
  let subshells: { id: string; token: string }[];
  let clientA: Client;
  let clientB: Client;

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
      // The `mcp` subcommand through the real entry (spec 2026-09-03): the
      // server binary IS the MCP server — the retired companion entry
      // (`src/mcp/main.ts`) is gone; this IS the production spawn shape.
      args: ["src/index.ts", "mcp"],
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
    // Not up and not the port race: fail red, with the backend's own words.
    if (!boot.up) {
      throw new Error(`backend did not come up: ${await Bun.file(backendLog).text()}`);
    }

    const seeded = await seed<{ subshells: { id: string; token: string }[] }>("create");
    subshells = seeded.subshells;
    expect(subshells.length).toBe(2);

    clientA = await connectMcp(0);
    clientB = await connectMcp(1);
  }, TIMEOUT);

  afterAll(async () => {
    await clientA?.close().catch(() => {});
    await clientB?.close().catch(() => {});
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

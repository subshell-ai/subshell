import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, run } from "../cli.js";
import { brokerCredentialPath, brokerServerOrigin } from "../ssh-broker.js";

test("desktop transport requires HTTPS except literal loopback and refuses ambiguous origins", () => {
  for (const url of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?secret=x",
    "https://example.com/#fragment",
    "file:///tmp/config",
  ])
    expect(() => brokerServerOrigin(url)).toThrow();
  expect(brokerServerOrigin("https://example.com/")).toBe("https://example.com");
  expect(brokerServerOrigin("http://127.0.0.1:3199")).toBe("http://127.0.0.1:3199");
});
test("credentials are scoped by server origin and stable desktop id; secrets cannot be argv", () => {
  const id = `desktop:${crypto.randomUUID()}`;
  expect(brokerCredentialPath("https://one.example", id)).not.toBe(brokerCredentialPath("https://two.example", id));
  expect(() => brokerCredentialPath("https://one.example", "../../key")).toThrow();
  expect(parseArgs(["ssh-broker", "--server", "https://one.example", "--broker-id", id]).flags.brokerId).toBe(id);
  expect(() => parseArgs(["ssh-broker", "--server", "https://one.example", "--key", "private"])).toThrow();
});

test("CLI rejects null frames and replayed RPC ids through its cleanup path", async () => {
  for (const attack of ["null", "replay"]) {
    const root = mkdtempSync(join(tmpdir(), "desktop-wire-"));
    const id = `desktop:${crypto.randomUUID()}`;
    let results = 0;
    const request = { type: "command", requestId: "1", command: { type: "ssh_discover_aliases" } };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("Refused", { status: 401 })),
      websocket: {
        open: (ws) => {
          ws.send(JSON.stringify({ type: "attached", id, name: "Fixture" }));
          ws.send(JSON.stringify(request));
        },
        message: (ws, raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.type === "result") {
            results++;
            ws.send(attack === "null" ? "null" : JSON.stringify(request));
          }
        },
      },
    });
    const child = Bun.spawn(
      [process.execPath, "src/main.ts", "ssh-broker", "--server", `http://127.0.0.1:${server.port}`],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, HOME: root, SUBSHELL_CONFIG_HOME: join(root, "config") },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(`${JSON.stringify({ pairingToken: `dsp_${"a".repeat(43)}` })}\n`);
    try {
      expect(await child.exited).toBe(0);
      expect(results).toBe(1);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(readdirSync(join(root, "config", "ssh-broker-runtime"))).toEqual([]);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20_000);

test("forget removes only the selected private origin credential without stdin or network", async () => {
  const id = `desktop:${crypto.randomUUID()}`;
  const first = brokerCredentialPath("https://first.example", id);
  const other = brokerCredentialPath("https://other.example", id);
  mkdirSync(join(first, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(first, "private", { mode: 0o600 });
  writeFileSync(other, "other", { mode: 0o600 });
  try {
    const result = await run(["ssh-broker", "--server", "https://first.example", "--broker-id", id, "--forget"]);
    expect(result).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(other)).toBe(true);
  } finally {
    rmSync(first, { force: true });
    rmSync(other, { force: true });
  }
});

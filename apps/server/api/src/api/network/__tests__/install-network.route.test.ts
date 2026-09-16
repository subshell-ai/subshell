import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { allNetworkPlugins, builtInHarnesses } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { networkRoutes } from "@/api/network/index.js";
import { invalidateNetworkStatus, setNetworkDepsForTests } from "@/api/network/network-gate.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { clearNetworkState } from "@/services/network/state.js";
import { FAKE_ID, fakeDeps, installRecorder, makeFakePlugin } from "./fake-network-plugin.js";

/**
 * `POST /api/network/:id/install` — the vendor's own installer, run on the
 * control-plane host.
 *
 * The two properties worth pinning are both about what RUNS:
 *
 * - **The command comes from the manifest and the request contributes
 *   nothing.** The id is the only caller input, and it selects a command fixed
 *   when the plugin was built.
 * - **It can never be privileged**, and the route does not check: the manifest
 *   parser refuses a `sudo`-prefixed `install.command` at load, so a plugin
 *   declaring one does not load at all. The last test in this file is the
 *   downstream proof, over everything this build actually ships.
 *
 * Nothing here spawns a process: `runInstall` is the deps seam, and a suite
 * that ran a real package manager would be installing software on whoever
 * typed `bun test`.
 */

const app = new Elysia().use(errorHandlerPlugin).use(networkRoutes);

const adminEmail = `network-install-admin-${crypto.randomUUID()}@subshell.local`;
const userEmail = `network-install-user-${crypto.randomUUID()}@subshell.local`;
const password = "network-install-pass-1234";
let adminCookie = "";
let userCookie = "";
let userId = "";

function withCookie(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("cookie", `better-auth.session_token=${adminCookie}`);
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

async function frames(res: Response): Promise<Record<string, any>[]> {
  return (await res.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function install(): Request {
  return withCookie(`/api/network/${FAKE_ID}/install`, { method: "POST" });
}

describe("POST /api/network/:id/install", () => {
  beforeAll(async () => {
    await setupAuthTables();
    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);

    userId = await new UsersRepository(db).createUser({
      email: userEmail,
      name: userEmail,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    userCookie = await signIn(userEmail, password);
  });

  afterEach(async () => {
    setNetworkDepsForTests(null);
    invalidateNetworkStatus();
    await clearNetworkState(FAKE_ID);
  });

  afterAll(async () => {
    if (userId) await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(adminEmail);
    await deleteUserByEmailOrId(userEmail);
  });

  it("refuses an anonymous caller with 401 and a non-admin with 403, before anything runs", async () => {
    const recorder = installRecorder();
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(fakeDeps(entry, { install: recorder }));

    const anonymous = await app.fetch(
      new Request(`http://localhost:3080/api/network/${FAKE_ID}/install`, { method: "POST" }),
    );
    expect(anonymous.status).toBe(401);

    const nonAdmin = await app.fetch(
      new Request(`http://localhost:3080/api/network/${FAKE_ID}/install`, {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${userCookie}` },
      }),
    );
    expect(nonAdmin.status).toBe(403);
    expect(recorder.calls).toEqual([]);
  });

  it("runs the manifest's command through sh -c, and nothing from the request", async () => {
    const recorder = installRecorder();
    const { entry } = makeFakePlugin({ installCommand: "brew install cloudflared" });
    setNetworkDepsForTests(fakeDeps(entry, { install: recorder }));

    const res = await app.fetch(install());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    await frames(res);

    expect(recorder.calls).toEqual([["sh", "-c", "brew install cloudflared"]]);
  });

  it("streams the installer's lines, then one done frame carrying a fresh status", async () => {
    const recorder = installRecorder();
    recorder.lines = ["==> Downloading", "==> Pouring"];
    const { entry, calls } = makeFakePlugin();
    setNetworkDepsForTests(fakeDeps(entry, { install: recorder }));

    const emitted = await frames(await app.fetch(install()));
    expect(emitted.map((f) => f.type)).toEqual(["line", "line", "line", "done"]);
    expect(emitted.some((f) => f.text === "==> Pouring")).toBe(true);
    const done = emitted[emitted.length - 1];
    expect(done.ok).toBe(true);
    expect(done.exitCode).toBe(0);
    // Probed AFTER the run, so one round trip moves the row off
    // `not-installed` instead of reporting the state from before the install.
    expect(done.status.state).toBe("joined");
    expect(calls.status).toBe(1);
  });

  it("reports a failing installer as ok:false inside a 200", async () => {
    const recorder = installRecorder();
    recorder.result = { ok: false, exitCode: 1, output: "Error: no such formula", durationMs: 40 };
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(fakeDeps(entry, { install: recorder }));

    const res = await app.fetch(install());
    expect(res.status).toBe(200);
    const done = (await frames(res)).at(-1);
    expect(done?.type).toBe("done");
    expect(done?.ok).toBe(false);
    expect(done?.output).toContain("no such formula");
  });

  it("404s a plugin that declares no installer the server may run", async () => {
    // The COMMON case: every install path that needs root lives in
    // `network.privileged` instead, which is only ever rendered to copy.
    const recorder = installRecorder();
    const { entry } = makeFakePlugin({ noInstall: true });
    setNetworkDepsForTests(fakeDeps(entry, { install: recorder }));

    const res = await app.fetch(install());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toContain("no installer");
    expect(recorder.calls).toEqual([]);
  });

  it("409s PLATFORM_UNSUPPORTED before running anything", async () => {
    const recorder = installRecorder();
    const { entry } = makeFakePlugin({ platforms: ["linux"] });
    setNetworkDepsForTests(fakeDeps(entry, { platform: () => "darwin", install: recorder }));

    const res = await app.fetch(install());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PLATFORM_UNSUPPORTED");
    expect(recorder.calls).toEqual([]);
  });

  it("404s an id nothing knows, and one the instance has disabled", async () => {
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(fakeDeps(entry, { install: installRecorder() }));
    expect((await app.fetch(withCookie("/api/network/nope/install", { method: "POST" }))).status).toBe(404);

    setNetworkDepsForTests(fakeDeps(entry, { enabled: async () => [], install: installRecorder() }));
    expect((await app.fetch(install())).status).toBe(404);
  });

  it("409s while another act holds the plugin, and releases the lock afterwards", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(
      fakeDeps(entry, {
        runInstall: async () => {
          await gate;
          return { ok: true, exitCode: 0, output: "", durationMs: 1 };
        },
      }),
    );
    const first = await app.fetch(install());
    const second = await app.fetch(install());
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("EXISTS_ERROR");
    release();
    await frames(first);
    expect((await app.fetch(install())).status).toBe(200);
  });

  it("audits the run and never its output", async () => {
    const recorder = installRecorder();
    // An installer's stdout can legitimately carry a token someone typed into
    // their own shell profile moments earlier. The audit log is the one record
    // kept forever, so the output may not land in it.
    const leaked = `installer-output-${crypto.randomUUID()}`;
    recorder.lines = [leaked];
    recorder.result = { ok: true, exitCode: 0, output: leaked, durationMs: 77 };
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(fakeDeps(entry, { install: recorder }));

    await frames(await app.fetch(install()));
    const events = await new AuditRepository(db).listLatest(300);
    const rows = events.filter((e) => e.action === "network.install");
    // `some` rather than the newest row: the other installs in this file land
    // in the same table within the same millisecond, so ordering between them
    // is not a thing to assert on. The `durationMs` is this run's alone.
    const mine = rows.filter((r) => String(r.metadataJson ?? "").includes('"durationMs":77'));
    expect(mine.length).toBe(1);
    expect(JSON.parse(String(mine[0].metadataJson ?? "{}"))).toEqual({ ok: true, exitCode: 0, durationMs: 77 });
    expect(mine[0].targetType).toBe("plugin");
    expect(mine[0].targetId).toBe(FAKE_ID);
    // THE SCAN. The installer's own output may never reach the one record
    // kept forever, whatever shape a later change gives the row.
    for (const row of rows) expect(String(row.metadataJson ?? "")).not.toContain(leaked);
  });

  it("delivers a throwing runner as an error frame inside a 200", async () => {
    const { entry } = makeFakePlugin();
    setNetworkDepsForTests(
      fakeDeps(entry, {
        runInstall: async () => {
          throw new Error("sh is missing");
        },
      }),
    );
    const res = await app.fetch(install());
    expect(res.status).toBe(200);
    const last = (await frames(res)).at(-1);
    expect(last?.type).toBe("error");
    expect(last?.message).toContain("sh is missing");
  });

  it("ships no plugin whose install command needs root", () => {
    // THE PARSER IS WHAT GUARANTEES IT, not this route: `parseManifest` in
    // `@subshell-ai/plugin-api` refuses an `install.command` beginning with
    // `sudo`, so a plugin declaring one fails to load and can never reach the
    // route at all. This is that refusal's downstream proof, over everything
    // this build actually ships — if it ever goes red, a manifest got past the
    // parser rather than past the route.
    const commands = [
      ...allNetworkPlugins().map((e) => e.manifest.install?.command),
      ...builtInHarnesses().map((h) => h.installHint?.command),
    ].filter((c): c is string => typeof c === "string");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect([command, /^\s*sudo(\s|$)/.test(command)]).toEqual([command, false]);
  });
});

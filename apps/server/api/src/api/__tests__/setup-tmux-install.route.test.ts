import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { resolveDeployFacts } from "@/api/admin-status.route.js";
import { setHasUsersProbeForTests } from "@/api/setup.route.js";
import { setTmuxInstallDepsForTests, setupTmuxInstallRoute } from "@/api/setup-tmux-install.route.js";
import { authDatabase } from "@/auth/database.js";
import { chooseTmuxInstaller } from "@/commands/tmux-install.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `POST /api/setup/tmux/install` (spec 2026-09-15 § 5.1, accounted § 6).
 *
 * Two properties carry this route, and both are pinned below:
 *
 * - It is NEVER public, unlike the rest of `/api/setup`, which is open while
 *   the instance has no users. This one runs a package manager on the host,
 *   so it follows the agent installer's admin-cookie gate instead.
 * - It refuses anything `sudo`-prefixed. The server has no terminal to answer
 *   a password prompt, so a privileged installer would hang to the timeout —
 *   and that refusal is what keeps "the server installs tmux" from meaning
 *   "the server escalates".
 *
 * Nothing here ever runs a real package manager: `chooseInstaller` is injected
 * with a harmless argv on the one path that spawns anything.
 */

const app = new Elysia().use(errorHandlerPlugin).use(setupTmuxInstallRoute);

function bearerRequest(path: string, key: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

async function install(init?: RequestInit): Promise<Response> {
  return await app.fetch(new Request("http://localhost:3080/api/setup/tmux/install", { method: "POST", ...init }));
}

/** Every NDJSON frame of a streamed run, in order. */
async function frames(res: Response): Promise<{ type: string; [key: string]: unknown }[]> {
  return (await res.text())
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { type: string });
}

/** The `tmux.install` audit trail, newest first. */
async function tmuxAudit(): Promise<
  { actorUserId: string | null; targetType: string | null; metadata: Record<string, unknown> }[]
> {
  const events = await new AuditRepository(db).listLatest(300);
  return events
    .filter((e) => e.action === "tmux.install")
    .map((e) => ({
      actorUserId: e.actorUserId,
      targetType: e.targetType,
      metadata: JSON.parse(String(e.metadataJson ?? "{}")) as Record<string, unknown>,
    }));
}

describe("POST /api/setup/tmux/install", () => {
  const email = `tmux-install-${crypto.randomUUID()}@subshell.local`;
  const password = "tmux-install-pass-1234";
  const adminEmail = `tmux-install-admin-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let cookie: string;
  let adminCookie: string;
  let subshellId = "";
  let subshellKey = "";
  let apiKeyId: string | undefined;

  beforeAll(async () => {
    await setupAuthTables();

    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "tmux-install-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? undefined;
  });

  afterAll(async () => {
    setHasUsersProbeForTests(null);
    setTmuxInstallDepsForTests(null);
    if (subshellId) await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    if (userId) await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(adminEmail);
  });

  beforeEach(() => {
    setTmuxInstallDepsForTests(null);
  });

  it("401s with no credential at all, even while the instance has no users yet", async () => {
    // The load-bearing case: the rest of /api/setup is public during first
    // run, and this route must not inherit that window — it runs a package
    // manager as the server's own user.
    setHasUsersProbeForTests(async () => false);
    try {
      expect((await install()).status).toBe(401);
    } finally {
      setHasUsersProbeForTests(null);
    }
  });

  it("403s a signed-in non-admin cookie", async () => {
    const res = await app.fetch(authedRequest("/api/setup/tmux/install", cookie, { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("403s any bearer key, including a valid subshell key", async () => {
    const res = await app.fetch(bearerRequest("/api/setup/tmux/install", subshellKey, { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("409s when no package manager on this host is known", async () => {
    setTmuxInstallDepsForTests({
      chooseInstaller: () => null,
      which: () => null,
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const res = await app.fetch(authedRequest("/api/setup/tmux/install", adminCookie, { method: "POST" }));
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("409s a sudo-prefixed installer rather than hanging on a password prompt", async () => {
    setTmuxInstallDepsForTests({
      chooseInstaller: () => ({
        argv: ["sudo", "apt-get", "install", "-y", "tmux"],
        label: "apt-get",
        manual: "apt install tmux",
      }),
      which: () => null,
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const res = await app.fetch(authedRequest("/api/setup/tmux/install", adminCookie, { method: "POST" }));
    expect(res.status).toBe(409);
    // Refused BEFORE a byte was streamed: once the body opens the status line
    // is sent and 200 cannot be taken back.
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("409s the Homebrew bootstrap and the MacPorts row: the no-terminal route runs only what needs no password", async () => {
    // The 2026-09-26 ladder widened the CLI's OFFER (a terminal can answer a
    // password); this route has no terminal, so the same two entries the CLI
    // may run it must refuse HERE, by name, before the body opens.
    const bootstrap = chooseTmuxInstaller({ platform: "darwin", which: () => null });
    expect(bootstrap?.label).toBe("Homebrew"); // the table really yields it
    setTmuxInstallDepsForTests({
      chooseInstaller: () => bootstrap!,
      which: () => null,
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const bs = await app.fetch(authedRequest("/api/setup/tmux/install", adminCookie, { method: "POST" }));
    expect(bs.status).toBe(409);
    expect(((await bs.json()) as { message: string }).message).toMatch(/admin password/i);

    const ports = chooseTmuxInstaller({
      platform: "darwin",
      which: (n) => (n === "port" ? "/opt/local/bin/port" : null),
    });
    expect(ports?.label).toBe("MacPorts");
    setTmuxInstallDepsForTests({
      chooseInstaller: () => ports!,
      which: () => null,
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const mp = await app.fetch(authedRequest("/api/setup/tmux/install", adminCookie, { method: "POST" }));
    expect(mp.status).toBe(409);
    expect(((await mp.json()) as { message: string }).message).toMatch(/port install tmux/i);
  });

  it("covers the real Linux table: every Linux installer chooseTmuxInstaller picks is sudo-prefixed", () => {
    // The refusal above is injected, so this is what ties it to the table the
    // route actually runs in production — if a future non-privileged Linux
    // installer joins, this is the test that says the route may now offer it.
    for (const manager of ["apt-get", "dnf"]) {
      const installer = chooseTmuxInstaller({
        platform: "linux",
        which: (n) => (n === manager ? `/usr/bin/${n}` : null),
      });
      expect(installer?.argv[0]).toBe("sudo");
    }
    // ...and that macOS's is not, which is the one the button exists for.
    const brew = chooseTmuxInstaller({
      platform: "darwin",
      which: (n) => (n === "brew" ? "/opt/homebrew/bin/brew" : null),
    });
    expect(brew?.argv[0]).toBe("brew");
  });

  it("runs the installer for an admin, re-probes tmux, and drops the memoized deploy facts", async () => {
    // Prime the memo first: the Status page caches tmuxPath for the life of
    // the process, so an install that did not invalidate it would report the
    // old answer forever.
    const before = resolveDeployFacts();
    setTmuxInstallDepsForTests({
      chooseInstaller: () => ({ argv: ["echo", "installed tmux"], label: "fake", manual: "echo" }),
      which: (name) => (name === "tmux" ? "/usr/local/bin/tmux" : null),
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const res = await app.fetch(authedRequest("/api/setup/tmux/install", adminCookie, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const streamed = await frames(res);
    expect(streamed.some((f) => f.type === "line" && f.text === "installed tmux")).toBe(true);
    const done = streamed.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.ok).toBe(true);
    expect(done?.tmuxPath).toBe("/usr/local/bin/tmux");

    // A NEW object, not the primed one: identity is what proves the memo was
    // dropped rather than merely agreeing by coincidence.
    expect(resolveDeployFacts()).not.toBe(before);

    const row = (await tmuxAudit())[0];
    expect(row).toBeDefined();
    expect(row?.targetType).toBe("node");
    expect(row?.metadata).toMatchObject({ ok: true, exitCode: 0, installer: "fake", found: true });
  });

  it("reports an installer that ran and failed as ok:false inside a 200", async () => {
    // A failing installer is a RESULT, not a refusal: it ran. The status was
    // already sent by then, so the only place this can be said is a frame.
    setTmuxInstallDepsForTests({
      chooseInstaller: () => ({ argv: ["sh", "-c", "exit 3"], label: "fake", manual: "exit 3" }),
      which: () => null,
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const res = await app.fetch(authedRequest("/api/setup/tmux/install", adminCookie, { method: "POST" }));
    expect(res.status).toBe(200);
    const done = (await frames(res)).at(-1);
    expect(done?.type).toBe("done");
    expect(done?.ok).toBe(false);
    expect(done?.exitCode).toBe(3);
    expect(done?.tmuxPath).toBeNull();
  });
});

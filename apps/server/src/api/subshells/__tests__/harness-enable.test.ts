import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { TRUE_BINARY } from "@/__tests__/helpers/true-binary.js";
import { profileRoutes } from "@/api/profiles.route.js";
import { setupRoutes } from "@/api/setup.route.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The enable/disable loop: PATCH flips state (enabling re-runs install
 * detection), a disabled or not-installed harness hides its profiles from
 * the list and rejects new profiles/subshells, and re-enabling restores
 * everything — rows are never deleted.
 *
 * Security audit 2026-08 (F3) adaptation: once a user exists,
 * GET /harnesses needs any authenticated actor and PATCH needs a COOKIE
 * subshell — this suite's calls therefore carry the signed-in cookie (the
 * pre-setup anonymous window is covered by setup-route.test.ts).
 */
describe("harness enable/disable", () => {
  let email: string;
  let token: string;
  const password = "enable-pass-1";

  beforeAll(async () => {
    // The positive ("installed") path must not depend on the machine having
    // the real claude binary: CI runners do not, and every claude-code call
    // here 409s as "not installed". CLAUDE_PATH is the plugin's documented
    // binary override (claude-code.ts findBinary) — the same technique the
    // pi negative case below uses with PI_PATH. /bin/true exists on every
    // POSIX runner and answers `--version` with exit 0.
    process.env.CLAUDE_PATH = TRUE_BINARY;
    await setupAuthTables();
    // The subshell-create call below takes resolveLaunchNode's step 3 (the
    // seeded local node). That row arrives with app boot in production, and
    // with whichever test file booted first in the full suite — this file
    // must not depend on suite order (CI ordering proved it does).
    await ensureLocalNode(db);
    email = `enable-${crypto.randomUUID()}@subshell.local`;
    await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(password), role: "user" });
    token = await signIn(email, password);
  });

  afterAll(async () => {
    // Leave the registry as we found it.
    await setupRoutes.fetch(
      new Request("http://localhost:3080/api/setup/harnesses/claude-code", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${token}` },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    delete process.env.PI_PATH;
    delete process.env.CLAUDE_PATH;
    await db.deleteFrom("profiles").execute();
    await deleteUserByEmailOrId(email);
  });

  async function patchHarness(id: string, enabled: boolean) {
    const res = await setupRoutes.fetch(
      new Request(`http://localhost:3080/api/setup/harnesses/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${token}` },
        body: JSON.stringify({ enabled }),
      }),
    );
    return { status: res.status, body: (await res.json().catch(() => null)) as { enabled?: boolean } | null };
  }

  async function listProfiles() {
    const res = await profileRoutes.fetch(authedRequest("/api/profiles", token));
    return (await res.json()) as { id: string; harnessId: string; name: string; isDefault: number }[];
  }

  async function createProfile(harnessId: string) {
    const res = await profileRoutes.fetch(
      authedRequest("/api/profiles", token, {
        method: "POST",
        body: JSON.stringify({ harnessId, name: `p-${harnessId}` }),
      }),
    );
    return { status: res.status, body: (await res.json().catch(() => null)) as { id: string } | null };
  }

  it("GET harnesses carries the install hint", async () => {
    const res = await setupRoutes.fetch(
      new Request("http://localhost:3080/api/setup/harnesses", {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
    );
    const rows = (await res.json()) as { id: string; install: { command: string; docsUrl: string } }[];
    const pi = rows.find((r) => r.id === "pi");
    expect(pi?.install.command).toContain("pi.dev/install.sh");
    expect(pi?.install.docsUrl).toMatch(/^https:\/\//);
  });

  it("disable then enable an installed harness", async () => {
    expect((await patchHarness("claude-code", false)).body?.enabled).toBe(false);
    expect((await patchHarness("claude-code", true)).body?.enabled).toBe(true);
  });

  it("enabling seeds this user their missing claude-code Default (route seam)", async () => {
    // This suite's user was minted through UsersRepository (no registration
    // hook), so they hold no auto-Defaults until a harness enable passes
    // through setup.route — the seam's only end-to-end proof. The enable
    // above already ran; re-assert through a fresh off/on cycle.
    await db
      .deleteFrom("profiles")
      .where("userId", "=", await userIdFor(email))
      .execute();
    expect((await patchHarness("claude-code", false)).status).toBe(200);
    expect((await patchHarness("claude-code", true)).status).toBe(200);
    const rows = (await listProfiles()).filter((p) => p.harnessId === "claude-code");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: "Default", isDefault: 1 });
  });

  async function userIdFor(addr: string): Promise<string> {
    // Raw SQL: better-auth's `user` table sits outside the typed schema with
    // literal camelCase columns the CamelCasePlugin would rewrite.
    const r = await sql<{ id: string }>`SELECT id FROM user WHERE email = ${addr}`.execute(db);
    const id = r.rows[0]?.id;
    if (!id) throw new Error(`no user for ${addr}`);
    return id;
  }

  it("enabling a not-installed harness -> 409 and stays disabled", async () => {
    // PI_PATH is the documented binary override; a bogus path makes pi's
    // detection fail exactly as it would on a machine without pi.
    process.env.PI_PATH = "/definitely/not/here/pi";
    const off = await patchHarness("pi", false);
    expect(off.status).toBe(200);
    const on = await patchHarness("pi", true);
    expect(on.status).toBe(409);
    const list = (await (
      await setupRoutes.fetch(
        new Request("http://localhost:3080/api/setup/harnesses", {
          headers: { cookie: `better-auth.session_token=${token}` },
        }),
      )
    ).json()) as { id: string; installed: boolean; enabled: boolean }[];
    expect(list.find((r) => r.id === "pi")).toMatchObject({ installed: false, enabled: false });
    delete process.env.PI_PATH;
  });

  it("unknown harness -> 404", async () => {
    expect((await patchHarness("nope", true)).status).toBe(404);
  });

  it("disabling hides its profiles; re-enabling brings them back; creation is blocked", async () => {
    await db.deleteFrom("profiles").execute();
    const created = await createProfile("claude-code");
    expect(created.status).toBe(200);
    const profileId = created.body?.id;
    if (!profileId) throw new Error("expected a created profile");
    expect((await listProfiles()).map((p) => p.id)).toContain(profileId);

    await patchHarness("claude-code", false);
    expect(await listProfiles()).toEqual([]);

    const blocked = await createProfile("claude-code");
    expect(blocked.status).toBe(409);

    const subshell = await subshellRoutes.fetch(
      authedRequest("/api/subshells", token, {
        method: "POST",
        body: JSON.stringify({ profileId, workingDir: "/tmp" }),
      }),
    );
    expect(subshell.status).toBe(409);
    if (subshell.ok) {
      // Regression guard: if the gate ever lets this through, do not leave a
      // live tmux subshell behind.
      const { id } = (await subshell.json()) as { id: string };
      await subshellRoutes.fetch(authedRequest(`/api/subshells/${id}`, token, { method: "DELETE" }));
    }

    await patchHarness("claude-code", true);
    expect((await listProfiles()).map((p) => p.id)).toContain(profileId);
  });
});

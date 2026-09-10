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
 * The install/uninstall loop on the control-plane host: a plugin this host
 * does not have hides its profiles from the list and rejects new
 * profiles/subshells, and installing it restores everything — profile rows
 * are never deleted.
 *
 * **This replaced an enable/disable loop (spec 2026-09-09 §12), and one rule
 * changed with it rather than merely being renamed.** Enabling used to re-run
 * binary detection and refuse with a 409 when the program was missing, which
 * conflated two facts. Installing a PLUGIN and having its PROGRAM are now
 * separate: the install succeeds either way, and the missing program shows as
 * `installed: false` on the row. The launch gate still needs both, so nothing
 * became launchable that was not before.
 *
 * Security audit 2026-08 (F3) adaptation: once a user exists, GET /harnesses
 * needs any authenticated actor and the writes need a COOKIE — this suite's
 * calls therefore carry the signed-in cookie (the pre-setup anonymous window
 * is covered by setup-route.test.ts).
 */
describe("harness install/uninstall", () => {
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
    // ADMIN: installing and removing plugins on this host is an admin act, the
    // same as through `POST /api/nodes/local/plugins`. A non-admin's refusal
    // is pinned in setup-route.test.ts.
    await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(password), role: "admin" });
    token = await signIn(email, password);
  });

  afterAll(async () => {
    // Leave the host as we found it: suites share one data dir.
    await setPlugin("claude-code", true);
    await setPlugin("pi", true);
    delete process.env.PI_PATH;
    delete process.env.CLAUDE_PATH;
    await db.deleteFrom("profiles").execute();
    await deleteUserByEmailOrId(email);
  });

  async function setPlugin(id: string, installed: boolean) {
    const res = await setupRoutes.fetch(
      installed
        ? new Request(`http://localhost:3080/api/setup/plugins`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `better-auth.session_token=${token}` },
            body: JSON.stringify({ pluginId: id }),
          })
        : new Request(`http://localhost:3080/api/setup/plugins/${id}`, {
            method: "DELETE",
            headers: { cookie: `better-auth.session_token=${token}` },
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

  it("remove then install a plugin on this host", async () => {
    expect((await setPlugin("claude-code", false)).status).toBe(200);
    expect((await setPlugin("claude-code", true)).status).toBe(200);
  });

  it("installing seeds this user their missing claude-code Default (route seam)", async () => {
    // This suite's user was minted through UsersRepository (no registration
    // hook), so they hold no auto-Defaults until an install passes through
    // setup.route — the seam's only end-to-end proof, and the behaviour the
    // enable toggle used to carry.
    await db
      .deleteFrom("profiles")
      .where("userId", "=", await userIdFor(email))
      .execute();
    expect((await setPlugin("claude-code", false)).status).toBe(200);
    expect((await setPlugin("claude-code", true)).status).toBe(200);
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

  it("installs a plugin whose PROGRAM is missing, and says the program is missing", async () => {
    // The rule that changed. Enabling used to 409 here, conflating "this host
    // offers the plugin" with "the program it drives is present". They are
    // two facts now: the install succeeds, and the row reports the second one
    // honestly. The launch gate still requires both.
    process.env.PI_PATH = "/definitely/not/here/pi";
    expect((await setPlugin("pi", false)).status).toBe(200);
    expect((await setPlugin("pi", true)).status).toBe(200);

    const list = (await (
      await setupRoutes.fetch(
        new Request("http://localhost:3080/api/setup/harnesses", {
          headers: { cookie: `better-auth.session_token=${token}` },
        }),
      )
    ).json()) as { id: string; installed: boolean; installedHere: boolean }[];
    // Two fields, two facts: this host HAS the plugin, and its program is not
    // on the machine. Conflating them is what the old 409 did.
    expect(list.find((r) => r.id === "pi")).toMatchObject({ installed: false, installedHere: true });
    delete process.env.PI_PATH;
  });

  it("an id this build does not carry -> 400, naming it", async () => {
    // 400 rather than the old toggle's 404: the id is a value in the request
    // body, and a 404 on a POST reads as "no such route". The refusal itself
    // is the security-relevant part — see setup.route.ts.
    const res = await setPlugin("nope", true);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("nope");
  });

  it("removing hides its profiles; installing brings them back; creation is blocked meanwhile", async () => {
    await db.deleteFrom("profiles").execute();
    const created = await createProfile("claude-code");
    expect(created.status).toBe(200);
    const profileId = created.body?.id;
    if (!profileId) throw new Error("expected a created profile");
    expect((await listProfiles()).map((p) => p.id)).toContain(profileId);

    await setPlugin("claude-code", false);
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

    await setPlugin("claude-code", true);
    expect((await listProfiles()).map((p) => p.id)).toContain(profileId);
  });
});

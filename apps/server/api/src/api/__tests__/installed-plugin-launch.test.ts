import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarnessCommand,
  getHarness,
  pluginsDir,
  refreshInstalledPlugins,
  uninstallPlugin,
} from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { harnessUsable, usableHarnessIds } from "@/api/harness-utils.js";
import { profileRoutes } from "@/api/profiles.route.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { FakeNodeLauncher } from "@/services/__tests__/helpers/node-fakes.js";
import { detectSpecs } from "@/services/nodes/inventory.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The control plane can launch what the instance store holds (Task 9b).
 *
 * The hole this pins: after Task 9, a registry-installed plugin listed,
 * toggled and uninstalled through the instance door, but every launch-path
 * lookup keyed off the compiled-in built-ins, so it could never DETECT,
 * never validate a profile, and never build an argv. A scripted "acme" plugin
 * written into the server's own plugin dir must therefore flow through the
 * whole plane side of a launch: the detect spec the plane ships to nodes,
 * the profile-create validation, and the argv assembly — which is exactly
 * what Task 13's e2e spec 14 will assert end to end from a node holding
 * nothing.
 *
 * Shared-state discipline: like `plugins-route.test.ts`, this file changes
 * the per-process plugin directory and MUST put the host back — the last
 * test uninstalls, and `afterAll` re-runs both removals as a net.
 */

const testDir = mkdtempSync(join(tmpdir(), "acme-launch-"));
const app = new Elysia().use(errorHandlerPlugin).use(profileRoutes);

/** The stub binary `detect` finds, via the manifest's envOverride. */
const ACME_STUB = join(testDir, "acme-cli");

async function installAcme(): Promise<void> {
  const dir = join(pluginsDir(SUBSHELL_SERVER_DATA_DIR), "acme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "acme-harness",
      version: "1.0.0",
      type: "module",
      subshell: {
        apiVersion: 1,
        id: "acme",
        type: "agent-harness",
        name: "Acme",
        description: "a scripted third-party harness",
        entry: "index.js",
        detect: { binaryName: "acme-cli", envOverride: "ACME_CLI_PATH", knownPaths: [] },
      },
    }),
    "utf8",
  );
  // The argv marker is what the launch test greps for: it can only appear if
  // THIS plugin's `buildCommand` answered, from the overlay, in this process.
  writeFileSync(
    join(dir, "index.js"),
    "export default () => ({\n" +
      "  capabilities: () => [],\n" +
      "  buildCommand: (input) => [input.binary, '--acme-harness', ...input.profile.flags],\n" +
      "  validateProfile: () => ({ valid: true, issues: [] }),\n" +
      "});\n",
    "utf8",
  );
  await refreshInstalledPlugins(SUBSHELL_SERVER_DATA_DIR);
}

let aliceCookie = "";
let aliceId = "";
let aliceEmail = "";
let profileId = "";

beforeAll(async () => {
  await setupAuthTables();
  writeFileSync(ACME_STUB, "#!/bin/sh\necho acme 1.2.3\n", { mode: 0o755 });
  process.env.ACME_CLI_PATH = ACME_STUB;
  await installAcme();

  aliceEmail = `acme-launch-${crypto.randomUUID()}@subshell.local`;
  aliceId = await new UsersRepository(db).createUser({
    email: aliceEmail,
    passwordHash: await hashPassword("acme-launch-1"),
    role: "user",
  });
  aliceCookie = await signIn(aliceEmail, "acme-launch-1");
});

afterAll(async () => {
  // The net under the last test's removals: the directory and the overlay
  // must both be back to "no acme" for whatever file runs next.
  await uninstallPlugin(SUBSHELL_SERVER_DATA_DIR, "acme").catch(() => {});
  await refreshInstalledPlugins(SUBSHELL_SERVER_DATA_DIR).catch(() => {});
  delete process.env.ACME_CLI_PATH;
  await new ProfilesRepository(db).deleteByHarness("acme").catch(() => {});
  await db
    .deleteFrom("subshells")
    .where("harnessId", "=", "acme")
    .execute()
    .catch(() => {});
  await deleteUserByEmailOrId(aliceEmail).catch(() => {});
  rmSync(testDir, { recursive: true, force: true });
});

describe("an installed plugin resolves on the plane's side of a launch", () => {
  it("detectSpecs ships acme's lookup rule to nodes, beside the five built-ins", () => {
    const specs = detectSpecs();
    expect(specs.find((s) => s.id === "acme")).toEqual({
      id: "acme",
      binaryName: "acme-cli",
      envOverride: "ACME_CLI_PATH",
      knownPaths: [],
    });
    // The built-ins did not move (the shadow/merge rule costs nothing).
    for (const id of ["claude-code", "codex", "hermes", "opencode", "pi"]) {
      expect(specs.some((s) => s.id === id)).toBe(true);
    }
  });

  it("the launch gate finds acme's binary through the resolved plugin", async () => {
    // `probeInstalledOnly` (the local path of the gate) can only probe a
    // plugin `getHarness` resolves; before Task 9b acme had no entry at all.
    expect(getHarness("acme")).toBeDefined();
    expect(await harnessUsable("acme")).toBe(true);
    expect((await usableHarnessIds()).has("acme")).toBe(true);
  });

  it("a profile-create for acme validates and the harness schema reads", async () => {
    const res = await app.fetch(
      authedRequest("/api/profiles", aliceCookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "acme", name: "Acme Default", flags: ["--acme-flag"] }),
      }),
    );
    expect(res.status).toBe(200);
    const profile = (await res.json()) as { id: string; harnessId: string };
    profileId = profile.id;
    expect(profile.harnessId).toBe("acme");

    const schema = await app.fetch(authedRequest("/api/profiles/harnesses/acme/schema", aliceCookie));
    expect(schema.status).toBe(200);
    expect(((await schema.json()) as { settingsFields: unknown[] }).settingsFields).toEqual([]);
  });

  it("a create resolves acme and builds the argv from ITS buildCommand", async () => {
    const fake = new FakeNodeLauncher(testDir);
    const manager = new SubshellManagerService({
      subshells: new SubshellsRepository(db),
      profiles: new ProfilesRepository(db),
      launcher: fake,
      tokens: { issue: async () => "subshell_stub", revoke: async () => {} },
      audit: async () => {},
    });
    const created = await manager.createSubshell({
      userId: aliceId,
      profileId,
      workingDir: testDir,
    });

    expect(fake.plans).toHaveLength(1);
    const plan = fake.plans[0];
    if (!plan) throw new Error("the fake launcher recorded no plan");
    expect(plan.harness.id).toBe("acme");
    expect(plan.id).toBe(created.id);

    // The pane command, assembled exactly as `LocalLauncher.launch` assembles
    // it from the recorded plan. Every marker below can only be there if the
    // OVERLAY's plugin answered: `--acme-harness` is its argv, `--acme-flag`
    // the profile's flags spliced by it, `subshell_stub` the minted token
    // baked into the env layer.
    const cmd = buildHarnessCommand(
      plan.harness,
      plan.binary,
      plan.cwd,
      plan.profile,
      plan.subshellName,
      plan.subshellEnv,
      plan.mcp,
      plan.harnessSession,
    );
    expect(cmd).toContain("--acme-harness");
    expect(cmd).toContain("--acme-flag");
    expect(cmd).toContain("subshell_stub");

    await new SubshellsRepository(db).delete(created.id);
  });

  it("after an uninstall, acme stops resolving and profile-create is a 400 again", async () => {
    // The revert-proof of the whole seam: resolution follows the store, so
    // what remains after removal is the pre-Task-9b refusal — the profile
    // gate asks `getHarness`, and it is the overlay that answered for acme.
    expect(await uninstallPlugin(SUBSHELL_SERVER_DATA_DIR, "acme")).toBe(true);
    await refreshInstalledPlugins(SUBSHELL_SERVER_DATA_DIR);
    expect(getHarness("acme")).toBeUndefined();

    const res = await app.fetch(
      authedRequest("/api/profiles", aliceCookie, {
        method: "POST",
        body: JSON.stringify({ harnessId: "acme", name: "Ghost" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { presetRoutes } from "@/api/presets.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * GET /api/presets/harnesses/:id/schema — the reference endpoint that backs
 * the preset editor's env/flag autocomplete. Read-only over the static
 * harness registry, so one user's view is every user's view.
 */
describe("harness schema route", () => {
  let email: string;
  let token: string;
  const password = "schema-pass-1";

  beforeAll(async () => {
    await setupAuthTables();
    email = `schema-${crypto.randomUUID()}@subshell.local`;
    await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    token = await signIn(email, password);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(email);
  });

  it("anonymous -> 401", async () => {
    const res = await presetRoutes.fetch(new Request("http://localhost/api/presets/harnesses/claude-code/schema"));
    expect(res.status).toBe(401);
  });

  it("known harness -> full schema payload", async () => {
    const res = await presetRoutes.fetch(authedRequest("/api/presets/harnesses/claude-code/schema", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settingsFields: { key: string }[];
      suggestedEnv: { key: string; description: string }[];
      suggestedFlags: { flag: string; description: string }[];
      mcp: { mode: string; summary?: string; steps?: unknown[] };
    };
    expect(body.settingsFields.map((f) => f.key)).toContain("permissionMode");
    expect(body.suggestedEnv.map((e) => e.key)).toContain("ANTHROPIC_API_KEY");
    expect(body.suggestedFlags.map((f) => f.flag)).toContain("--dangerously-skip-permissions");
    for (const e of body.suggestedEnv) expect(typeof e.description).toBe("string");
    // Cross-subshell comms: claude-code needs nothing from the user.
    expect(body.mcp.mode).toBe("auto");
    expect(typeof body.mcp.summary).toBe("string");
  });

  it("manual harness -> copy-paste mcp setup steps in the portable PATH form", async () => {
    const res = await presetRoutes.fetch(authedRequest("/api/presets/harnesses/hermes/schema", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mcp: { mode: string; steps?: { label: string; command: string }[] };
    };
    expect(body.mcp.mode).toBe("manual");
    const steps = body.mcp.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    // Issue #57: the registration is pasted onto EVERY machine that hosts a
    // pane (the section copy says so, and presets name no node), so the shown
    // command must be machine-agnostic. The control plane's RESOLVED launch
    // — the SELF rung's absolute path, or the `subshell-server` placeholder —
    // is the one wrong answer off the plane host: it names a program that
    // machine does not have. `subshell` is every enrolled node's own binary,
    // on its PATH by install; the harness resolves it at spawn time there.
    expect(steps[0].command).toContain("hermes mcp add subshell --command 'subshell' --args 'mcp'");
    expect(steps[0].command).not.toContain(process.execPath);
    expect(steps[0].command).not.toContain("subshell-server");
    for (const s of steps) expect(s.label.length).toBeGreaterThan(0);
  });

  it("pi -> the manual snippet registers the portable `subshell mcp` command", async () => {
    const res = await presetRoutes.fetch(authedRequest("/api/presets/harnesses/pi/schema", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mcp: { mode: string; steps?: { command: string }[] } };
    expect(body.mcp.mode).toBe("manual");
    const snippet = (body.mcp.steps ?? [])[1]?.command ?? "";
    const parsed = JSON.parse(snippet) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcpServers.subshell).toEqual({ command: "subshell", args: ["mcp"] });
  });

  it("opencode harness -> settings map to flags", async () => {
    const res = await presetRoutes.fetch(authedRequest("/api/presets/harnesses/opencode/schema", token));
    const body = (await res.json()) as { settingsFields: { key: string }[] };
    expect(body.settingsFields.map((f) => f.key).sort()).toEqual(["agent", "auto", "model"]);
  });

  it("unknown harness -> 404", async () => {
    const res = await presetRoutes.fetch(authedRequest("/api/presets/harnesses/nope/schema", token));
    expect(res.status).toBe(404);
  });
});

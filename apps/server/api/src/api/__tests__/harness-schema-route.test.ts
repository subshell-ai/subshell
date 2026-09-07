import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { profileRoutes } from "@/api/profiles.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * GET /api/profiles/harnesses/:id/schema — the reference endpoint that backs
 * the profile editor's env/flag autocomplete. Read-only over the static
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
      passwordHash: await hashPassword(password),
      role: "user",
    });
    token = await signIn(email, password);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(email);
  });

  it("anonymous -> 401", async () => {
    const res = await profileRoutes.fetch(new Request("http://localhost/api/profiles/harnesses/claude-code/schema"));
    expect(res.status).toBe(401);
  });

  it("known harness -> full schema payload", async () => {
    const res = await profileRoutes.fetch(authedRequest("/api/profiles/harnesses/claude-code/schema", token));
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

  it("manual harness -> copy-paste mcp setup steps with the resolved launch", async () => {
    const res = await profileRoutes.fetch(authedRequest("/api/profiles/harnesses/hermes/schema", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mcp: { mode: string; steps?: { label: string; command: string }[] };
    };
    expect(body.mcp.mode).toBe("manual");
    const steps = body.mcp.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    // The add command must embed the launch RESOLVED BY THE BACKEND (under
    // bun test that is the SELF rung: this very bun + an absolute entry + the
    // `mcp` subcommand) — not the degraded `subshell-server mcp` display
    // placeholder, which the prefix check alone cannot tell apart.
    expect(steps[0].command).toContain("hermes mcp add subshell --command ");
    expect(steps[0].command).toContain(process.execPath);
    expect(steps[0].command.endsWith("'mcp'")).toBe(true);
    expect(steps[0].command).not.toContain("subshell-server");
    for (const s of steps) expect(s.label.length).toBeGreaterThan(0);
  });

  it("opencode harness -> settings map to flags", async () => {
    const res = await profileRoutes.fetch(authedRequest("/api/profiles/harnesses/opencode/schema", token));
    const body = (await res.json()) as { settingsFields: { key: string }[] };
    expect(body.settingsFields.map((f) => f.key).sort()).toEqual(["agent", "auto", "model"]);
  });

  it("unknown harness -> 404", async () => {
    const res = await profileRoutes.fetch(authedRequest("/api/profiles/harnesses/nope/schema", token));
    expect(res.status).toBe(404);
  });
});

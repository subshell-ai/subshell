import { describe, expect, it } from "bun:test";
import { db } from "@/db/index.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { ApiContext, getRequestlessContext, resetRequestlessContext } from "@/lib/context.js";
import { SessionsService } from "@/services/sessions.service.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The requestless context is the entry point for non-request callers (ws,
 * mcp). It must be a stable singleton (services hold no per-call state worth
 * rebuilding) and arrive fully wired — repos and services included.
 * The per-process temp-file test DB from test-preload applies automatically.
 */
describe("getRequestlessContext", () => {
  it("returns the same instance on every call", () => {
    expect(getRequestlessContext()).toBe(getRequestlessContext());
  });

  it("exposes the shared db and a log", () => {
    const ctx = getRequestlessContext();
    expect(ctx.db).toBe(db);
    expect(ctx.log).toBeDefined();
  });

  it("builds the repositories", () => {
    const ctx = getRequestlessContext();
    expect(ctx.repos.sessions).toBeInstanceOf(SessionsRepository);
    expect(ctx.repos.profiles).toBeInstanceOf(ProfilesRepository);
  });

  it("builds the services and links the sibling map", () => {
    const ctx = getRequestlessContext();
    expect(ctx.services.sessions).toBeInstanceOf(SessionsService);
    // BaseService.withServices wiring: every service sees the full map.
    expect(ctx.services.sessions.services).toBe(ctx.services);
  });

  it("resetRequestlessContext drops the cached instance (@internal test hook)", () => {
    const first = getRequestlessContext();
    resetRequestlessContext();
    // After a reset the next call rebuilds rather than returning the old one —
    // this is the isolation hook Task 6's ws/mcp tests will rely on.
    expect(getRequestlessContext()).not.toBe(first);
  });
});

describe("ApiContext", () => {
  it("a fresh context gets its own services over the shared repos", () => {
    const a = new ApiContext({ db, log: getLogger() });
    const b = new ApiContext({ db, log: getLogger() });
    expect(a).not.toBe(b);
    expect(a.services.sessions).not.toBe(b.services.sessions);
    // ...but the database handle is the one shared instance.
    expect(a.db).toBe(b.db);
  });
});

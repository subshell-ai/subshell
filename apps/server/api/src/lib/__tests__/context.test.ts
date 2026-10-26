import { beforeAll, describe, expect, it } from "bun:test";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db } from "@/db/index.js";
import { ApiContext, getRequestlessContext } from "@/lib/context.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The requestless context is the entry point for non-request callers (ws,
 * mcp). Its identity and reset behavior belong here; HTTP and MCP tests
 * exercise the repository and service wiring through real operations.
 * The per-process temp-file test DB from test-preload applies automatically.
 */
// Parallel `bun test` gives this file its own fresh (unmigrated) database,
// so the tables arrive here by right, not by whoever imported first.
beforeAll(ensureMigratedTestDb);

describe("getRequestlessContext", () => {
  it("returns the same instance on every call", () => {
    expect(getRequestlessContext()).toBe(getRequestlessContext());
  });
});

describe("ApiContext", () => {
  it("a fresh context gets its own services over the shared repos", () => {
    const a = new ApiContext({ db, log: getLogger() });
    const b = new ApiContext({ db, log: getLogger() });
    expect(a).not.toBe(b);
    expect(a.services.subshells).not.toBe(b.services.subshells);
    // ...but the database handle is the one shared instance.
    expect(a.db).toBe(b.db);
  });
});

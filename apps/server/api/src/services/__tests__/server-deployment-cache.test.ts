import { beforeEach, describe, expect, it } from "bun:test";
import {
  collectDeployment,
  collectDeploymentCached,
  DEPLOYMENT_CACHE_MS,
  resetDeploymentCache,
} from "@/services/server-deployment.js";

/**
 * The polled read is memoized, and the reason is not politeness.
 *
 * `collectDeployment` runs `netstat -an -p tcp` and the service manager
 * through `Bun.spawnSync`. Bun is single-threaded, so each is a whole-process
 * stall — every terminal WebSocket frame and every other API request waits.
 * `GET /api/admin/server` is polled every 5 s by a page an admin leaves open,
 * with an unbounded tab count, so N tabs used to mean N dumps per interval,
 * paid by everyone else on the instance.
 */
describe("the deployment memo", () => {
  beforeEach(() => {
    resetDeploymentCache();
  });

  it("serves one collection to every caller inside the window", () => {
    const first = collectDeploymentCached();
    const second = collectDeploymentCached();
    // Identity, not equality: a second collection would produce an equal-ish
    // object with a different `generatedAt`, which is exactly the spawn this
    // exists to avoid.
    expect(second).toBe(first);
  });

  it("collects again once the window has passed", () => {
    const now = Date.now();
    const first = collectDeploymentCached(now);
    expect(collectDeploymentCached(now + DEPLOYMENT_CACHE_MS - 1)).toBe(first);
    expect(collectDeploymentCached(now + DEPLOYMENT_CACHE_MS + 1)).not.toBe(first);
  });

  it("is refreshed by the uncached call the writers use", () => {
    collectDeploymentCached();
    // A writer route returns `collectDeployment()` so its own response has no
    // staleness window. That call also refreshes the memo, which is what stops
    // the next poll from serving the PRE-write view — and means no writer has
    // to remember to invalidate anything.
    const afterWrite = collectDeployment();
    expect(collectDeploymentCached()).toBe(afterWrite);
  });

  it("neither reads nor writes the memo when deps are injected", () => {
    const mine = collectDeploymentCached();
    // Injected deps describe a DIFFERENT machine, so letting one populate this
    // process's memo would answer the next real poll with a fixture.
    collectDeployment({ platform: "linux", home: "/tmp/elsewhere" });
    expect(collectDeploymentCached()).toBe(mine);
  });
});

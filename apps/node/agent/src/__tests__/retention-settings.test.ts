import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type NodeConfig, saveConfig } from "../config.js";
import { readRetentionState, setLogRetention } from "../retention-settings.js";
import { newHome } from "../test-preload.js";

/**
 * The setter behind the loopback dashboard's retention block
 * (`retention-settings.ts`). These are the rules the route answers with
 * statuses, pinned here at the module the route delegates to:
 *
 * - a write lands in `config.json` (the plane owns nothing here — this is the
 *   machine's own file, and the same fields `loadConfig` reads);
 * - an env-forced field REFUSES the write naming the variable, while the
 *   un-forced half of the same window stays writable;
 * - validation is `retentionField`'s rule (non-negative integer, `0` real)
 *   raised to a refusal — a junk value is an explicit request, not a field to
 *   junk-drop to the default.
 */

function baseConfig(): NodeConfig {
  return {
    serverUrl: "http://plane.invalid",
    nodeId: "node-abc",
    nodeKey: "nk_test",
    controlPublicKey: "{}",
    dataDir: "/tmp/unused-by-this-module",
    name: "testbed",
  };
}

function stored(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.env.SUBSHELL_CONFIG_HOME as string, "config.json"), "utf8"));
}

beforeEach(() => {
  newHome();
});

describe("readRetentionState", () => {
  it("reads the layers a machine actually holds", async () => {
    await saveConfig({ ...baseConfig(), logRetentionDays: 14 });
    const s = await readRetentionState({});
    expect(s.days).toEqual({ value: 14, source: "stored", forced: false });
    expect(s.hours).toEqual({ value: 0, source: "default", forced: false });
    expect(s.forever).toBe(false);
  });

  it("a machine with no readable config still answers: the defaults", async () => {
    // No saveConfig — the config home is a fresh temp dir with nothing in it.
    const s = await readRetentionState({});
    expect(s.days.source).toBe("default");
    expect(s.forever).toBe(false);
  });
});

describe("setLogRetention", () => {
  it("persists a write and answers the new state", async () => {
    await saveConfig(baseConfig());
    const r = await setLogRetention({ days: 7, hours: 12 }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.state.days).toEqual({ value: 7, source: "stored", forced: false });
    expect(r.state.hours).toEqual({ value: 12, source: "stored", forced: false });
    expect(stored().logRetentionDays).toBe(7);
    expect(stored().logRetentionHours).toBe(12);
  });

  it("a half write keeps the other half", async () => {
    await saveConfig({ ...baseConfig(), logRetentionHours: 3 });
    const r = await setLogRetention({ days: 2 }, {});
    if (!r.ok) throw new Error(`expected ok, got ${r.message}`);
    expect(stored().logRetentionDays).toBe(2);
    expect(stored().logRetentionHours).toBe(3); // untouched
  });

  it("0 + 0 is a real write: the forever pair", async () => {
    await saveConfig({ ...baseConfig(), logRetentionDays: 1 });
    const r = await setLogRetention({ days: 0, hours: 0 }, {});
    if (!r.ok) throw new Error(`expected ok, got ${r.message}`);
    expect(r.state.forever).toBe(true);
    expect(stored().logRetentionDays).toBe(0);
    expect(stored().logRetentionHours).toBe(0);
  });

  it("refuses the field the environment forces, and only that field", async () => {
    await saveConfig(baseConfig());
    const env = { SUBSHELL_LOG_RETENTION_DAYS: "3" };
    const refused = await setLogRetention({ days: 9 }, env);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.status).toBe(409);
    expect(refused.message).toContain("SUBSHELL_LOG_RETENTION_DAYS");
    expect(stored().logRetentionDays).toBeUndefined(); // nothing was written

    // The hours half of the same window stays the machine's to set.
    const ok = await setLogRetention({ hours: 6 }, env);
    expect(ok.ok).toBe(true);
    expect(stored().logRetentionHours).toBe(6);
  });

  it("a combined write naming a forced field stores NOTHING", async () => {
    // A 200 that applied one half and silently dropped the other would be a
    // success report for a change that half-happened — the whole request is
    // refused, the operator retries the writable half alone.
    await saveConfig(baseConfig());
    const r = await setLogRetention({ days: 5, hours: 5 }, { SUBSHELL_LOG_RETENTION_HOURS: "2" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(409);
    expect(r.message).toContain("SUBSHELL_LOG_RETENTION_HOURS");
    expect(stored().logRetentionDays).toBeUndefined();
    expect(stored().logRetentionHours).toBeUndefined();
  });

  it("an unusable env spelling forces nothing", async () => {
    // `=many` is ignored by the resolution (a warn line, the next layer
    // answers), so a write to the answering layer is masked by nothing and
    // must be allowed — the debug-logging `=0` rule, same shape.
    await saveConfig(baseConfig());
    const r = await setLogRetention({ days: 4 }, { SUBSHELL_LOG_RETENTION_DAYS: "many" });
    expect(r.ok).toBe(true);
    expect(stored().logRetentionDays).toBe(4);
  });

  it("refuses values retentionField would junk", async () => {
    await saveConfig(baseConfig());
    for (const bad of [-1, 1.5, Number.NaN]) {
      const r = await setLogRetention({ days: bad }, {});
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.status).toBe(400);
      expect(r.message).toContain("days");
    }
    expect(stored().logRetentionDays).toBeUndefined();
  });

  it("a retention write cannot revert a field it does not name (round-3 finding 3)", async () => {
    // The node's twin of the fixed C7: retention and debug logging share this
    // file (which is also the node key's only home), and each save re-reads
    // through `updateConfig`, so the dashboard pair interleaves cleanly.
    await saveConfig({ ...baseConfig(), debugLogging: true });
    const r = await setLogRetention({ days: 6 }, {});
    expect(r.ok).toBe(true);
    expect(stored().logRetentionDays).toBe(6);
    expect(stored().debugLogging).toBe(true); // the debug flip survives the retention save
  });

  it("an empty write is a refusal, not a no-op success", async () => {
    await saveConfig(baseConfig());
    const r = await setLogRetention({}, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(400);
  });
});

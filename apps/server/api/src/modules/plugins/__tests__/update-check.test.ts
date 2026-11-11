import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { installLocalPlugin, uninstallLocalPlugin } from "@/modules/plugins/store.js";
import { clearPluginUpdateMemo, collectPluginUpdates } from "@/modules/plugins/update-check.js";
import { setupAuthTables } from "../../../testing/api/auth-tables.js";
import { type FakeRegistry, makePluginTgz, startFakeRegistry } from "../../../testing/nodes/fake-npm-registry.js";

/**
 * The instance's update check: which installed plugins have a newer version on
 * the configured registry, memoised for 15 minutes because every answer costs
 * one packument request per sidecar'd plugin.
 *
 * The rows are built from the EFFECTIVE version the report carries, so a
 * built-in whose registry copy lost to the bundle is judged by what runs —
 * that seam is covered in pane-runtime's own suite; here the plugin is a plain
 * third-party install.
 */

const reg: FakeRegistry = startFakeRegistry();
/** The one install this suite creates, and removes again. */
const ID = "upd-memo";
const NAME = "upd-memo";

describe("collectPluginUpdates", () => {
  beforeAll(async () => {
    await setupAuthTables();
    reg.served.set(NAME, {
      latest: "1.1.0",
      versions: {
        "1.0.0": makePluginTgz({ name: NAME, version: "1.0.0", id: ID }),
        "1.1.0": makePluginTgz({ name: NAME, version: "1.1.0", id: ID }),
      },
    });
    await installLocalPlugin(ID, `${NAME}@1.0.0`, reg.base);
  });

  // The memo is module state: a leaked entry would make the next case measure
  // the previous one's answer rather than the registry.
  beforeEach(() => {
    clearPluginUpdateMemo();
  });

  afterAll(async () => {
    clearPluginUpdateMemo();
    await uninstallLocalPlugin(ID);
    reg.stop();
  });

  it("memoizes for 15 minutes and force re-reads", async () => {
    const first = await collectPluginUpdates({ force: false, registryUrl: reg.base });
    expect(first.updates).toContainEqual({ id: ID, name: NAME, from: "1.0.0", to: "1.1.0" });
    // Per-id, not the whole list: the data dir is shared with every suite in
    // this run, and a foreign fixture's sidecar must not decide this case.
    expect(first.errors.find((e) => e.id === ID)).toBeUndefined();
    // Epoch milliseconds, not an ISO string: the page renders "checked 3 min ago".
    expect(typeof first.checkedAt).toBe("number");
    expect(first.checkedAt).toBeGreaterThan(0);

    // A second read inside the window costs NOTHING: no packument request.
    const hits = reg.hits.length;
    const second = await collectPluginUpdates({ force: false, registryUrl: reg.base });
    expect(reg.hits.length).toBe(hits);
    expect(second).toBe(first); // the memoised view, not a rebuild

    // "Re-check" is the same read with the memo dropped.
    await collectPluginUpdates({ force: true, registryUrl: reg.base });
    expect(reg.hits.length).toBeGreaterThan(hits);
  });

  it("a different registry URL is never served from the memo", async () => {
    // The memo's key is the registry as well as the clock: an operator who
    // points the instance at another mirror must get that mirror's answer.
    await collectPluginUpdates({ force: false, registryUrl: reg.base });
    const dead = await collectPluginUpdates({ force: false, registryUrl: "http://127.0.0.1:1" });
    expect(dead.updates).toEqual([]); // a registry that cannot be asked offers nothing
    expect(dead.errors.find((e) => e.id === ID)?.message).toContain("registry");
  });

  it("splits registry failures into errors", async () => {
    const view = await collectPluginUpdates({ force: true, registryUrl: "http://127.0.0.1:1" });
    expect(view.updates).toEqual([]);
    expect(view.errors[0]?.message).toContain("registry");
    expect(view.errors.find((e) => e.id === ID)).toMatchObject({ name: NAME });
    expect(typeof view.checkedAt).toBe("number");
  });
});

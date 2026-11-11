import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bundledPluginVersion, getHarness, listInstalled, readInstallRecord } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { pluginsRoutes, setPluginsRegistryUrlForTests } from "@/api/plugins.route.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { usableHarnessIds } from "@/modules/plugins/availability.js";
import { installLocalPlugin, localPluginReports, uninstallLocalPlugin } from "@/modules/plugins/store.js";
import { clearPluginUpdateMemo } from "@/modules/plugins/update-check.js";
import { type FakeRegistry, makePluginTgz, makeTgz, startFakeRegistry } from "@/testing/nodes/fake-npm-registry.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../testing/api/auth-tables.js";

/**
 * The instance-level plugins door (spec 2026-09-10 §6, §6.1).
 *
 * One plugin store for the whole instance, an `enabled` flag beside it, and
 * the five verbs the lifecycle needs. The gates are the load-bearing part:
 * LIST is open to every authenticated actor (any UI surface reads it),
 * every WRITE is cookie-admin only — a bearer key, even one owned by an
 * admin, is refused exactly like `system-keys.route.ts` refuses it, because
 * installing now runs third-party code ON the control plane (§8).
 *
 * Shared-state discipline: the plugin directory is per PROCESS (the same temp
 * data dir every suite in this run sees), so every case that changes what is
 * installed puts the host back in `afterAll`, exactly like
 * `local-plugins.test.ts` does.
 */

interface PluginRow {
  id: string;
  name: string;
  type: "agent-harness" | "terminal";
  description: string;
  installed: boolean;
  enabled: boolean;
  builtIn: boolean;
  version?: string;
  broken?: string;
  /** Mirror of PluginRowSchema: which copy answers, and the one it displaced. */
  source?: "build" | "npm" | "unrecorded";
  restartRequired?: boolean;
  shadowed?: { version: string; source: "build" | "npm" | "unrecorded"; error?: string };
  /** Mirror of PluginRowSchema: present only as false (the plugin's own word). */
  pickable?: false;
}
interface Impact {
  presets: number;
  distinctUsers: number;
  runningSubshells: number;
}

/** Mirror of the update-check schema: offers, failures, and when this answer was collected. */
interface UpdateView {
  updates: { id: string; name: string; from: string; to: string }[];
  errors: { id: string; name: string; message: string }[];
  checkedAt: number;
}

const app = new Elysia().use(errorHandlerPlugin).use(pluginsRoutes);
const reg: FakeRegistry = startFakeRegistry();

const presets = new PresetsRepository(db);
const subshells = new SubshellsRepository(db);

async function get(path: string, cookie: string): Promise<Response> {
  return await app.fetch(authedRequest(path, cookie));
}
async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return await app.fetch(
    authedRequest(path, cookie, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
}
async function bearerSend(method: string, path: string, key: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${key}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return await app.fetch(
    new Request(`http://localhost:3080${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function rowOf(list: PluginRow[], id: string): PluginRow | undefined {
  return list.find((p) => p.id === id);
}

/** The plugin-audit trail for one id, newest first (the route must not audit reads). */
async function pluginAudit(pluginId: string): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
  const events = await new AuditRepository(db).listLatest(300);
  return events
    .filter((e) => e.action.startsWith("plugin.") && e.targetId === pluginId)
    .map((e) => ({
      action: e.action,
      metadata: JSON.parse(String(e.metadataJson ?? "{}")) as Record<string, unknown>,
    }));
}

/** The update view as the caller sees it: the offer list the card renders. */
async function updatesView(cookie: string): Promise<UpdateView> {
  const res = await get("/api/plugins/updates", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as UpdateView;
}

/** The error body's message: the refusal wording these assertions need. */
async function errorMessage(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("message" in body)) return "";
  const { message } = body;
  return typeof message === "string" ? message : "";
}

/**
 * A plugin package whose manifest declares a plugin-api this host does not
 * implement. Built here rather than through `makePluginTgz`, which pins the
 * version it serves: the refusal an update must surface comes from the
 * manifest the package really declares.
 */
function incompatiblePluginTgz(opts: {
  name: string;
  version: string;
  id: string;
  apiVersion: number;
}): Uint8Array<ArrayBuffer> {
  return makeTgz([
    {
      path: "package/package.json",
      content: JSON.stringify({
        name: opts.name,
        version: opts.version,
        type: "module",
        subshell: {
          apiVersion: opts.apiVersion,
          id: opts.id,
          type: "agent-harness",
          name: "fixture",
          description: "fixture plugin",
          entry: "index.js",
        },
      }),
    },
    {
      path: "package/index.js",
      content: "export default function fixture() { return { capabilities: () => [] }; }\n",
    },
  ]);
}

describe("/api/plugins", () => {
  const pw = "plugins-route-1";
  const emails = {
    alice: `plg-alice-${crypto.randomUUID()}@subshell.local`,
    admin: `plg-admin-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId = "";
  let adminId = "";
  let aliceCookie = "";
  let adminCookie = "";
  let systemKey = "";
  let systemKeyId = "";

  /** What this suite may leave installed/removed; afterAll puts the host back. */
  let thirdInstalled = false;

  /** The updates section's fixture: `third` on disk at 1.0.0, with 1.1.0 offered. */
  async function ensureThirdInstalled(): Promise<void> {
    if (!(await localPluginReports()).some((r) => r.id === "third")) {
      await installLocalPlugin("third", "plg-third@1.0.0", reg.base);
    }
    thirdInstalled = true;
  }

  beforeAll(async () => {
    await setupAuthTables();
    // Point spec installs at the in-test registry (the production path
    // resolves SUBSHELL_PLUGIN_REGISTRY_URL; this seam is the same pattern
    // the setup route uses for its has-users probe).
    setPluginsRegistryUrlForTests(reg.base);
    // The registry spec installs fetch from. `third` loads cleanly (the
    // installer load-checks before swapping, so a broken fixture could never
    // install in the first place — the broken-row branch is reported-state
    // only, from an upgrade landing on a running load failure).
    reg.served.set("plg-third", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }) },
    });
    aliceId = await new UsersRepository(db).createUser({
      email: emails.alice,
      name: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    adminId = await new UsersRepository(db).createUser({
      email: emails.admin,
      name: emails.admin,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    aliceCookie = await signIn(emails.alice, pw);
    adminCookie = await signIn(emails.admin, pw);

    // A real system bearer key — the credential class that must read fine and
    // write never.
    const systemUserId = await ensureSystemUser();
    const created = (await getAuth().api.createApiKey({
      body: { name: "plg-route-system", userId: systemUserId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    systemKey = created.key;
    systemKeyId = created.id;
  });

  afterAll(async () => {
    setPluginsRegistryUrlForTests(null);
    reg.stop();
    if (thirdInstalled) await uninstallLocalPlugin("third").catch(() => {});
    // codex must be where the rest of the run expects it: installed.
    if (!(await localPluginReports()).some((r) => r.id === "codex")) {
      await installLocalPlugin("codex").catch(() => {});
    }
    await new PluginStateRepository(db).clear("claude-code").catch(() => {});
    await db.deleteFrom("presets").where("harnessId", "=", "third").execute();
    await db.deleteFrom("subshells").where("harnessId", "=", "third").execute();
    if (systemKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [systemKeyId]);
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
  });

  // ── reads: any authenticated actor ────────────────────────────────────────

  it("a non-admin can LIST; the row carries the identity the page renders", async () => {
    const res = await get("/api/plugins", aliceCookie);
    expect(res.status).toBe(200);
    const { plugins } = (await res.json()) as { plugins: PluginRow[] };
    const cc = rowOf(plugins, "claude-code");
    expect(cc).toBeDefined();
    expect(cc?.installed).toBe(true); // the process seeded the built-ins to the instance dir
    expect(cc?.enabled).toBe(true); // an absent row means enabled
    expect(cc?.builtIn).toBe(true);
    expect(cc?.name.length).toBeGreaterThan(0);
    // The web Agent picker's default rule ("terminal last") needs the type
    // from this one read: every built-in carries its manifest's value.
    expect(cc?.type).toBe("agent-harness");
    expect(rowOf(plugins, "terminal")?.type).toBe("terminal");
    // A seeded built-in's copy in use is this build's own, and nothing was
    // displaced — so the row claims `build` and names no shadow.
    expect(cc?.source).toBe("build");
    expect(cc?.shadowed).toBeUndefined();
  });

  it("the list merges the catalog: an embedded built-in missing from disk still appears, uninstalled", async () => {
    expect(await uninstallLocalPlugin("codex")).toBe(true);
    try {
      const { plugins } = (await (await get("/api/plugins", aliceCookie)).json()) as { plugins: PluginRow[] };
      const codex = rowOf(plugins, "codex");
      expect(codex).toBeDefined();
      expect(codex?.installed).toBe(false);
      expect(codex?.builtIn).toBe(true); // one click away — the page's catalog region
      // Nothing is installed, so there is no copy in use to describe: the row
      // claims no origin and names no shadow.
      expect(codex?.source).toBeUndefined();
      expect(codex?.shadowed).toBeUndefined();
    } finally {
      await installLocalPlugin("codex");
    }
  });

  it("serves a built-in's icon with the type its extension names, never sniffed", async () => {
    const res = await get("/api/plugins/claude-code/icon", aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The bytes are a third party's and this origin holds the session cookie,
    // so the document has to be inert for anyone who opens the URL directly.
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res.text()).toStartWith("<svg");
  });

  it("serves a PNG icon as bytes, not as mangled text", async () => {
    // hermes ships the one non-SVG mark, which is the whole reason the plugin
    // file map carries `Uint8Array` as well as `string`. Decoding it as UTF-8
    // anywhere on the path corrupts it silently, and the magic is what says so.
    const res = await get("/api/plugins/hermes/icon", aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves the icon of a built-in that is not on disk, from this build's own bytes", async () => {
    // The catalog lists uninstalled built-ins (the one-click region), so their
    // rows render before anything has been seeded or installed.
    expect(await uninstallLocalPlugin("codex")).toBe(true);
    try {
      const res = await get("/api/plugins/codex/icon", aliceCookie);
      expect(res.status).toBe(200);
      expect(await res.text()).toStartWith("<svg");
    } finally {
      await installLocalPlugin("codex");
    }
  });

  it("serves a network plugin's icon", async () => {
    // The icon path is resolved from the manifest, and network plugins live
    // in their own registry list — so a lookup that only asked `getHarness`
    // answered `undefined` here, 404'd, and left the row on its monogram.
    const res = await get("/api/plugins/tailscale/icon", aliceCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    // Trimmed: Tailscale's own favicon file begins with a newline, and these
    // are the vendor's bytes served verbatim — the route exists to change
    // nothing about them, and the assertion says the same.
    expect((await res.text()).trimStart()).toStartWith("<svg");
  });

  it("an id this instance does not know is a 404, and a traversal attempt is the same 404", async () => {
    expect((await get("/api/plugins/not-a-plugin/icon", aliceCookie)).status).toBe(404);
    expect((await get("/api/plugins/..%2f..%2fetc/icon", aliceCookie)).status).toBe(404);
  });

  it("a system bearer key may LIST", async () => {
    expect((await bearerSend("GET", "/api/plugins", systemKey)).status).toBe(200);
  });

  // ── writes: cookie-admin only ─────────────────────────────────────────────

  it("install/disable/uninstall/impact all 403 for a non-admin cookie — and nothing moved", async () => {
    expect((await send("POST", "/api/plugins", aliceCookie, { pluginId: "codex" })).status).toBe(403);
    expect((await send("PATCH", "/api/plugins/codex", aliceCookie, { enabled: false })).status).toBe(403);
    expect((await send("DELETE", "/api/plugins/codex", aliceCookie)).status).toBe(403);
    expect((await get("/api/plugins/codex/impact", aliceCookie)).status).toBe(403);
    // The revert-proof of the gate: the 403 fired before the store did.
    const { plugins } = (await (await get("/api/plugins", aliceCookie)).json()) as { plugins: PluginRow[] };
    expect(rowOf(plugins, "codex")?.installed).toBe(true);
    expect(rowOf(plugins, "codex")?.enabled).toBe(true);
  });

  it("every write 403s for a bearer key, even a system key owned by an admin", async () => {
    // requireAdmin's cookie rule: machine credentials cannot manage the
    // instance (spec §8 — installing now runs code ON the control plane).
    expect((await bearerSend("POST", "/api/plugins", systemKey, { pluginId: "codex" })).status).toBe(403);
    expect((await bearerSend("PATCH", "/api/plugins/codex", systemKey, { enabled: false })).status).toBe(403);
    expect((await bearerSend("DELETE", "/api/plugins/codex", systemKey)).status).toBe(403);
    expect((await bearerSend("GET", "/api/plugins/codex/impact", systemKey)).status).toBe(403);
  });

  it("install-by-embedded-id works for an admin and is audited with its source", async () => {
    expect(await uninstallLocalPlugin("codex")).toBe(true);
    try {
      const res = await send("POST", "/api/plugins", adminCookie, { pluginId: "codex" });
      expect(res.status).toBe(200);
      const row = (await res.json()) as PluginRow;
      expect(row).toMatchObject({ id: "codex", installed: true, enabled: true });
      expect((await listInstalled(SUBSHELL_SERVER_DATA_DIR)).map((p) => p.id)).toContain("codex");

      const audits = await pluginAudit("codex");
      expect(audits.find((a) => a.action === "plugin.install")?.metadata).toMatchObject({
        pluginId: "codex",
        source: "embedded",
      });
    } finally {
      if ((await localPluginReports()).some((r) => r.id === "codex")) await uninstallLocalPlugin("codex");
      await installLocalPlugin("codex");
    }
  });

  it("an id this build does not carry, with no spec, is a 400 that names it", async () => {
    const res = await send("POST", "/api/plugins", adminCookie, { pluginId: "nope-not-carried" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("nope-not-carried");
  });

  it("a malformed spec is a 400 naming it, before any bytes are fetched", async () => {
    const res = await send("POST", "/api/plugins", adminCookie, { pluginId: "whatever", spec: "bad@^1" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("^1");
    expect((await localPluginReports()).find((r) => r.id === "whatever")).toBeUndefined();
  });

  it("install-by-spec fetches from the registry and audits the package it came from", async () => {
    const res = await send("POST", "/api/plugins", adminCookie, { pluginId: "third", spec: "plg-third@1.0.0" });
    expect(res.status).toBe(200);
    const row = (await res.json()) as PluginRow;
    expect(row.installed).toBe(true);
    // Task 9b's install-side proof: the install route refreshed the registry
    // overlay, so the plugin RESOLVES the moment the response lands. It is
    // still NOT a built-in — the one-click catalog question survives the
    // overlay exactly because `toRow` asks the compiled set, not `getHarness`.
    expect(getHarness("third")).toBeDefined();
    expect(row.builtIn).toBe(false);
    // The bytes came from a registry, not this build: the row says which copy
    // answers, and the shadow is silent because no built-in was displaced.
    expect(row.source).toBe("npm");
    expect(row.shadowed).toBeUndefined();
    thirdInstalled = true;

    expect((await listInstalled(SUBSHELL_SERVER_DATA_DIR)).map((p) => p.id)).toContain("third");
    expect((await pluginAudit("third")).find((a) => a.action === "plugin.install")?.metadata).toMatchObject({
      pluginId: "third",
      source: "registry",
      spec: "plg-third@1.0.0",
    });
    // Install writes NO preset rows (spec 2026-09-13): the Default seeding is
    // gone, and a presetless launch of the new harness works the moment the
    // overlay lands — which the assertions above just proved.
    expect(await presets.listByHarness("third")).toEqual([]);
  });

  // ── update detection: cookie-admin, and memoised against the registry ─────

  it("GET /api/plugins/updates names the offer, and a second GET spends no registry request", async () => {
    // `third` was installed from the registry above; publish a newer release of
    // its package so the offer is real, and judge it by the copy IN USE — the
    // report's version, which is what the resolver is handed.
    reg.served.set("plg-third", {
      latest: "1.1.0",
      versions: {
        "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }),
        "1.1.0": makePluginTgz({ name: "plg-third", version: "1.1.0", id: "third" }),
      },
    });
    await ensureThirdInstalled();
    clearPluginUpdateMemo();
    try {
      const res = await get("/api/plugins/updates", adminCookie);
      expect(res.status).toBe(200);
      const view = (await res.json()) as UpdateView;
      expect(view.updates.find((u) => u.id === "third")).toEqual({
        id: "third",
        name: "plg-third",
        from: "1.0.0",
        to: "1.1.0",
      });
      // Per-id: the plugins dir is shared with every suite in this run.
      expect(view.errors.find((e) => e.id === "third")).toBeUndefined();
      // Epoch milliseconds: the page renders "checked N min ago".
      expect(typeof view.checkedAt).toBe("number");

      const hits = reg.hits.length;
      const again = await get("/api/plugins/updates", adminCookie);
      expect(again.status).toBe(200);
      expect(((await again.json()) as UpdateView).updates).toContainEqual(view.updates.find((u) => u.id === "third"));
      expect(reg.hits.length).toBe(hits); // the memo answers; the registry is not asked again
    } finally {
      clearPluginUpdateMemo();
      reg.served.set("plg-third", {
        latest: "1.0.0",
        versions: { "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }) },
      });
    }
  });

  it("POST /api/plugins/updates/check drops the memo and reads the registry again", async () => {
    reg.served.set("plg-third", {
      latest: "1.1.0",
      versions: {
        "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }),
        "1.1.0": makePluginTgz({ name: "plg-third", version: "1.1.0", id: "third" }),
      },
    });
    await ensureThirdInstalled();
    clearPluginUpdateMemo();
    try {
      // A GET first, so the POST is measured against a populated memo.
      expect((await get("/api/plugins/updates", adminCookie)).status).toBe(200);
      const hits = reg.hits.length;
      const res = await send("POST", "/api/plugins/updates/check", adminCookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as UpdateView).updates.find((u) => u.id === "third")?.to).toBe("1.1.0");
      expect(reg.hits.length).toBeGreaterThan(hits);
    } finally {
      clearPluginUpdateMemo();
      reg.served.set("plg-third", {
        latest: "1.0.0",
        versions: { "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }) },
      });
    }
  });

  it("a registry that cannot be asked lands in errors, never in updates", async () => {
    await ensureThirdInstalled();
    // The seam every spec install uses: the check reads the same configured URL.
    setPluginsRegistryUrlForTests("http://127.0.0.1:1");
    clearPluginUpdateMemo();
    try {
      const res = await get("/api/plugins/updates", adminCookie);
      expect(res.status).toBe(200);
      const view = (await res.json()) as UpdateView;
      expect(view.updates).toEqual([]);
      expect(view.errors.find((e) => e.id === "third")).toMatchObject({ name: "plg-third" });
      expect(view.errors[0]?.message).toContain("registry");
    } finally {
      setPluginsRegistryUrlForTests(reg.base);
      clearPluginUpdateMemo();
    }
  });

  it("both update reads refuse a non-admin cookie and a bearer key", async () => {
    expect((await get("/api/plugins/updates", aliceCookie)).status).toBe(403);
    expect((await send("POST", "/api/plugins/updates/check", aliceCookie)).status).toBe(403);
    expect((await bearerSend("GET", "/api/plugins/updates", systemKey)).status).toBe(403);
    expect((await bearerSend("POST", "/api/plugins/updates/check", systemKey)).status).toBe(403);
    // The gate fired before the store: nothing about the host changed.
    expect((await localPluginReports()).find((r) => r.id === "third")).toBeDefined();
  });

  it("a registry copy of a built-in older than the bundle loses: the bundle answers and the shadow is named", async () => {
    // An OLDER copy of the built-in's own package, installed from a registry.
    // The id-claim guard admits it because the package name matches the copy
    // already claiming `pi`; a differently-named package claiming that id is
    // refused instead. The bundle is newer, so the compiled copy answers while
    // the npm copy sits on disk — which is exactly what the row must say.
    const bundled = await bundledPluginVersion("pi");
    if (!bundled) throw new Error("this build must carry pi");
    reg.served.set("@subshell-ai/plugin-pi", {
      latest: "0.0.1",
      versions: { "0.0.1": makePluginTgz({ name: "@subshell-ai/plugin-pi", version: "0.0.1", id: "pi" }) },
    });
    try {
      const res = await send("POST", "/api/plugins", adminCookie, {
        pluginId: "pi",
        spec: "@subshell-ai/plugin-pi@0.0.1",
      });
      expect(res.status).toBe(200);
      const row = (await res.json()) as PluginRow;
      // The EFFECTIVE version, not the one on disk: the bundle's.
      expect(row.version).toBe(bundled);
      expect(row.source).toBe("build");
      expect(row.shadowed).toEqual({ version: "0.0.1", source: "npm" });
      expect(row.restartRequired).toBeUndefined();
    } finally {
      // pi is a seeded built-in the rest of the run expects: put this build's
      // copy back (a fresh install carries no sidecar), which is also the
      // state that silences the shadow.
      await installLocalPlugin("pi");
      reg.served.delete("@subshell-ai/plugin-pi");
    }
  });

  // ── the update act: installs the registry's latest, and says so ───────────

  /** Serve `plg-third` 1.0.0 → 1.1.0 and make sure the store holds 1.0.0. */
  async function serveThirdUpdate(): Promise<void> {
    reg.served.set("plg-third", {
      latest: "1.1.0",
      versions: {
        "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }),
        "1.1.0": makePluginTgz({ name: "plg-third", version: "1.1.0", id: "third" }),
      },
    });
    await installLocalPlugin("third", "plg-third@1.0.0", reg.base);
    thirdInstalled = true;
    clearPluginUpdateMemo();
  }

  /** Put the shared fixture back: third at 1.0.0, its registry offering nothing newer. */
  async function restoreThird(): Promise<void> {
    clearPluginUpdateMemo();
    reg.served.set("plg-third", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }) },
    });
    await installLocalPlugin("third", "plg-third@1.0.0", reg.base).catch(() => {});
  }

  it("updates a registry-installed plugin to latest, drops the offer, and audits the package", async () => {
    await serveThirdUpdate();
    try {
      // The offer is real before the act, so the memo is what the act has to
      // invalidate: a cached answer would keep offering 1.1.0 after the move.
      expect((await updatesView(adminCookie)).updates.find((u) => u.id === "third")?.to).toBe("1.1.0");

      const res = await send("POST", "/api/plugins/third/update", adminCookie);
      expect(res.status).toBe(200);
      const row = (await res.json()) as PluginRow;
      expect(row).toMatchObject({ id: "third", version: "1.1.0", source: "npm", builtIn: false });
      expect(await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third")).toMatchObject({
        name: "plg-third",
        version: "1.1.0",
      });
      // The package says which bytes moved; the version pair is what makes the
      // line reconstructible later.
      expect((await pluginAudit("third")).find((a) => a.action === "plugin.update")?.metadata).toMatchObject({
        pluginId: "third",
        package: "plg-third",
        from: "1.0.0",
        to: "1.1.0",
      });
      // The store moved, so the memo went with it.
      const after = await updatesView(adminCookie);
      expect(after.updates.find((u) => u.id === "third")).toBeUndefined();
      expect(after.errors.find((e) => e.id === "third")).toBeUndefined();
    } finally {
      await restoreThird();
    }
  });

  it("refuses a plugin whose copy came from this build, and says where its update lives", async () => {
    // Embedded bytes carry no sidecar, so there is no package to re-resolve —
    // whatever npm copy sat here before, this id's copy is now the build's.
    await installLocalPlugin("codex");
    const res = await send("POST", "/api/plugins/codex/update", adminCookie);
    expect(res.status).toBe(409);
    expect(await errorMessage(res)).toContain("this build");
  });

  it("refuses when latest is not newer than the copy in use, naming the version", async () => {
    reg.served.set("plg-third", {
      latest: "1.1.0",
      versions: { "1.1.0": makePluginTgz({ name: "plg-third", version: "1.1.0", id: "third" }) },
    });
    await installLocalPlugin("third", "plg-third@1.1.0", reg.base);
    thirdInstalled = true;
    clearPluginUpdateMemo();
    const before = await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third");
    try {
      const res = await send("POST", "/api/plugins/third/update", adminCookie);
      expect(res.status).toBe(409);
      const message = await errorMessage(res);
      expect(message).toContain("already");
      expect(message).toContain("1.1.0");
      // Nothing moved: a refusal before the install leaves the sidecar as it
      // was, installedAt included.
      expect(await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third")).toEqual(before);
    } finally {
      await restoreThird();
    }
  });

  it("refuses a package that needs a newer plugin-api than this host implements", async () => {
    await serveThirdUpdate();
    const before = await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third");
    // A newer `latest` whose manifest speaks a plugin-api this binary does not:
    // the offer is real, and the install door is what refuses it.
    reg.served.set("plg-third", {
      latest: "2.0.0",
      versions: {
        "1.0.0": makePluginTgz({ name: "plg-third", version: "1.0.0", id: "third" }),
        "2.0.0": incompatiblePluginTgz({ name: "plg-third", version: "2.0.0", id: "third", apiVersion: 99 }),
      },
    });
    clearPluginUpdateMemo();
    try {
      const res = await send("POST", "/api/plugins/third/update", adminCookie);
      expect(res.status).toBe(409);
      expect(await errorMessage(res)).toContain("plugin-api");
      expect(await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third")).toEqual(before);
    } finally {
      await restoreThird();
    }
  });

  it("refuses when the registry cannot be asked, and leaves the installed copy alone", async () => {
    await serveThirdUpdate();
    const before = await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third");
    // The seam every spec install uses: a dead port answers nothing.
    setPluginsRegistryUrlForTests("http://127.0.0.1:1");
    clearPluginUpdateMemo();
    try {
      const res = await send("POST", "/api/plugins/third/update", adminCookie);
      expect(res.status).toBe(409);
      expect(await errorMessage(res)).toContain("registry");
      expect(await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third")).toEqual(before);
    } finally {
      setPluginsRegistryUrlForTests(reg.base);
      await restoreThird();
    }
  });

  it("the update act is cookie-admin only, and a malformed id is a 400", async () => {
    await serveThirdUpdate();
    try {
      const before = await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third");
      expect((await send("POST", "/api/plugins/third/update", aliceCookie)).status).toBe(403);
      expect((await bearerSend("POST", "/api/plugins/third/update", systemKey)).status).toBe(403);
      // The gate fired before the store did.
      expect(await readInstallRecord(SUBSHELL_SERVER_DATA_DIR, "third")).toEqual(before);
      const traversing = encodeURIComponent("../../etc/passwd");
      expect((await send("POST", `/api/plugins/${traversing}/update`, adminCookie)).status).toBe(400);
    } finally {
      await restoreThird();
    }
  });

  it("an install and an uninstall each drop the cached offer", async () => {
    await serveThirdUpdate();
    try {
      // Install side: the memo offers 1.1.0, then the install writes exactly
      // that version — a cached check would keep offering it after the move.
      expect((await updatesView(adminCookie)).updates.find((u) => u.id === "third")?.to).toBe("1.1.0");
      expect(
        (await send("POST", "/api/plugins", adminCookie, { pluginId: "third", spec: "plg-third@1.1.0" })).status,
      ).toBe(200);
      const afterInstall = await updatesView(adminCookie);
      expect(afterInstall.updates.find((u) => u.id === "third")).toBeUndefined();
      expect(afterInstall.errors.find((e) => e.id === "third")).toBeUndefined();

      // Uninstall side: put 1.0.0 back, prime the offer again, then remove the
      // bytes — the sidecar's offer must not survive them.
      expect(
        (await send("POST", "/api/plugins", adminCookie, { pluginId: "third", spec: "plg-third@1.0.0" })).status,
      ).toBe(200);
      expect((await updatesView(adminCookie)).updates.find((u) => u.id === "third")?.to).toBe("1.1.0");
      expect((await send("DELETE", "/api/plugins/third", adminCookie)).status).toBe(200);
      const afterUninstall = await updatesView(adminCookie);
      expect(afterUninstall.updates.find((u) => u.id === "third")).toBeUndefined();
      expect(afterUninstall.errors.find((e) => e.id === "third")).toBeUndefined();
    } finally {
      await restoreThird();
    }
  });

  // ── the enable flag: computed availability, rows never touched ────────────

  it("disabling removes the harness from usableHarnessIds; re-enabling restores it with rows untouched", async () => {
    // Pin claude-code's binary probe so the test measures the FLAG, not
    // whatever happens to sit on this machine's PATH.
    const plugin = getHarness("claude-code");
    if (!plugin) throw new Error("claude-code built-in must exist");
    const origDetect = plugin.detect.bind(plugin);
    const origVersionAt = plugin.versionAt.bind(plugin);
    plugin.detect = async () => ({ path: "/usr/bin/claude" });
    plugin.versionAt = async () => "test";
    try {
      expect((await usableHarnessIds()).has("claude-code")).toBe(true);

      // A row the toggle must never touch.
      const row = await presets.create({
        id: crypto.randomUUID(),
        userId: aliceId,
        harnessId: "claude-code",
        name: `toggle-${crypto.randomUUID().slice(0, 8)}`,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
      });
      const before = (await presets.listByHarness("claude-code")).map((p) => p.id).sort();

      const off = await send("PATCH", "/api/plugins/claude-code", adminCookie, { enabled: false });
      expect(off.status).toBe(200);
      expect(((await off.json()) as PluginRow).enabled).toBe(false);
      expect((await usableHarnessIds()).has("claude-code")).toBe(false);
      // Still LISTED as installed — the flag is not an uninstall.
      const listed = (await (await get("/api/plugins", aliceCookie)).json()) as { plugins: PluginRow[] };
      expect(rowOf(listed.plugins, "claude-code")).toMatchObject({ installed: true, enabled: false });

      const on = await send("PATCH", "/api/plugins/claude-code", adminCookie, { enabled: true });
      expect(((await on.json()) as PluginRow).enabled).toBe(true);
      expect((await usableHarnessIds()).has("claude-code")).toBe(true);
      const after = (await presets.listByHarness("claude-code")).map((p) => p.id).sort();
      expect(after).toEqual(before); // every row survived both flips, untouched
      expect(after).toContain(row.id);

      // The two real flips were audited.
      const actions = (await pluginAudit("claude-code")).map((a) => a.action);
      expect(actions).toContain("plugin.disable");
      expect(actions).toContain("plugin.enable");
      await presets.delete(row.id);
    } finally {
      plugin.detect = origDetect;
      plugin.versionAt = origVersionAt;
      await new PluginStateRepository(db).clear("claude-code");
    }
  });

  it("PATCH on an id the instance has not installed is a 404", async () => {
    const res = await send("PATCH", "/api/plugins/definitely-not-installed", adminCookie, { enabled: false });
    expect(res.status).toBe(404);
  });

  // ── impact + uninstall modes ──────────────────────────────────────────────

  it("impact counts presets, DISTINCT OWNERS (the dialog's 'across N users'), and RUNNING subshells", async () => {
    // Deterministic table with a deliberately ASYMMETRIC owner split: the
    // caller owns TWO rows and alice one. That distinguishes the number the
    // dialog asks for — DISTINCT OWNERS including the caller (2) — from the
    // count impact used to carry (presets owned by others, here 1). A fixture
    // where both compute the same number cannot regress between the two
    // semantics.
    await presets.deleteByHarness("third");
    await db.deleteFrom("subshells").where("harnessId", "=", "third").execute();
    const mk = (userId: string, name: string) =>
      presets.create({
        id: crypto.randomUUID(),
        userId,
        harnessId: "third",
        name,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
      });
    await mk(adminId, "admin-regular");
    await mk(adminId, "admin-second");
    await mk(aliceId, "alice-regular");
    const mkSub = async (name: string, running: boolean) => {
      const id = crypto.randomUUID();
      await subshells.create({
        id,
        userId: aliceId,
        presetId: "p",
        harnessId: "third",
        name,
        workingDir: "/tmp",
        tmuxSocket: null,
      });
      if (!running) await subshells.markTerminated(id, new Date().toISOString());
      return id;
    };
    await mkSub("third-running", true);
    await mkSub("third-terminated", false);

    const res = await get("/api/plugins/third/impact", adminCookie);
    expect(res.status).toBe(200);
    const impact = (await res.json()) as Impact;
    expect(impact).toEqual({ presets: 3, distinctUsers: 2, runningSubshells: 1 });
  });

  it("uninstall?mode=keep removes the bytes and leaves every preset row standing; running subshells survive", async () => {
    // Disable first, so the state row exists and the uninstall's cleanup of it
    // is observable rather than an assertion about a row that was never there.
    expect((await send("PATCH", "/api/plugins/third", adminCookie, { enabled: false })).status).toBe(200);
    const before = (await presets.listByHarness("third")).map((p) => p.id).sort();
    const runningBefore = (await subshells.listRunning()).map((s) => s.id).sort();

    const res = await send("DELETE", "/api/plugins/third?mode=keep", adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string; presetsRemoved: number };
    expect(body).toMatchObject({ ok: true, mode: "keep", presetsRemoved: 0 });

    expect((await localPluginReports()).find((r) => r.id === "third")).toBeUndefined();
    // The uninstall-side proof of the same seam: resolution follows the store,
    // so the launch path can no longer reach what the store no longer holds.
    expect(getHarness("third")).toBeUndefined();
    const after = (await presets.listByHarness("third")).map((p) => p.id).sort();
    expect(after).toEqual(before); // rows untouched — availability is computed, not stored
    expect((await subshells.listRunning()).map((s) => s.id).sort()).toEqual(runningBefore);

    expect((await pluginAudit("third"))[0]).toMatchObject({
      action: "plugin.uninstall",
      metadata: { pluginId: "third", mode: "keep", presetsRemoved: 0 },
    });
    // The state row is gone with the install: a later reinstall starts enabled,
    // because "installing writes nothing, the default is on" only means
    // something when the absent row follows an uninstall.
    expect((await new PluginStateRepository(db).stateByPluginId()).has("third")).toBe(false);
  });

  it("the default mode is keep", async () => {
    expect(
      (await send("POST", "/api/plugins", adminCookie, { pluginId: "third", spec: "plg-third@1.0.0" })).status,
    ).toBe(200);
    const before = (await presets.listByHarness("third")).length;
    const res = await send("DELETE", "/api/plugins/third", adminCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe("keep");
    expect((await presets.listByHarness("third")).length).toBe(before);
  });

  it("mode=delete sweeps presets across EVERY user; a running subshell survives, presetless", async () => {
    expect(
      (await send("POST", "/api/plugins", adminCookie, { pluginId: "third", spec: "plg-third@1.0.0" })).status,
    ).toBe(200);
    // Deterministic again: exactly admin-regular, alice-regular,
    // alice-second, plus one running subshell whose `preset_id` the sweep must
    // NULL rather than dangle (spec 2026-09-13 §6).
    await presets.deleteByHarness("third");
    const mk = (userId: string, name: string) =>
      presets.create({
        id: crypto.randomUUID(),
        userId,
        harnessId: "third",
        name,
        description: null,
        envJson: null,
        flagsJson: null,
        settingsJson: null,
        configIsolation: 0,
      });
    const adminRegular = await mk(adminId, "admin-regular");
    const aliceRegular = await mk(aliceId, "alice-regular");
    const aliceSecond = await mk(aliceId, "alice-second");
    await db.deleteFrom("subshells").where("harnessId", "=", "third").execute();
    const runnerId = crypto.randomUUID();
    await subshells.create({
      id: runnerId,
      userId: aliceId,
      presetId: adminRegular.id,
      harnessId: "third",
      name: "third-running",
      workingDir: "/tmp",
      tmuxSocket: null,
    });

    const res = await send("DELETE", "/api/plugins/third?mode=delete", adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mode: string; presetsRemoved: number };
    expect(body.mode).toBe("delete");
    expect(body.presetsRemoved).toBe(3);

    expect(await presets.listByHarness("third")).toEqual([]);
    expect(await presets.findById(adminRegular.id)).toBeUndefined();
    expect(await presets.findById(aliceRegular.id)).toBeUndefined();
    expect(await presets.findById(aliceSecond.id)).toBeUndefined();
    // And the subshell that was RUNNING is still running — presetless.
    const still = (await subshells.listRunning()).filter((s) => s.harnessId === "third");
    expect(still.length).toBe(1);
    expect(still[0]?.name).toBe("third-running");
    expect(still[0]?.presetId).toBeNull();

    expect((await pluginAudit("third"))[0]?.metadata).toMatchObject({ mode: "delete", presetsRemoved: 3 });
    for (const s of still) await subshells.delete(s.id);
  });

  it("an unknown mode is a 400", async () => {
    expect((await send("DELETE", "/api/plugins/third?mode=purge", adminCookie)).status).toBe(400);
  });

  it("a malformed plugin id in the path is a 400, not a 500 from the installer", async () => {
    const res = await send("DELETE", `/api/plugins/${encodeURIComponent("../../etc/passwd")}`, adminCookie);
    expect(res.status).toBe(400);
  });

  it("uninstalling something already absent answers the state the caller asked for, and audits nothing", async () => {
    const before = (await pluginAudit("third")).filter((a) => a.action === "plugin.uninstall").length;
    const res = await send("DELETE", "/api/plugins/third?mode=keep", adminCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const after = (await pluginAudit("third")).filter((a) => a.action === "plugin.uninstall").length;
    expect(after).toBe(before); // no audit line for a change that did not happen
  });
});

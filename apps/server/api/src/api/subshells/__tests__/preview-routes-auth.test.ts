import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { DEFAULT_PREVIEW_CONFIGURATION } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { holdConnection, resetNodeRegistryForTests } from "@/modules/nodes/node-registry.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { getPreviewBroker, resetForTests, shutdownPreviewBrokerForTests } from "@/modules/previews/preview-broker.js";
import { issueSubshellToken } from "@/modules/subshells/tokens.js";
import {
  attachScriptedNode,
  ok,
  type ScriptedHandlers,
  type ScriptedNode,
  statDirEcho,
} from "@/testing/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/**
 * The Task 9 authz matrix and shape contract for the preview REST surface:
 * `GET /api/subshells/:id/views`, `POST /:id/views/open`,
 * `POST /:id/views/browser/watch`, `DELETE /:id/views/browser/watch`, and the create
 * path's gated `screen` field.
 *
 * The spine is the actor table, cloned from the ssh route suites: `view`
 * reads and watches, `edit` also forwards, a stranger sees only 404s, and
 * the pane's own subshell key resolves as its OWNER with shares off (docs/
 * security.md §4), so it acts on its own rows and cannot discover foreign
 * ones. Node keys 401 on REST (§5.5), a system key is nowhere without a
 * deliberate grant and lands wherever one points (§3), and a scoped key
 * without the route's annotation permission is refused at the annotation
 * with the NAMED-permission branch.
 *
 * The shape rows pin spec §6's truthfulness rules: an unreachable node
 * answers the same shape with `nodeEnabled: false` and a reason rather than
 * an error; a switch-on non-Linux node answers `nodeEnabled: true` with the
 * ports refusal NAMED (a blank list with no reason reads as "nothing is
 * listening"); a display that died mid-pane passes `screenLost` through
 * named beside `screen: null` (spec §9); and a terminated pane short-circuits
 * ROUTE-side without any RPC leaving the plane.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

const nodeId = `pvnode-${crypto.randomUUID().slice(0, 8)}`;

/** The pane's node, live by default; each test overrides what it answers. */
function liveHandlers(overrides: ScriptedHandlers = {}): ScriptedHandlers {
  return {
    stat_dir: statDirEcho,
    launch: ok,
    preview_open: (cmd) => (cmd.type === "preview_open" ? { ref: cmd.ref, subscribers: 1 } : new Error("wrong cmd")),
    preview_close: ok,
    preview_ports_get: () => ({
      ports: [{ proto: "tcp", port: 3000, pid: 4242, title: "Project dashboard" }],
      cdpPort: 9222,
      screen: null,
    }),
    ...overrides,
  };
}

let sim: ScriptedNode;

function attachLive(overrides: ScriptedHandlers = {}) {
  sim?.detach();
  sim = attachScriptedNode(nodeId, liveHandlers(overrides));
  return sim;
}

/** Call a preview door (or any subshell path) with one actor's credential. */
async function call(
  method: string,
  path: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return app.fetch(
    new Request(`http://localhost:3080/api/subshells${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  );
}

const errorBody = async (res: Response) => (await res.json()) as { code: string; message: string };
const jsonBody = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** The four preview doors, so the actor table reads as a table. */
const DOORS = [
  {
    label: "settings",
    method: "POST",
    path: (id: string) => `/${id}/views/settings`,
    body: { target: { port: 3000 }, action: "read" },
  },
  { label: "info", method: "GET", path: (id: string) => `/${id}/views` },
  { label: "open", method: "POST", path: (id: string) => `/${id}/views/open`, body: { port: 3000 } },
  { label: "watch", method: "POST", path: (id: string) => `/${id}/views/browser/watch`, body: { port: 9222 } },
  { label: "watch stop", method: "DELETE", path: (id: string) => `/${id}/views/browser/watch` },
] as const;

describe("preview REST surface (Task 9)", () => {
  const pw = "preview-pass-1";
  const ownerEmail = `pv-owner-${crypto.randomUUID()}@subshell.local`;
  const viewerEmail = `pv-viewer-${crypto.randomUUID()}@subshell.local`;
  const editorEmail = `pv-editor-${crypto.randomUUID()}@subshell.local`;
  const foreignEmail = `pv-foreign-${crypto.randomUUID()}@subshell.local`;
  let ownerId: string;
  let ownerCookie: string;
  let viewerId: string;
  let viewerCookie: string;
  let editorId: string;
  let editorCookie: string;
  let foreignId: string;
  let foreignCookie: string;
  let systemUserId: string;
  const createdSubshellIds: string[] = [];
  const createdKeyIds: string[] = [];

  /** A RUNNING row written straight to the table. */
  async function directRow(
    overrides: { userId?: string; status?: "running" | "terminated"; name?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await subshells.create({
      id,
      userId: overrides.userId ?? ownerId,
      presetId: null,
      harnessId: "terminal",
      name: overrides.name ?? `pv ${id.slice(0, 4)}`,
      workingDir: "/tmp",
      tmuxSocket: `pv-sock-${id}`,
      nodeId,
      status: overrides.status ?? "running",
      alive: overrides.status === "terminated" ? 0 : 1,
      ssh: null,
    });
    return id;
  }

  async function grantPane(paneId: string, granteeUserId: string, permission: "view" | "edit"): Promise<void> {
    await shares.replaceForSubshell(paneId, [{ granteeUserId, permission }], ownerId);
  }

  async function bearerFor(paneId: string): Promise<string> {
    const token = await issueSubshellToken(paneId, ownerId);
    const row = await subshells.findById(paneId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);
    return token;
  }

  async function paneCount(userId: string): Promise<number> {
    const r = await db
      .selectFrom("subshells")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("userId", "=", userId)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  /**
   * ENABLED api keys owned by `id`. Revocation disables the row rather than
   * deleting it (`revokeSubshellToken` -> `setApiKeyEnabled(…, false)`), so a
   * rolled-back create must not change this count even though its key row
   * still exists, disabled.
   */
  function liveKeyCount(userId: string): number {
    const row = authDatabase()
      .prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM apikey WHERE "referenceId" = ? AND enabled = 1`)
      .get(userId);
    return Number(row?.n ?? 0);
  }

  /** The create-path rollback leaves the row terminated, not deleted: read its status. */
  async function paneStatusByName(userId: string, name: string): Promise<string | undefined> {
    const r = await db
      .selectFrom("subshells")
      .select("status")
      .where("userId", "=", userId)
      .where("name", "=", name)
      .executeTakeFirst();
    return r?.status;
  }

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    const mk = async (email: string): Promise<[string, string]> => {
      const id = await users.createUser({
        email,
        name: email,
        passwordHash: await hashPassword(pw),
        role: "user",
      });
      return [id, await signIn(email, pw)];
    };
    [ownerId, ownerCookie] = await mk(ownerEmail);
    [viewerId, viewerCookie] = await mk(viewerEmail);
    [editorId, editorCookie] = await mk(editorEmail);
    [foreignId, foreignCookie] = await mk(foreignEmail);
    systemUserId = await ensureSystemUser();
    await nodes.create({ id: nodeId, ownerUserId: ownerId, name: "Preview Node", kind: "agent" });
    await nodes.setPreviewEnabled(nodeId, { on: true, changedAt: new Date().toISOString() });
    await nodes.setPreviewEnabled(nodeId, {
      on: true,
      feature: "display",
      provider: "xvfb-x11vnc",
      providers: ["xvfb-x11vnc"],
      changedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    sim?.detach();
    shutdownPreviewBrokerForTests();
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await subshells.delete(id).catch(() => {});
    for (const kid of createdKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const email of [ownerEmail, viewerEmail, editorEmail, foreignEmail]) {
      await deleteUserByEmailOrId(email).catch(() => {});
    }
    await nodes.deleteById(nodeId).catch(() => {});
  });

  beforeEach(async () => {
    // A fresh registry keeps a held connection from one row bleeding into the
    // next; a fresh broker (production seams, so the real RPC reaches the
    // scripted node) keeps lanes and watches from doing the same.
    resetNodeRegistryForTests();
    resetForTests();
    await nodes.setPreviewEnabled(nodeId, { on: true, changedAt: new Date().toISOString() });
    await nodes.setPreviewEnabled(nodeId, {
      on: true,
      feature: "display",
      provider: "xvfb-x11vnc",
      providers: ["xvfb-x11vnc"],
      changedAt: new Date().toISOString(),
    });
  });

  /* ---------------------------------------------------------------- */
  /* the actor table                                                  */
  /* ---------------------------------------------------------------- */

  it("saves external services without a display, deduplicates, scopes IDs, and revokes on removal", async () => {
    attachLive();
    const pane = await directRow();
    const other = await directRow();
    const input = { host: "EXAMPLE.COM", port: 443, protocol: "https", name: "Docs" };
    const saved = await call("POST", `/${pane}/services`, { cookie: ownerCookie, body: input });
    expect(saved.status).toBe(200);
    const service = (await saved.json()) as { id: string; host: string; ignoreCertificateErrors: boolean };
    expect(service.host).toBe("example.com");
    expect(service.ignoreCertificateErrors).toBe(false);
    const duplicate = await call("POST", `/${pane}/services`, { cookie: ownerCookie, body: input });
    expect(((await duplicate.json()) as { id: string }).id).toBe(service.id);
    expect(
      (
        await call("POST", `/${pane}/services`, {
          cookie: ownerCookie,
          body: { ...input, name: "Different name" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", `/${pane}/views/open`, {
          cookie: ownerCookie,
          body: { serviceId: service.id, expectedPort: 444 },
        })
      ).status,
    ).toBe(409);
    const list = await call("GET", `/${pane}/services`, { cookie: ownerCookie });
    expect(((await list.json()) as { id: string }[]).map((row) => row.id)).toEqual([service.id]);
    expect(
      (await call("POST", `/${other}/views/open`, { cookie: ownerCookie, body: { serviceId: service.id } })).status,
    ).toBe(404);
    const opened = await call("POST", `/${pane}/views/open`, { cookie: ownerCookie, body: { serviceId: service.id } });
    expect(opened.status).toBe(200);
    const { proxyBase } = (await opened.json()) as { proxyBase: string };
    const ref = proxyBase.split("/")[2];
    expect(getPreviewBroker().sessionFor(ref)?.service).toEqual({ host: "example.com", protocol: "https" });
    expect(getPreviewBroker().sessionFor(ref)?.mode).toBe("http");
    expect((await call("DELETE", `/${pane}/services/${service.id}`, { cookie: ownerCookie })).status).toBe(200);
    expect(getPreviewBroker().sessionFor(ref)).toBeNull();
    expect(
      (await call("POST", `/${pane}/views/open`, { cookie: ownerCookie, body: { serviceId: service.id } })).status,
    ).toBe(404);
    expect(await call("GET", `/${pane}/services`, { cookie: ownerCookie }).then((r) => r.json())).toEqual([]);
  });

  it("persists a service's explicit TLS opt-out and passes it to its preview lanes", async () => {
    attachLive();
    const pane = await directRow();
    const body = { host: "localhost", port: 8006, protocol: "https", ignoreCertificateErrors: true };
    const saved = await call("POST", `/${pane}/services`, { cookie: ownerCookie, body });
    expect(saved.status).toBe(200);
    const service = (await saved.json()) as { id: string; ignoreCertificateErrors: boolean };
    expect(service.ignoreCertificateErrors).toBe(true);
    const listed = await call("GET", `/${pane}/services`, { cookie: ownerCookie });
    expect(((await listed.json()) as { ignoreCertificateErrors: boolean }[])[0].ignoreCertificateErrors).toBe(true);
    const opened = await call("POST", `/${pane}/views/open`, { cookie: ownerCookie, body: { serviceId: service.id } });
    expect(opened.status).toBe(200);
    const { proxyBase } = (await opened.json()) as { proxyBase: string };
    expect(getPreviewBroker().sessionFor(proxyBase.split("/")[2])?.service).toEqual({
      host: "localhost",
      protocol: "https",
      ignoreCertificateErrors: true,
    });
    expect(
      (
        await call("POST", `/${pane}/services`, {
          cookie: ownerCookie,
          body: { ...body, ignoreCertificateErrors: false },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("POST", `/${pane}/services`, { cookie: ownerCookie, body: { ...body, protocol: "http" } })).status,
    ).toBe(400);
    await call("DELETE", `/${pane}/services/${service.id}`, { cookie: ownerCookie });
  });

  it("updates saved configuration in place, revokes old views, and requires an explicit browser sandbox choice", async () => {
    attachLive();
    const pane = await directRow();
    const configuration = {
      ...DEFAULT_PREVIEW_CONFIGURATION,
      protocol: "https",
      ignoreCertificateErrors: true,
      sandbox: false,
      rewriteUrls: false,
    };
    const input = {
      name: "Proxmox",
      host: "localhost",
      port: 8006,
      protocol: "https",
      ignoreCertificateErrors: true,
      configuration,
    };
    const saved = await call("POST", `/${pane}/services`, { cookie: ownerCookie, body: input });
    expect(saved.status).toBe(200);
    const service = (await saved.json()) as { id: string };
    const opened = await call("POST", `/${pane}/views/open`, { cookie: ownerCookie, body: { serviceId: service.id } });
    const first = (await opened.json()) as { proxyBase: string; sandbox: boolean };
    expect(first.sandbox).toBe(true);
    const token = await bearerFor(pane);
    expect(
      (await call("POST", `/${pane}/views/open`, { bearer: token, body: { serviceId: service.id, configuration } }))
        .status,
    ).toBe(403);
    const outside = await call("POST", `/${pane}/views/open`, {
      cookie: ownerCookie,
      body: { serviceId: service.id, configuration, expectedPort: 8006, expectedRevision: 0 },
    });
    expect(((await outside.json()) as { sandbox: boolean }).sandbox).toBe(false);
    await grantPane(pane, viewerId, "view");
    const changed = {
      ...input,
      expectedRevision: 0,
      name: "Updated",
      port: 8007,
      configuration: { ...configuration, rewriteUrls: true },
    };
    expect((await call("PUT", `/${pane}/services/${service.id}`, { cookie: viewerCookie, body: changed })).status).toBe(
      403,
    );
    const updated = await call("PUT", `/${pane}/services/${service.id}`, { cookie: ownerCookie, body: changed });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: service.id,
      name: "Updated",
      port: 8007,
      configuration: changed.configuration,
    });
    expect(getPreviewBroker().sessionFor(first.proxyBase.split("/")[2])).toBeNull();
    expect((await call("PUT", `/${pane}/services/${service.id}`, { cookie: ownerCookie, body: changed })).status).toBe(
      409,
    );
    expect(
      (
        await call("POST", `/${pane}/views/open`, {
          cookie: ownerCookie,
          body: { serviceId: service.id, configuration, expectedPort: 8006, expectedRevision: 0 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", `/${pane}/views/open`, {
          cookie: ownerCookie,
          body: { serviceId: service.id, configuration },
        })
      ).status,
    ).toBe(409);
    const override = await call("POST", `/${pane}/views/open`, {
      cookie: ownerCookie,
      body: {
        serviceId: service.id,
        configuration: { ...configuration, sandbox: true, passHost: true },
        expectedRevision: 1,
      },
    });
    expect(override.status).toBe(200);
    const overrideResult = (await override.json()) as { proxyBase: string };
    expect(getPreviewBroker().sessionFor(overrideResult.proxyBase.split("/")[2])?.proxySettings?.passHost).toBe(true);

    const listed = await call("GET", `/${pane}/services`, { cookie: ownerCookie });
    expect(((await listed.json()) as unknown[]).length).toBe(1);
  });

  it("opens an unsaved HTTPS configuration without creating a saved service", async () => {
    attachLive();
    const pane = await directRow();
    const configuration = {
      ...DEFAULT_PREVIEW_CONFIGURATION,
      protocol: "https",
      ignoreCertificateErrors: true,
      passHost: true,
    };
    const opened = await call("POST", `/${pane}/views/open`, {
      cookie: ownerCookie,
      body: { port: 8006, configuration },
    });
    expect(opened.status).toBe(200);
    const result = (await opened.json()) as { proxyBase: string };
    const session = getPreviewBroker().sessionFor(result.proxyBase.split("/")[2]);
    expect(session?.service).toEqual({ host: "localhost", protocol: "https", ignoreCertificateErrors: true });
    expect(session?.proxySettings?.passHost).toBe(true);
    expect(await call("GET", `/${pane}/services`, { cookie: ownerCookie }).then((r) => r.json())).toEqual([]);
  });

  it("requires edit for saved service mutations, hides foreign services, and rejects URL hosts", async () => {
    const pane = await directRow();
    await grantPane(pane, viewerId, "view");
    const body = { port: 3000, protocol: "http" };
    expect((await call("GET", `/${pane}/services`, { cookie: viewerCookie })).status).toBe(200);
    expect((await call("POST", `/${pane}/services`, { cookie: viewerCookie, body })).status).toBe(403);
    expect((await call("DELETE", `/${pane}/services/missing`, { cookie: viewerCookie })).status).toBe(403);
    expect((await call("GET", `/${pane}/services`, { cookie: foreignCookie })).status).toBe(404);
    expect(
      (await call("POST", `/${pane}/services`, { cookie: ownerCookie, body: { ...body, host: "http://example.com" } }))
        .status,
    ).toBe(400);
    const saved = await call("POST", `/${pane}/services`, { cookie: ownerCookie, body });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { host: string }).host).toBe("localhost");
  });

  it("saves personal target settings across subshells, snapshots opens, and resets", async () => {
    attachLive();
    const pane = await directRow();
    const other = await directRow();
    await grantPane(pane, editorId, "edit");
    const settings = { rewriteUrls: false, passHost: true, rewriteRedirects: false };
    const settingsCall = (id: string, action: string, cookie = ownerCookie, target: unknown = { port: 3000 }) =>
      call("POST", `/${id}/views/settings`, { cookie, body: { target, action, settings } });
    expect((await settingsCall(pane, "save")).status).toBe(200);
    expect(await (await settingsCall(other, "read")).json()).toEqual(settings);
    expect(await (await settingsCall(pane, "read", editorCookie)).json()).toEqual({
      rewriteUrls: true,
      passHost: false,
      rewriteRedirects: true,
    });
    expect(await (await settingsCall(other, "read", ownerCookie, { port: 3001 })).json()).toEqual({
      rewriteUrls: true,
      passHost: false,
      rewriteRedirects: true,
    });
    const opened = await call("POST", `/${other}/views/open`, { cookie: ownerCookie, body: { port: 3000 } });
    const { proxyBase } = (await opened.json()) as { proxyBase: string };
    expect(getPreviewBroker().sessionFor(proxyBase.split("/")[2] ?? "")?.proxySettings).toEqual(settings);
    expect((await settingsCall(other, "reset")).status).toBe(200);
    expect(await (await settingsCall(pane, "read")).json()).toEqual({
      rewriteUrls: true,
      passHost: false,
      rewriteRedirects: true,
    });
    expect(getPreviewBroker().sessionFor(proxyBase.split("/")[2] ?? "")?.proxySettings).toEqual(settings);
  });

  it("uses saved service targets without granting access or crossing protocols", async () => {
    attachLive();
    const pane = await directRow();
    const saveService = async (protocol: "http" | "https", host: string) => {
      const response = await call("POST", `/${pane}/services`, {
        cookie: ownerCookie,
        body: { name: protocol, port: 4443, host, protocol },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { id: string };
    };
    const first = await saveService("http", "LOCALHOST");
    const second = await saveService("https", "localhost");
    const settings = { rewriteUrls: false, passHost: true, rewriteRedirects: false };
    const save = await call("POST", `/${pane}/views/settings`, {
      cookie: ownerCookie,
      body: { target: { serviceId: first.id }, action: "save", settings },
    });
    expect(save.status).toBe(200);
    const read = await call("POST", `/${pane}/views/settings`, {
      cookie: ownerCookie,
      body: { target: { serviceId: second.id }, action: "read" },
    });
    expect(await read.json()).toEqual({ rewriteUrls: true, passHost: false, rewriteRedirects: true });
    expect(
      (
        await call("POST", `/${pane}/views/settings`, {
          cookie: foreignCookie,
          body: { target: { serviceId: first.id }, action: "read" },
        })
      ).status,
    ).toBe(404);
    await call("POST", `/${pane}/views/settings`, {
      cookie: ownerCookie,
      body: { target: { serviceId: first.id }, action: "reset" },
    });
  });

  it("caps saved targets per user while allowing updates and resets", async () => {
    attachLive();
    const pane = await directRow();
    await db.deleteFrom("previewProxySettings").where("userId", "=", ownerId).execute();
    await db
      .insertInto("previewProxySettings")
      .values(
        Array.from({ length: 256 }, (_, i) => ({
          userId: ownerId,
          nodeId,
          host: "localhost",
          protocol: "http",
          port: 10000 + i,
          rewriteUrls: 1,
          passHost: 0,
          rewriteRedirects: 1,
        })),
      )
      .execute();
    const settings = { rewriteUrls: false, passHost: true, rewriteRedirects: false };
    const change = (port: number, action: string) =>
      call("POST", `/${pane}/views/settings`, { cookie: ownerCookie, body: { target: { port }, action, settings } });
    expect((await change(3000, "save")).status).toBe(409);
    expect((await change(10000, "save")).status).toBe(200);
    expect((await change(10000, "reset")).status).toBe(200);
    expect((await change(3000, "save")).status).toBe(200);
    await db.deleteFrom("previewProxySettings").where("userId", "=", ownerId).execute();
  });

  it("settings cannot bypass edit access or the node preview switch", async () => {
    attachLive();
    const pane = await directRow();
    await grantPane(pane, viewerId, "view");
    for (const action of ["read", "save", "reset"]) {
      const body = {
        target: { port: 3000 },
        action,
        settings: { rewriteUrls: true, passHost: false, rewriteRedirects: true },
      };
      expect((await call("POST", `/${pane}/views/settings`, { cookie: viewerCookie, body })).status).toBe(403);
      expect((await call("POST", `/${pane}/views/settings`, { cookie: foreignCookie, body })).status).toBe(404);
    }
    await nodes.setPreviewEnabled(nodeId, { on: false, changedAt: new Date().toISOString() });
    // Display-only nodes still own preview preferences for their screen port.
    expect(
      (
        await call("POST", `/${pane}/views/settings`, {
          cookie: ownerCookie,
          body: { target: { port: 5900 }, action: "read" },
        })
      ).status,
    ).toBe(200);
    await nodes.setPreviewEnabled(nodeId, { feature: "display", on: false, changedAt: new Date().toISOString() });
    expect(
      (
        await call("POST", `/${pane}/views/settings`, {
          cookie: ownerCookie,
          body: { target: { port: 3000 }, action: "read" },
        })
      ).status,
    ).toBe(409);
  });

  it("the owner reaches all four doors", async () => {
    attachLive();
    const pane = await directRow();
    for (const door of DOORS) {
      const res = await call(door.method, door.path(pane), {
        cookie: ownerCookie,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(200);
    }
  });

  it("an edit grantee reaches all four doors too", async () => {
    attachLive();
    const pane = await directRow();
    await grantPane(pane, editorId, "edit");
    for (const door of DOORS) {
      const res = await call(door.method, door.path(pane), {
        cookie: editorCookie,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(200);
    }
  });

  it("a view grantee reads and watches, and is 403 refused the forward", async () => {
    attachLive();
    const pane = await directRow();
    await grantPane(pane, viewerId, "view");
    for (const door of DOORS) {
      const res = await call(door.method, door.path(pane), {
        cookie: viewerCookie,
        ...("body" in door ? { body: door.body } : {}),
      });
      // Forwarding a raw lane is `edit`; info and the watch doors are reads.
      expect(res.status).toBe(door.label === "open" || door.label === "settings" ? 403 : 200);
    }
  });

  it("refuses a view grantee's attempt to watch another port on the node", async () => {
    attachLive();
    const pane = await directRow();
    await grantPane(pane, viewerId, "view");
    const res = await call("POST", `/${pane}/views/browser/watch`, { cookie: viewerCookie, body: { port: 9333 } });
    expect(res.status).toBe(403);
    expect((await errorBody(res)).message).toContain("browser discovered in this subshell");
  });

  it("refuses an arbitrary watch port when edit access becomes view while opening", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    attachLive({
      preview_open: async (cmd) => {
        entered();
        await gate;
        return cmd.type === "preview_open" ? { ref: cmd.ref, subscribers: 1 } : {};
      },
    });
    const pane = await directRow();
    await grantPane(pane, editorId, "edit");
    const pending = call("POST", `/${pane}/views/browser/watch`, { cookie: editorCookie, body: { port: 9333 } });
    await started;
    await grantPane(pane, editorId, "view");
    await getPreviewBroker().closeUnauthorizedForPane(pane);
    release();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(getPreviewBroker().sessionForPane(pane)).toBeNull();
  });

  it("a foreign account sees 404 on all four doors, never a 403", async () => {
    attachLive();
    const pane = await directRow();
    for (const door of DOORS) {
      const res = await call(door.method, door.path(pane), {
        cookie: foreignCookie,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(404);
    }
  });

  it("a pane's own key acts as its owner, shares off, on both sides (§4)", async () => {
    attachLive();
    // docs/security.md §4: raw REST resolves a pane's own subshell token as
    // its OWNER with boost and shares OFF. Both halves matter: the owner's
    // own rows must answer 200 (that is the sibling-action door the posture
    // ACCEPTS), and a foreign row must answer 404 (the token sees no shares,
    // so what it cannot own simply is not there).
    const own = await directRow();
    const token = await bearerFor(own);
    const other = await directRow(); // still the owner's pane, reached as its owner
    for (const door of DOORS) {
      const res = await call(door.method, door.path(other), {
        bearer: token,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(200);
    }
    // The foreign half: a stranger's pane is invisible to the token.
    const foreignPane = await directRow({ userId: foreignId });
    for (const door of DOORS) {
      const res = await call(door.method, door.path(foreignPane), {
        bearer: token,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(404);
    }
  });

  it("a node key 401s on REST with the explicit node-key message (§5.5)", async () => {
    attachLive();
    const pane = await directRow();
    const created = (await getAuth().api.createApiKey({
      body: { name: "pv-node-key", userId: ownerId, metadata: { kind: "node", nodeId } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    // Pinned against the auth-guard-bearer.test.ts:167 precedent: the REST
    // guard is a 401 surface for node keys, never a 403 that leaks a route.
    const res = await call("GET", `/${pane}/views`, { bearer: created.key });
    expect(res.status).toBe(401);
    const body = await errorBody(res);
    expect(body.code).toBe(BackendErrorCodes.INVALID_CREDENTIALS);
    expect(body.message).toMatch(/node keys/i);
  });

  it("a system key is nowhere ungranted, and a deliberate grant reaches it (§3)", async () => {
    attachLive();
    const pane = await directRow();
    // A legacy unversioned system key carries `systemKeyPermissions ===
    // null`, which passes the scoped-key annotation gate untouched (that is
    // why the pane-visibility rows carry the weight); the gate that refuses
    // it is the ordinary access resolver: the system user owns nothing and
    // holds no grant, so every door answers 404.
    const sysKey = (await getAuth().api.createApiKey({
      body: { name: "pv-system", userId: systemUserId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(sysKey.id);
    for (const door of DOORS) {
      const res = await call(door.method, door.path(pane), {
        bearer: sysKey.key,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(404);
    }
    // The positive half (docs/security.md §3): a deliberate grant to the
    // system user DOES reach it. `edit` so all four doors answer.
    await grantPane(pane, systemUserId, "edit");
    for (const door of DOORS) {
      const res = await call(door.method, door.path(pane), {
        bearer: sysKey.key,
        ...("body" in door ? { body: door.body } : {}),
      });
      expect(res.status).toBe(200);
    }
  });

  it("a scoped key lacking the route's permission is refused at the annotation, by name", async () => {
    attachLive();
    const pane = await directRow();
    // Versioned and scoped: the guard's NAMED-permission branch fires
    // (auth-guard.ts: "This API key needs the ${requiredSystemPermission}
    // permission."), not the legacy "isn't available" wording, because every
    // preview route carries a permission annotation like its siblings.
    const scoped = (await getAuth().api.createApiKey({
      body: {
        name: "pv-scoped",
        userId: systemUserId,
        metadata: { kind: "system", permissionVersion: 1, systemPermissions: ["channels:read"] },
      },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(scoped.id);
    const read = await call("GET", `/${pane}/views`, { bearer: scoped.key });
    expect(read.status).toBe(403);
    expect((await errorBody(read)).message).toMatch(/needs the subshells:read permission/);
    const exec = await call("POST", `/${pane}/views/open`, { bearer: scoped.key, body: { port: 3000 } });
    expect(exec.status).toBe(403);
    expect((await errorBody(exec)).message).toMatch(/needs the subshells:execute permission/);
    // And with the permission it reaches, proving the branch was the gate.
    const granted = (await getAuth().api.createApiKey({
      body: {
        name: "pv-scoped-ok",
        userId: systemUserId,
        metadata: { kind: "system", permissionVersion: 1, systemPermissions: ["subshells:read", "subshells:execute"] },
      },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(granted.id);
    await grantPane(pane, systemUserId, "edit");
    const seen = await call("GET", `/${pane}/views`, { bearer: granted.key });
    expect(seen.status).toBe(200);
  });

  /* ---------------------------------------------------------------- */
  /* the info shape                                                   */
  /* ---------------------------------------------------------------- */

  it("a healthy live pane answers the full shape", async () => {
    attachLive();
    const pane = await directRow();
    const res = await call("GET", `/${pane}/views`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodeEnabled).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.ports).toEqual([{ proto: "tcp", port: 3000, pid: 4242, title: "Project dashboard" }]);
    expect(body.cdpPort).toBe(9222);
    expect(body.screen).toBeNull();
    expect(body.screenLost).toBeUndefined();
  });

  it("an unreachable node answers the same shape, nodeEnabled false, never an error", async () => {
    attachLive();
    const pane = await directRow();
    sim.detach(); // the link is gone; the row still says running
    const res = await call("GET", `/${pane}/views`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodeEnabled).toBe(false);
    expect(body.reason).toBe("node-offline");
    expect(body.ports).toEqual([]);
    expect(body.cdpPort).toBeNull();
    expect(body.screen).toBeNull();
  });

  it("a held node names the hold, and below-floor names age", async () => {
    const holder = attachLive();
    const pane = await directRow();
    const held = holdConnection(nodeId, holder.conn, {
      reason: "protocol-mismatch",
      agentVersion: "0.0.1",
      protocolVersion: 1,
      os: "linux",
      arch: "x64",
      onIdle: () => {},
    });
    expect(held).toBeDefined();
    let body = await jsonBody(await call("GET", `/${pane}/views`, { cookie: ownerCookie }));
    expect(body.nodeEnabled).toBe(false);
    expect(body.reason).toBe("node-held");
    // Swap the held record for the too-old gate: same door, different truth.
    resetNodeRegistryForTests();
    const s2 = attachScriptedNode(nodeId, liveHandlers());
    sim = s2;
    holdConnection(nodeId, s2.conn, {
      reason: "below-floor",
      agentVersion: "0.1.0",
      protocolVersion: 14,
      os: "linux",
      arch: "x64",
      onIdle: () => {},
    });
    body = await jsonBody(await call("GET", `/${pane}/views`, { cookie: ownerCookie }));
    expect(body.nodeEnabled).toBe(false);
    expect(body.reason).toBe("node-too-old");
  });

  it("a switch-off node answers a reason and sends no RPC", async () => {
    const node = attachLive();
    const pane = await directRow();
    await nodes.setPreviewEnabled(nodeId, { on: false, changedAt: new Date().toISOString() });
    await nodes.setPreviewEnabled(nodeId, { on: false, feature: "display", changedAt: new Date().toISOString() });
    const res = await call("GET", `/${pane}/views`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodeEnabled).toBe(false);
    expect(body.reason).toBe("preview-disabled");
    expect(body.ports).toEqual([]);
    expect(node.countOf("preview_ports_get")).toBe(0);
  });

  it("an online, switch-on, non-Linux node names preview-ports-unsupported with nodeEnabled TRUE", async () => {
    // The mac leg of Task 14 reads exactly this: nodeEnabled describes the
    // NODE (online, switch on), and the refusal the node itself names rides
    // in `reason`. A blank [] with no reason would read as "nothing is
    // listening" and lie about why.
    attachLive({
      preview_ports_get: () => new Error("preview-ports-unsupported"),
    });
    const pane = await directRow();
    const res = await call("GET", `/${pane}/views`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodeEnabled).toBe(true);
    expect(body.reason).toBe("preview-ports-unsupported");
    expect(body.ports).toEqual([]);
    expect(body.cdpPort).toBeNull();
    expect(body.screen).toBeNull();
  });

  it("an agent that predates the ports command answers the mac-leg shape, nodeEnabled TRUE", async () => {
    // A plane-side `unsupported` (the connected agent predates
    // preview_ports_get, so there is no `detail` to pass through) means
    // exactly what the detail-bearing refusal means: the node is online and
    // switched on, it just cannot scan. Same branch, same reason word. The
    // seam throws the plane's own verdict because nothing older than the
    // command vocabulary exists to script.
    attachLive();
    const pane = await directRow();
    resetForTests({
      send: async () => {
        throw new NodeRpcError("unsupported", `node "${nodeId}" does not support preview_ports_get`, nodeId);
      },
    });
    const res = await call("GET", `/${pane}/views`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.nodeEnabled).toBe(true);
    expect(body.reason).toBe("preview-ports-unsupported");
    expect(body.ports).toEqual([]);
    expect(body.cdpPort).toBeNull();
    expect(body.screen).toBeNull();
  });

  it("a node failure the plane cannot name still answers the composed node-refused reason", async () => {
    // `failed` with no detail sits outside every named branch, so the
    // composed `node-refused (failed)` is what a polling page reads. It is
    // now DOCUMENTED in the schema description, which is what this row
    // pins: the composition stays honest, and a named-word refactor that
    // starts swallowing detail would flip this row red.
    attachLive();
    const pane = await directRow();
    resetForTests({
      send: async () => {
        throw new NodeRpcError("failed", `node "${nodeId}" reported: something the wire did not name`, nodeId);
      },
    });
    const body = await jsonBody(await call("GET", `/${pane}/views`, { cookie: ownerCookie }));
    expect(body.nodeEnabled).toBe(false);
    expect(body.reason).toBe("node-refused (failed)");
    expect(body.ports).toEqual([]);
  });

  it("a display that died mid-pane passes screenLost named, paired with screen null", async () => {
    // Spec §9: the marker arrives from the node and passes through named,
    // never inferred. A route that swallowed it would render silence where
    // the pane should say "the screen went away".
    attachLive({
      preview_ports_get: () => ({
        ports: [{ proto: "tcp6", port: 8080, pid: 91 }],
        cdpPort: null,
        screen: null,
        screenLost: "x11vnc",
      }),
    });
    const pane = await directRow();
    const body = await jsonBody(await call("GET", `/${pane}/views`, { cookie: ownerCookie }));
    expect(body.screen).toBeNull();
    expect(body.screenLost).toBe("x11vnc");
    expect(body.ports).toEqual([{ proto: "tcp6", port: 8080, pid: 91 }]);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("enforces apps %s and display %s independently for discovery and new connections", async (apps, display) => {
    attachLive({
      preview_ports_get: () => ({
        ports: [{ proto: "tcp", port: 3000, pid: 91 }],
        cdpPort: 9222,
        screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } },
      }),
    });
    const pane = await directRow();
    await nodes.setPreviewEnabled(nodeId, { on: apps, changedAt: new Date().toISOString() });
    await nodes.setPreviewEnabled(nodeId, { on: display, feature: "display", changedAt: new Date().toISOString() });
    const bearer = await bearerFor(pane);
    for (const auth of [{ cookie: ownerCookie }, { bearer }]) {
      const info = await jsonBody(await call("GET", `/${pane}/views`, auth));
      expect(info.webPreviewsEnabled).toBe(apps);
      expect(info.virtualDisplayEnabled).toBe(display);
      expect(info.ports).toEqual(apps ? [{ proto: "tcp", port: 3000, pid: 91 }] : []);
      expect(info.cdpPort).toBe(apps ? 9222 : null);
      expect(info.screen).toEqual(display ? { display: ":90", viewer: { protocol: "vnc", port: 5910 } } : null);
      for (const [port, permitted] of [
        [3000, apps],
        [5910, display],
      ] as const) {
        const response = await call("POST", `/${pane}/views/open`, { ...auth, body: { port } });
        expect(response.status).toBe(permitted ? 200 : 409);
      }
      const watch = await call("POST", `/${pane}/views/browser/watch`, { ...auth, body: { port: 9222 } });
      expect(watch.status).toBe(apps ? 200 : 409);
    }
  });

  it("a live display passes the screen pair through", async () => {
    attachLive({
      preview_ports_get: () => ({
        ports: [],
        cdpPort: null,
        screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } },
      }),
    });
    const pane = await directRow();
    const body = await jsonBody(await call("GET", `/${pane}/views`, { cookie: ownerCookie }));
    expect(body.screen).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
    expect(body.screenLost).toBeUndefined();
  });

  it("a terminated pane answers the empty shape with no RPC leaving the plane", async () => {
    // The route-side short-circuit: a pane that is simply gone is not a
    // preview failure. Applying the refusal-mapping rule here would answer
    // `nodeEnabled: false` naming a ports refusal for a row that cannot
    // answer anything, and no `screenLost`: a closed pane has no display
    // that could die. The broker's spy (the wire) must stay untouched.
    const node = attachLive();
    const pane = await directRow({ status: "terminated" });
    const res = await call("GET", `/${pane}/views`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ports).toEqual([]);
    expect(body.cdpPort).toBeNull();
    expect(body.screen).toBeNull();
    expect(body.screenLost).toBeUndefined();
    // nodeEnabled/reason still describe the NODE (online, switch on).
    expect(body.nodeEnabled).toBe(true);
    expect(node.countOf("preview_ports_get")).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /* open and watch                                                   */
  /* ---------------------------------------------------------------- */

  it("open hands out a proxyBase for the ref it minted", async () => {
    const node = attachLive();
    const pane = await directRow();
    const res = await call("POST", `/${pane}/views/open`, { cookie: ownerCookie, body: { port: 3000 } });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.proxyBase).toMatch(/^\/pv\/[0-9a-f]{32}\/$/);
    const opens = node.cmdsOf("preview_open");
    expect(opens.length).toBeGreaterThan(0);
    expect(opens[0].paneId).toBe(pane);
    expect(opens[0].port).toBe(3000);
  });

  // The string case names a string that cannot READ as a number: Elysia's
  // schema layer coerces a numeric string ("3000") like every other numeric
  // surface on this app, and an honest bound check says so rather than
  // pretending a port of "3000" arrives.
  it.each([
    ["zero", 0],
    ["above the port range", 70000],
    ["a fraction", 1.5],
    ["a string that is not a number", "not-a-port"],
    ["missing entirely", undefined],
  ])("open refuses port %s at the schema", async (_label, port) => {
    const node = attachLive();
    const pane = await directRow();
    const res = await call("POST", `/${pane}/views/open`, {
      cookie: ownerCookie,
      body: port === undefined ? {} : { port },
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe(BackendErrorCodes.INPUT_VALIDATION_ERROR);
    expect(node.countOf("preview_open")).toBe(0);
  });

  it("watch with no body defaults to the cached cdpPort, and stop is idempotent", async () => {
    const node = attachLive();
    const pane = await directRow();
    const start = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: {} });
    expect(start.status).toBe(200);
    expect(await jsonBody(start)).toEqual({ ok: true });
    const opens = node.cmdsOf("preview_open");
    expect(opens.length).toBe(1);
    expect(opens[0].kind).toBe("screencast");
    expect(opens[0].port).toBe(9222); // the ports answer's cdpPort
    const stop = await call("DELETE", `/${pane}/views/browser/watch`, { cookie: ownerCookie });
    expect(stop.status).toBe(200);
    expect(await jsonBody(stop)).toEqual({ ok: true });
    // The caller unsubscribed; a second stop is a no-op, not a 404 hunt.
    const stop2 = await call("DELETE", `/${pane}/views/browser/watch`, { cookie: ownerCookie });
    expect(stop2.status).toBe(200);
    expect(node.countOf("preview_close")).toBeGreaterThanOrEqual(1);
  });

  it("watch with no port and no cached cdpPort is a 400 that names what is missing", async () => {
    attachLive({
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen: null }),
    });
    const pane = await directRow();
    const res = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: {} });
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.message).toMatch(/cdpPort/i);
    expect(body.message).toMatch(/port/i);
  });

  it("watch naming a port the live bridge does not hold is 409, surfaced by name", async () => {
    attachLive();
    const pane = await directRow();
    const first = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: { port: 3000 } });
    expect(first.status).toBe(200);
    // The bridge exists on 3000; re-pointing the same pane's one bridge to
    // 4000 is the broker's `watch-port-conflict` refusal (Task 8 owns the
    // rule; the route owes it a named 409, not a bare 500).
    const clash = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: { port: 4000 } });
    expect(clash.status).toBe(409);
    expect((await errorBody(clash)).message).toMatch(/watch-port-conflict/);
    const stop = await call("DELETE", `/${pane}/views/browser/watch`, { cookie: ownerCookie });
    expect(stop.status).toBe(200);
  });

  it("watch on an offline node is a 409 naming it, never a 500", async () => {
    attachLive();
    const pane = await directRow();
    sim.detach();
    const res = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: { port: 3000 } });
    expect(res.status).toBe(409);
    const body = await errorBody(res);
    expect(body.message).toMatch(/offline|not connected|gone/i);
  });

  it("watch whose preview_open times out is a 409 naming a retry, never a 500", async () => {
    // The node-state pre-gate cannot see this: a stale SPA POSTs a watch at
    // a node that went slow after its last info poll, and the plain Error a
    // timeout carries would render a 500. Mirror of open's timeout arm
    // (same sentence shape, the named retry). The seam throws the plane's
    // own verdict because waiting out the real RPC budget to prove a
    // mapping is a test spending seconds it has not earned.
    attachLive();
    const pane = await directRow();
    resetForTests({
      send: async () => {
        throw new NodeRpcError("timeout", `node "${nodeId}" did not answer preview_open in time`, nodeId);
      },
    });
    const res = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: { port: 3000 } });
    expect(res.status).toBe(409);
    const body = await errorBody(res);
    expect(body.message).toMatch(/did not answer the browser watch in time/);
    expect(body.message).toMatch(/try again/i);
  });

  it("watch against an agent that predates the preview command is a 409 naming the update, never a 500", async () => {
    // The other half of the stale-SPA race: an older node answers the plane
    // with `unsupported`, which carries no status either. Same 409 shape as
    // open's, naming the remedy (update the node).
    attachLive();
    const pane = await directRow();
    resetForTests({
      send: async () => {
        throw new NodeRpcError("unsupported", `node "${nodeId}" does not support preview_open`, nodeId);
      },
    });
    const res = await call("POST", `/${pane}/views/browser/watch`, { cookie: ownerCookie, body: { port: 3000 } });
    expect(res.status).toBe(409);
    const body = await errorBody(res);
    expect(body.message).toMatch(/does not support web previews and screens yet/);
    expect(body.message).toMatch(/update the node/i);
  });

  /* ---------------------------------------------------------------- */
  /* the create path's screen field                                   */
  /* ---------------------------------------------------------------- */

  /** Install the harness so the create path reaches its node resolution. */
  async function makeLaunchable(overrides: ScriptedHandlers = {}): Promise<void> {
    attachLive(overrides);
    await nodes.applyInventory(
      nodeId,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
  }

  async function createBody(extra: Record<string, unknown> = {}) {
    return {
      harnessId: "claude-code",
      workingDir: "/tmp",
      nodeId,
      ...extra,
    };
  }

  it("a screen launch on a preview-off node is refused BEFORE the launch RPC", async () => {
    // The preflight runs in the service, before the row, the token, and the
    // wire: the fake's `launch` spy must stay empty. The remedy names the
    // switch, mirroring spec §6's wording; the node gate (Task 7) stays the
    // authority for everything the plane cannot see.
    await makeLaunchable();
    await nodes.setPreviewEnabled(nodeId, { on: false, changedAt: new Date().toISOString() });
    await nodes.setPreviewEnabled(nodeId, { on: false, feature: "display", changedAt: new Date().toISOString() });
    const before = await paneCount(ownerId);
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "pv screened", screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.message).toMatch(/Enable Allow virtual displays/i);
    // The marker is the wire contract, not decoration: the dashboard matches on
    // `preview-node-off` to decide that this refusal belongs beside the Virtual
    // display checkbox rather than under Save as preset. A rewording that drops
    // it re-creates the original bug with this suite still green.
    expect(body.message).toContain("(preview-node-off)");
    expect(sim.countOf("launch")).toBe(0);
    expect(await paneCount(ownerId)).toBe(before);
  });

  it("a screen launch on a preview-on node reaches the wire carrying screen", async () => {
    await makeLaunchable();
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "pv screen ok", screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(200);
    const launches = sim.cmdsOf("launch");
    expect(launches.length).toBe(1);
    expect(launches[0].screen).toEqual({ width: 1280, height: 800, provider: "xvfb-x11vnc" });
    const created = await jsonBody(res);
    createdSubshellIds.push(String(created.id));
  });

  it("preserves display dimensions on restart and refuses a disabled display before killing the pane", async () => {
    await makeLaunchable({ kill: ok });
    const response = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "display restart", screen: { width: 1440, height: 900 } }),
    });
    expect(response.status).toBe(200);
    const id = String((await jsonBody(response)).id);
    createdSubshellIds.push(id);
    expect((await subshells.findById(id))?.screenConfig).toBe(
      JSON.stringify({ width: 1440, height: 900, provider: "xvfb-x11vnc" }),
    );
    await nodes.setPreviewEnabled(nodeId, { on: false, feature: "display", changedAt: new Date().toISOString() });
    const refused = await call("POST", `/${id}/restart`, { cookie: ownerCookie });
    expect(refused.status).toBe(409);
    expect(sim.countOf("kill")).toBe(0);
    await nodes.setPreviewEnabled(nodeId, {
      on: true,
      feature: "display",
      provider: "xvfb-x11vnc",
      providers: ["xvfb-x11vnc"],
      changedAt: new Date().toISOString(),
    });
    await db.updateTable("nodes").set({ virtualDisplayProviders: "[]" }).where("id", "=", nodeId).execute();
    const providerOff = await call("POST", `/${id}/restart`, { cookie: ownerCookie });
    expect(providerOff.status).toBe(409);
    expect((await errorBody(providerOff)).message).toContain("provider is disabled");
    expect(sim.countOf("kill")).toBe(0);
    await db
      .updateTable("nodes")
      .set({ virtualDisplayProvider: "future-provider", virtualDisplayProviders: JSON.stringify(["xvfb-x11vnc"]) })
      .where("id", "=", nodeId)
      .execute();
    const restarted = await call("POST", `/${id}/restart`, { cookie: ownerCookie });
    expect(restarted.status).toBe(200);
    expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual({ width: 1440, height: 900, provider: "xvfb-x11vnc" });
    expect(sim.countOf("launch")).toBe(2);
  });

  it("apps can stay enabled while virtual-display launches are refused", async () => {
    await makeLaunchable();
    await nodes.setPreviewEnabled(nodeId, { on: false, feature: "display", changedAt: new Date().toISOString() });
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "display disabled", screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(400);
    expect(sim.countOf("launch")).toBe(0);
  });

  it("virtual-display launches work with web previews disabled", async () => {
    await makeLaunchable();
    await nodes.setPreviewEnabled(nodeId, { on: false, changedAt: new Date().toISOString() });
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "display only", screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(200);
    expect(sim.cmdsOf("launch")[0].screen).toEqual({ width: 1280, height: 800, provider: "xvfb-x11vnc" });
    createdSubshellIds.push(String((await jsonBody(res)).id));
  });

  it("rejects disabled and unknown provider choices before writing or launching", async () => {
    await makeLaunchable();
    const count = await paneCount(ownerId);
    for (const provider of ["future-provider", "xvfb-x11vnc"]) {
      await db.updateTable("nodes").set({ virtualDisplayProviders: "[]" }).where("id", "=", nodeId).execute();
      const res = await call("POST", "", {
        cookie: ownerCookie,
        body: await createBody({ screen: { width: 1280, height: 800, provider } }),
      });
      expect(res.status).toBe(400);
      expect((await errorBody(res)).message).toContain("provider");
      expect(sim.countOf("launch")).toBe(0);
      expect(await paneCount(ownerId)).toBe(count);
    }
  });

  it("inherits a preset display, honors explicit opt-out, and pins the actual choice", async () => {
    await makeLaunchable();
    const presets = new PresetsRepository(db);
    const presetId = crypto.randomUUID();
    const screen = { width: 1440, height: 900, provider: "xvfb-x11vnc" };
    await presets.create({
      id: presetId,
      userId: ownerId,
      harnessId: "claude-code",
      name: "Display preset",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      screenConfig: JSON.stringify(screen),
    });
    try {
      for (const optOut of [false, true]) {
        const res = await call("POST", "", {
          cookie: ownerCookie,
          body: await createBody({ presetId, ...(optOut ? { screen: null } : {}) }),
        });
        expect(res.status).toBe(200);
        const id = String((await jsonBody(res)).id);
        createdSubshellIds.push(id);
        expect(sim.cmdsOf("launch").at(-1)?.screen).toEqual(optOut ? undefined : screen);
        expect((await subshells.findById(id))?.screenConfig).toBe(optOut ? null : JSON.stringify(screen));
        expect((await jsonBody(await call("GET", `/${id}`, { cookie: ownerCookie }))).screen).toEqual(
          optOut ? null : screen,
        );
      }
    } finally {
      await presets.delete(presetId);
    }
  });

  it("a plain launch carries no screen member at all", async () => {
    await makeLaunchable();
    const res = await call("POST", "", { cookie: ownerCookie, body: await createBody({ name: "pv plain" }) });
    expect(res.status).toBe(200);
    const launches = sim.cmdsOf("launch");
    expect(launches.length).toBe(1);
    expect(launches[0].screen).toBeUndefined();
    const created = await jsonBody(res);
    createdSubshellIds.push(String(created.id));
  });

  it.each([
    ["width below the floor", { width: 319, height: 800 }],
    ["height above the ceiling", { width: 1280, height: 5000 }],
    ["a fractional width", { width: 1000.5, height: 800 }],
    ["a non-object", "1280x800"],
  ])("create refuses screen %s at the schema", async (_label, screen) => {
    await makeLaunchable();
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "pv bounds", screen }),
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe(BackendErrorCodes.INPUT_VALIDATION_ERROR);
    expect(sim.countOf("launch")).toBe(0);
  });

  // The node-side half of the screen gate: refusals that arrive FROM the
  // wire, which the service preflight cannot see (an older node, or a
  // switch flipped mid-race). Every row echoes the node's own detail, bare
  // form included: the word is what an operator greps in the daemon log, and
  // what `isDisplayLaunchRefusal` (apps/server/web) matches to render the
  // refusal beside the Virtual display control that asked for the screen.
  const SCREEN_REFUSALS: ReadonlyArray<readonly [string, RegExp, boolean]> = [
    ["preview-display-unsupported", /provider is not supported/, true],
    ["preview-display-missing-requirements: x11vnc", /provider has unmet requirements/, true],
    ["preview-node-off: turn on Preview for this node", /Turn on Preview for this node/i, true],
  ];

  it.each(SCREEN_REFUSALS)(
    "a node-side screen refusal %s is a 400 with the remedy, and the create rolls back",
    async (detail, remedy, echo) => {
      // The DB switch stays ON (beforeEach set it), so the preflight passes
      // and the refusal only ever comes from the scripted launch itself.
      // One `launch` flying is the contrast with the preflight row's zero.
      await makeLaunchable({ launch: () => new Error(detail) });
      const name = `pv refused ${detail.slice(0, 22)}`;
      const keysBefore = liveKeyCount(ownerId);
      const res = await call("POST", "", {
        cookie: ownerCookie,
        body: await createBody({ name, screen: { width: 1280, height: 800 } }),
      });
      expect(res.status).toBe(400);
      const body = await errorBody(res);
      expect(body.message).toMatch(remedy);
      if (echo) {
        // The node's word rides along in the message so an operator can
        // grep exactly what the agent said.
        expect(body.message).toContain(detail);
      }
      expect(sim.countOf("launch")).toBe(1);
      // The manager's rollback: best-effort kill, the row ends TERMINATED
      // (it was written before the wire, so the row stays, retired), and the
      // pane's token stops being an enabled key.
      expect(await paneStatusByName(ownerId, name)).toBe("terminated");
      expect(liveKeyCount(ownerId)).toBe(keysBefore);
    },
  );

  it("a malformed launch ack rolls the create back and answers the plain error, never a false 200", async () => {
    // `{ screen: "junk" }` fails the launch grammar: the plane cannot say
    // what screen the pane has, so it must not claim the pane launched. The
    // posture is the plain Error (500 through the handler) plus the full
    // rollback; pinned so a rewording of the ack path can neither turn the
    // breach into a success nor leak a live row with a live token.
    await makeLaunchable({ launch: () => ({ screen: "junk" }) });
    const name = "pv junk ack";
    const keysBefore = liveKeyCount(ownerId);
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name, screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(500);
    expect((await errorBody(res)).code).toBe(BackendErrorCodes.INTERNAL_SERVER_ERROR);
    expect(await paneStatusByName(ownerId, name)).toBe("terminated");
    expect(liveKeyCount(ownerId)).toBe(keysBefore);
  });

  it("the launch ack's screen echo arms the info answer before the ports scan reports it", async () => {
    // The VNC bridge is up when the ack flies; the next preview_ports_get
    // may not know the screen yet, so the broker's launch memory answers
    // the info poll inside that window. The memory holds the ack verbatim,
    // which is also the spy that onDisplayOpened fired.
    await makeLaunchable({
      launch: () => ({ screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } } }),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen: null }),
    });
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "pv ack echo", screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(200);
    const created = String((await jsonBody(res)).id);
    createdSubshellIds.push(created);
    expect(getPreviewBroker().displayForPane(created)).toEqual({
      nodeId,
      screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } },
    });
    const body = await jsonBody(await call("GET", `/${created}/views`, { cookie: ownerCookie }));
    expect(body.screen).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
    expect(body.screenLost).toBeUndefined();
  });

  it("the launch memory never masks a screenLost the node reported", async () => {
    // A death the node reported outranks the plane's memory of the birth:
    // once the scan says the display process died, info keeps answering
    // screen null with the named marker, not the remembered screen. Without
    // this leg the overlay could show a dead screen forever.
    await makeLaunchable({
      launch: () => ({ screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } } }),
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen: null }),
    });
    const res = await call("POST", "", {
      cookie: ownerCookie,
      body: await createBody({ name: "pv ack then lost", screen: { width: 1280, height: 800 } }),
    });
    expect(res.status).toBe(200);
    const created = String((await jsonBody(res)).id);
    createdSubshellIds.push(created);
    // Same node identity, new answers: the scan now reports the x11vnc died.
    attachLive({
      preview_ports_get: () => ({ ports: [], cdpPort: null, screen: null, screenLost: "x11vnc" }),
    });
    const body = await jsonBody(await call("GET", `/${created}/views`, { cookie: ownerCookie }));
    expect(body.screen).toBeNull();
    expect(body.screenLost).toBe("x11vnc");
  });

  /* ---------------------------------------------------------------- */
  /* the pane's own exit tears the preview down                       */
  /* ---------------------------------------------------------------- */

  it("a self-reported exit closes the pane's preview state as pane-gone", async () => {
    attachLive();
    const pane = await directRow();
    const token = await bearerFor(pane);
    // Start a watch so there IS bridge state to lose, then report the exit
    // exactly the pane's own reporter call would.
    const start = await call("POST", `/${pane}/views/browser/watch`, { bearer: token, body: { port: 3000 } });
    expect(start.status).toBe(200);
    expect(getPreviewBroker().sessionForPane(pane)).not.toBeNull();
    const res = await call("POST", `/${pane}/exit`, { bearer: token, body: { exitCode: 0 } });
    expect(res.status).toBe(200);
    // The broker is the one that knows "this pane is gone" now: every lane
    // and bridge of it is closed (the audit rides onDisplayClosed inside the
    // broker; the route never calls it on its own).
    expect(getPreviewBroker().sessionForPane(pane)).toBeNull();
  });
});

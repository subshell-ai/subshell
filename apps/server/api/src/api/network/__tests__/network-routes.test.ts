import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { NetworkStatus } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { networkRoutes } from "@/api/network/index.js";
import { invalidateNetworkStatus, setNetworkDepsForTests } from "@/api/network/network-gate.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { clearNetworkState, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { setUnpublishDepsForTests } from "@/services/network/unpublish.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { FAKE_ID, fakeDeps, fakeReport, makeFakePlugin } from "./fake-network-plugin.js";

/**
 * `/api/network` — the gate, the refusal table, the list row and the two
 * non-streaming acts (spec 2026-09-15 § 5.1).
 *
 * Two properties this file exists to pin, beyond the row-by-row assertions:
 *
 * - **Every refusal is decided before a body opens.** The streaming routes
 *   answer a 4xx with a JSON body, never a 200 whose first frame says no —
 *   once a status line is sent, a 200 cannot be taken back.
 * - **A credential never reaches an audit row.** The settings and join suites
 *   scan the SERIALIZED metadata for the exact secret they sent, the same scan
 *   `admin-status-route.test.ts` runs over its response body.
 */

const app = new Elysia().use(errorHandlerPlugin).use(networkRoutes);

const email = `network-user-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `network-admin-${crypto.randomUUID()}@subshell.local`;
const password = "network-route-pass-1234";

let userId = "";
let cookie = "";
let adminCookie = "";
let subshellId = "";
let subshellKey = "";
let apiKeyId: string | undefined;

/** A request with no credential at all. */
function anon(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

/** A request carrying a session cookie. */
function withCookie(path: string, token: string, init?: RequestInit): Request {
  const req = anon(path, init);
  req.headers.set("cookie", `better-auth.session_token=${token}`);
  return req;
}

/** A request carrying a subshell bearer key — a machine credential. */
function withBearer(path: string, init?: RequestInit): Request {
  const req = anon(path, init);
  req.headers.set("authorization", `Bearer ${subshellKey}`);
  return req;
}

/** Every NDJSON frame of a streamed act, in order. */
async function frames(res: Response): Promise<{ type: string; [key: string]: unknown }[]> {
  return (await res.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string });
}

/** The audit trail for one action, newest first, with metadata parsed AND raw. */
async function auditRows(action: string): Promise<{ metadata: Record<string, unknown>; raw: string }[]> {
  const events = await new AuditRepository(db).listLatest(300);
  return events
    .filter((e) => e.action === action)
    .map((e) => ({
      metadata: JSON.parse(String(e.metadataJson ?? "{}")) as Record<string, unknown>,
      raw: String(e.metadataJson ?? ""),
    }));
}

const NOT_INSTALLED: NetworkStatus = {
  state: "not-installed",
  addresses: [],
  hints: [{ text: "Install the Test Network CLI first.", command: "brew install test-network" }],
};

describe("/api/network", () => {
  beforeAll(async () => {
    await setupAuthTables();

    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "network-route-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? undefined;
  });

  afterEach(async () => {
    setNetworkDepsForTests(null);
    setUnpublishDepsForTests(null);
    invalidateNetworkStatus();
    await clearNetworkState(FAKE_ID);
  });

  afterAll(async () => {
    if (subshellId) await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    if (userId) await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(adminEmail);
  });

  describe("the gate", () => {
    it("refuses an anonymous caller with 401 on every route", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const calls: [string, RequestInit][] = [
        ["/api/network", { method: "GET" }],
        [`/api/network/${FAKE_ID}/settings`, { method: "PATCH", body: "{}" }],
        [`/api/network/${FAKE_ID}/install`, { method: "POST" }],
        [`/api/network/${FAKE_ID}/join`, { method: "POST", body: "{}" }],
        [`/api/network/${FAKE_ID}/publish`, { method: "POST", body: "{}" }],
        [`/api/network/${FAKE_ID}/unpublish`, { method: "POST" }],
        [`/api/network/${FAKE_ID}/leave`, { method: "POST", body: JSON.stringify({ confirm: FAKE_ID }) }],
      ];
      for (const [path, init] of calls) {
        const res = await app.fetch(anon(path, init));
        expect([path, res.status]).toEqual([path, 401]);
      }
    });

    it("refuses a signed-in non-admin with 403", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(withCookie("/api/network", cookie));
      expect(res.status).toBe(403);
    });

    it("refuses a machine credential with 403, even though the routes are admin-only", async () => {
      // A bearer key can never manage the instance. These routes join this
      // machine to a network and rewrite its config, and no machine consumer
      // exists for either.
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(withBearer("/api/network"));
      expect(res.status).toBe(403);
    });

    it("admits an admin cookie", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(withCookie("/api/network", adminCookie));
      expect(res.status).toBe(200);
    });
  });

  describe("the refusal table", () => {
    it("404s an id nothing knows", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(withCookie("/api/network/nope/join", adminCookie, { method: "POST", body: "{}" }));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND_ERROR");
    });

    it("404s a plugin the instance has disabled", async () => {
      // Installed, loadable, and simply not offered. The same 404 as an
      // unknown id: distinguishing them would let a caller enumerate what an
      // instance holds but does not offer.
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry, { enabled: async () => [] }));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(res.status).toBe(404);
    });

    it("409s PLATFORM_UNSUPPORTED on a platform the manifest does not claim", async () => {
      const { entry, calls } = makeFakePlugin({ platforms: ["linux"] });
      setNetworkDepsForTests(fakeDeps(entry, { platform: () => "darwin" }));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("PLATFORM_UNSUPPORTED");
      // Manifest DATA decided it: no plugin code ran at all.
      expect(calls.status).toBe(0);
      expect(calls.join).toEqual([]);
    });

    it("409s EXISTS_ERROR while another act holds the plugin", async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { entry } = makeFakePlugin({
        join: async () => {
          await gate;
          return { state: "joined" };
        },
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const first = app.fetch(withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }));
      // The first response resolves as soon as its stream is handed back, so
      // read it to the end only AFTER the second request has been refused.
      const firstRes = await first;
      const second = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("EXISTS_ERROR");
      release();
      await frames(firstRes);
    });

    it("409s NETWORK_NOT_READY carrying the plugin's first hint", async () => {
      const { entry, calls } = makeFakePlugin({ status: NOT_INSTALLED });
      setNetworkDepsForTests(fakeDeps(entry));
      for (const verb of ["join", "publish"]) {
        invalidateNetworkStatus();
        const res = await app.fetch(
          withCookie(`/api/network/${FAKE_ID}/${verb}`, adminCookie, { method: "POST", body: "{}" }),
        );
        const body = (await res.json()) as { code: string; message: string };
        expect([verb, res.status, body.code]).toEqual([verb, 409, "NETWORK_NOT_READY"]);
        expect(body.message).toBe("Install the Test Network CLI first.");
      }
      expect(calls.join).toEqual([]);
      expect(calls.publish).toBe(0);
    });

    it("409s NETWORK_UNCONFIGURED while a required field is unset", async () => {
      const { entry, calls } = makeFakePlugin({
        fields: [{ key: "token", label: "API token", type: "secret", required: true }],
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/publish`, adminCookie, { method: "POST", body: "{}" }),
      );
      const body = (await res.json()) as { code: string; message: string };
      expect([res.status, body.code]).toEqual([409, "NETWORK_UNCONFIGURED"]);
      expect(body.message).toContain("API token");
      expect(calls.publish).toBe(0);
    });

    it("does NOT gate join on a required SECRET — join is how the secret arrives", async () => {
      // The Cloudflare Tunnel's shape: the token is a required `secret` field,
      // and the join's credential IS how it reaches the write-only store
      // (`host.secrets.set`). Demanding the store already hold it before join
      // runs made the Connect button structurally dead — the only path to
      // satisfy the gate was to have already performed the act the gate was
      // gating. The review of phases 2/3 found it; publish still gates
      // (above), because publish is downstream of delivery.
      const { entry, calls } = makeFakePlugin({
        fields: [{ key: "tunnel-token", label: "Tunnel token", type: "secret", required: true }],
        join: { state: "joined" },
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ credential: "tskey-really-a-token" }),
        }),
      );
      expect(res.status).toBe(200);
      await frames(res);
      expect(calls.join.length).toBe(1);
      expect(calls.join[0]?.credential).toBe("tskey-really-a-token");
    });

    it("still gates join on required NON-secret fields", async () => {
      // The other half, so the exemption above stays narrow: the control URL
      // (Headscale) and the hostname/team/AUD triple (Cloudflare) are ordinary
      // settings no join can deliver, and they must be set first.
      const { entry, calls } = makeFakePlugin({
        fields: [{ key: "controlUrl", label: "Control server URL", type: "string", required: true }],
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ credential: "tskey-any" }),
        }),
      );
      const body = (await res.json()) as { code: string; message: string };
      expect([res.status, body.code]).toEqual([409, "NETWORK_UNCONFIGURED"]);
      expect(body.message).toContain("Control server URL");
      expect(calls.join).toEqual([]);
    });

    it("treats a required field carrying a default as configured", async () => {
      const { entry, calls } = makeFakePlugin({
        fields: [{ key: "region", label: "Region", type: "string", required: true, default: "eu" }],
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(res.status).toBe(200);
      await frames(res);
      expect(calls.join.length).toBe(1);
    });

    it("404s publish on a plugin that does not publish at all", async () => {
      const { entry } = makeFakePlugin({ noPublish: true });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/publish`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/network", () => {
    it("renders the row from manifest data, this platform's privileged steps, and a live status", async () => {
      const { entry, calls } = makeFakePlugin({
        fields: [
          { key: "hostname", label: "Hostname", type: "string" },
          { key: "token", label: "API token", type: "secret", required: true },
        ],
      });
      setNetworkDepsForTests(fakeDeps(entry));
      await writeNetworkState(FAKE_ID, { settings: { hostname: "box" } });

      const res = await app.fetch(withCookie("/api/network", adminCookie));
      expect(res.status).toBe(200);
      const { networks } = (await res.json()) as { networks: Record<string, any>[] };
      expect(networks.length).toBe(1);
      const row = networks[0];
      expect(row.id).toBe(FAKE_ID);
      expect(row.exposure).toBe("public-with-gate");
      expect(row.platforms).toEqual(["darwin", "linux"]);
      expect(row.supported).toBe(true);
      expect(row.enabled).toBe(true);
      expect(row.interactiveLogin).toBe(true);
      // The unpublish confirmation branches on this, so the row must always
      // carry an answer — absence is Elysia dropping an undeclared field.
      expect(row.publishImplicit).toBe(false);
      expect(row.install.command).toBe("brew install test-network");
      // darwin's step only. Rendering the linux one to copy is how an operator
      // runs a systemd command on a Mac.
      //
      // `group` rides along because it is the only thing that tells a page
      // these steps are ALTERNATIVES rather than one long sequence, and the
      // row is where the page reads from.
      expect(row.privileged).toEqual([
        { label: "Install the daemon", command: "sudo test-network install", group: "The daemon" },
      ]);
      expect(row.settings).toEqual({ hostname: "box", token: { set: false } });
      expect(row.status.state).toBe("joined");
      expect(row.published).toBe(false);
      expect(calls.status).toBe(1);
    });

    it("shows a publish-implicit plugin the host recorded as published AS publishing", async () => {
      // NetBird's publish runs no command the daemon could later be asked
      // about, so its own status tops out at `joined` and the host's record
      // is the only witness of the publish. `publishImplicit` is what lets
      // the record upgrade that plugin's row.
      const { entry } = makeFakePlugin({
        publishImplicit: true,
        status: { state: "joined", addresses: [], hints: [] },
      });
      setNetworkDepsForTests(fakeDeps(entry));
      await writeNetworkState(FAKE_ID, { published: true, port: 3080 });

      const res = await app.fetch(withCookie("/api/network", adminCookie));
      const { networks } = (await res.json()) as { networks: Record<string, any>[] };
      expect(networks[0].status.state).toBe("published");
      expect(networks[0].published).toBe(true);
      expect(networks[0].publishImplicit).toBe(true);
    });

    it("leaves a joined row joined for a plugin that never declared publishImplicit", async () => {
      // The other half of the flag: Tailscale's serve state IS readable, so a
      // serve reset from a terminal outside this app must show as `joined`
      // however confidently our record says "published". An unconditional
      // upgrade would paper over exactly that.
      const { entry } = makeFakePlugin({ status: { state: "joined", addresses: [], hints: [] } });
      setNetworkDepsForTests(fakeDeps(entry));
      await writeNetworkState(FAKE_ID, { published: true, port: 3080 });

      const res = await app.fetch(withCookie("/api/network", adminCookie));
      const { networks } = (await res.json()) as { networks: Record<string, any>[] };
      expect(networks[0].status.state).toBe("joined");
      expect(networks[0].published).toBe(true);
    });

    it("drops a hint URL a browser must not navigate to, and keeps the sentence", async () => {
      // A plugin reports what it read off a vendor CLI, which reports what its
      // CONTROL SERVER sent — and `--login-server` makes that a host the
      // operator chose. So a hint's URL is the least trustworthy string on the
      // page, and it lands in an `href` in an admin's session.
      const { entry } = makeFakePlugin({
        status: {
          state: "needs-login",
          addresses: [],
          loginUrl: "javascript:alert(document.cookie)",
          hints: [
            { text: "Finish signing in.", docsUrl: "javascript:alert(document.cookie)" },
            { text: "Read the docs.", docsUrl: "https://example.invalid/docs" },
          ],
        },
      });
      setNetworkDepsForTests(fakeDeps(entry));

      const res = await app.fetch(withCookie("/api/network", adminCookie));
      const { networks } = (await res.json()) as { networks: Record<string, any>[] };
      const status = networks[0].status;
      // The hint survives without its link: the sentence is the plugin's own
      // and stays true, where a dropped hint leaves the card saying nothing.
      expect(status.hints[0]).toEqual({ text: "Finish signing in." });
      expect(status.hints[1].docsUrl).toBe("https://example.invalid/docs");
      expect(status.loginUrl).toBeUndefined();
      expect(await (await app.fetch(withCookie("/api/network", adminCookie))).text()).not.toContain("javascript:");
    });

    it("never returns a secret's value, only whether one is set", async () => {
      const { entry } = makeFakePlugin({ fields: [{ key: "token", label: "API token", type: "secret" }] });
      setNetworkDepsForTests(fakeDeps(entry));
      const secret = `secret-value-${crypto.randomUUID()}`;
      await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ token: secret }),
        }),
      );
      const res = await app.fetch(withCookie("/api/network", adminCookie));
      const text = await res.text();
      expect(text).not.toContain(secret);
      expect(JSON.parse(text).networks[0].settings.token).toEqual({ set: true });
    });

    it("never probes a plugin this platform does not support", async () => {
      const { entry, calls } = makeFakePlugin({ platforms: ["linux"] });
      setNetworkDepsForTests(fakeDeps(entry, { platform: () => "darwin" }));
      const res = await app.fetch(withCookie("/api/network", adminCookie));
      const { networks } = (await res.json()) as { networks: Record<string, any>[] };
      expect(networks[0].supported).toBe(false);
      expect(networks[0].status).toBeUndefined();
      expect(calls.status).toBe(0);
      // The manifest half is still there, so the page can say why and print
      // the vendor's own install command.
      expect(networks[0].install.docsUrl).toBe("https://example.invalid/install");
    });

    it("never probes a disabled plugin, and says it is disabled", async () => {
      const { entry, calls } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry, { enabled: async () => [] }));
      const { networks } = (await (await app.fetch(withCookie("/api/network", adminCookie))).json()) as {
        networks: Record<string, any>[];
      };
      expect(networks[0].enabled).toBe(false);
      expect(networks[0].status).toBeUndefined();
      expect(calls.status).toBe(0);
    });

    it("turns a plugin whose status() throws into a row, never a 500", async () => {
      const { entry } = makeFakePlugin({ statusThrows: "the socket is gone" });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(withCookie("/api/network", adminCookie));
      expect(res.status).toBe(200);
      const { networks } = (await res.json()) as { networks: Record<string, any>[] };
      expect(networks[0].status.state).toBe("daemon-down");
      expect(networks[0].status.hints[0].text).toContain("the socket is gone");
    });

    it("omits a plugin the store does not hold", async () => {
      // Loadable but not installed: there is nothing here to act on, and the
      // plugin's own row lives on /api/plugins.
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry, { installed: async () => [], enabled: async () => [] }));
      const { networks } = (await (await app.fetch(withCookie("/api/network", adminCookie))).json()) as {
        networks: unknown[];
      };
      expect(networks).toEqual([]);
    });

    it("memoises a status for three seconds, and drops it on a write", async () => {
      const { entry, calls } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      await app.fetch(withCookie("/api/network", adminCookie));
      await app.fetch(withCookie("/api/network", adminCookie));
      // Two reads, one probe: the page polls, and a probe is a vendor CLI.
      expect(calls.status).toBe(1);
      // A write drops the memo and re-probes, so the row it answers with
      // describes the machine after the write rather than before it.
      await app.fetch(withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, { method: "PATCH", body: "{}" }));
      expect(calls.status).toBe(2);
    });
  });

  describe("PATCH /api/network/:id/settings", () => {
    it("stores ordinary fields and reports them back", async () => {
      const { entry } = makeFakePlugin({ fields: [{ key: "hostname", label: "Hostname", type: "string" }] });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ hostname: "laptop" }),
        }),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { settings: Record<string, unknown> }).settings.hostname).toBe("laptop");
      expect((await readNetworkState(FAKE_ID)).settings).toEqual({ hostname: "laptop" });
    });

    it("keeps a secret out of the settings file entirely", async () => {
      const { entry } = makeFakePlugin({ fields: [{ key: "token", label: "API token", type: "secret" }] });
      setNetworkDepsForTests(fakeDeps(entry));
      const secret = `settings-secret-${crypto.randomUUID()}`;
      await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ token: secret }),
        }),
      );
      // The settings object is what the plugin is handed on every call, so a
      // credential landing there would be a value the contract says a plugin
      // never receives.
      expect(JSON.stringify(await readNetworkState(FAKE_ID))).not.toContain(secret);
    });

    it("refuses a key the plugin never declared", async () => {
      const { entry } = makeFakePlugin({ fields: [{ key: "hostname", label: "Hostname", type: "string" }] });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ nonsense: "x" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain("nonsense");
    });

    it("reports the plugin's own field problems as a 400", async () => {
      const { entry } = makeFakePlugin({
        fields: [{ key: "hostname", label: "Hostname", type: "string" }],
        issues: [{ field: "hostname", message: "must be a DNS label" }],
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ hostname: "not a label" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain("must be a DNS label");
      expect((await readNetworkState(FAKE_ID)).settings).toEqual({});
    });

    it("audits the field NAMES and never a value", async () => {
      const { entry } = makeFakePlugin({
        fields: [
          { key: "hostname", label: "Hostname", type: "string" },
          { key: "token", label: "API token", type: "secret" },
        ],
      });
      setNetworkDepsForTests(fakeDeps(entry));
      const secret = `audit-secret-${crypto.randomUUID()}`;
      await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ hostname: "laptop", token: secret }),
        }),
      );
      const rows = await auditRows("network.configure");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].metadata).toEqual({ fields: ["hostname", "token"] });
      // THE SCAN. Nothing in the serialized metadata may be the credential,
      // whatever shape a later change gives the row.
      for (const row of rows) expect(row.raw).not.toContain(secret);
    });
  });

  it("refuses a settings write while the network is published", async () => {
    // Nothing re-derives from a settings change: the installed guard keeps
    // the hostname and audience it was built with, and the supervised child
    // keeps the argv and the hydrated SECRET it was spawned with. An admin
    // rotating a leaked token would see the field read `set` and the process
    // read running while the old credential stayed live. Re-deriving all
    // three is phase 3's work; until then the refusal makes the gap
    // unreachable, so phase 3 must DELETE something to get the wrong thing.
    const { entry } = makeFakePlugin({ fields: [{ key: "hostname", label: "Hostname", type: "string" }] });
    setNetworkDepsForTests(fakeDeps(entry));
    await writeNetworkState(FAKE_ID, { published: true, port: 3080 });
    try {
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/settings`, adminCookie, {
          method: "PATCH",
          body: JSON.stringify({ hostname: "moved.example.com" }),
        }),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toContain("Unpublish it first");
      // And nothing was written, so the refusal is not merely a bad report.
      expect((await readNetworkState(FAKE_ID)).settings.hostname).toBeUndefined();
    } finally {
      await writeNetworkState(FAKE_ID, { published: false });
    }
  });

  describe("POST /api/network/:id/join", () => {
    it("streams NDJSON: line frames, then exactly one done", async () => {
      const { entry } = makeFakePlugin({ join: { state: "needs-login", loginUrl: "https://login.example/abc" } });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
      const emitted = await frames(res);
      expect(emitted[0].type).toBe("line");
      expect(emitted.filter((f) => f.type === "done").length).toBe(1);
      expect(emitted[emitted.length - 1].type).toBe("done");
      const done = emitted[emitted.length - 1] as unknown as {
        outcome: { state: string };
        status: { state: string };
      };
      expect(done.outcome.state).toBe("needs-login");
      expect(done.status.state).toBe("joined");
      expect(emitted.some((f) => String(f.text ?? "").includes("https://login.example/abc"))).toBe(true);
    });

    it("forwards the credential and the hostname to the plugin", async () => {
      const { entry, calls } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ credential: "tskey-abc", hostname: "laptop" }),
        }),
      );
      await frames(res);
      expect(calls.join).toEqual([{ credential: "tskey-abc", hostname: "laptop" }]);
    });

    it("delivers a malformed-credential throw as an error frame inside a 200", async () => {
      // The body is already open by the time the plugin decides, so a 400 is
      // impossible — which is why the credential's SHAPE is the one thing this
      // route does not pre-validate.
      const { entry } = makeFakePlugin({ join: { throws: "that is not a valid auth key" } });
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ credential: "garbage" }),
        }),
      );
      expect(res.status).toBe(200);
      const emitted = await frames(res);
      const last = emitted[emitted.length - 1] as { type: string; message: string };
      expect(last.type).toBe("error");
      expect(last.message).toContain("not a valid auth key");
      expect(emitted.some((f) => f.type === "done")).toBe(false);
    });

    it("audits the mode and the outcome, never the credential", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const credential = `join-credential-${crypto.randomUUID()}`;
      await frames(
        await app.fetch(
          withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, {
            method: "POST",
            body: JSON.stringify({ credential }),
          }),
        ),
      );
      const rows = await auditRows("network.join");
      // `some` rather than the newest row: other joins in this file land in
      // the same table within the same millisecond, so ordering between them
      // is not a thing to assert on.
      expect(rows.some((r) => r.metadata.mode === "credential" && r.metadata.ok === true)).toBe(true);
      for (const row of rows) expect(row.raw).not.toContain(credential);
    });

    it("records an interactive join as such, and a failure as ok:false", async () => {
      const { entry } = makeFakePlugin({ join: { throws: "the daemon went away" } });
      setNetworkDepsForTests(fakeDeps(entry));
      await frames(
        await app.fetch(withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" })),
      );
      const rows = await auditRows("network.join");
      expect(rows.some((r) => r.metadata.mode === "interactive" && r.metadata.ok === false)).toBe(true);
    });

    it("releases the per-plugin lock after a failed act", async () => {
      const { entry } = makeFakePlugin({ join: { throws: "boom" } });
      setNetworkDepsForTests(fakeDeps(entry));
      await frames(
        await app.fetch(withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" })),
      );
      const second = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/join`, adminCookie, { method: "POST", body: "{}" }),
      );
      expect(second.status).toBe(200);
      await frames(second);
    });
  });

  describe("POST /api/network/:id/unpublish", () => {
    it("delegates to the one unpublish sequence and answers with a fresh status", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      let unpublished = 0;
      setUnpublishDepsForTests({
        getPlugin: () => entry,
        disarm: async () => {
          unpublished += 1;
        },
        lastLines: () => [],
        setPluginGuards: () => {},
      });
      const res = await app.fetch(withCookie(`/api/network/${FAKE_ID}/unpublish`, adminCookie, { method: "POST" }));
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
      expect(unpublished).toBe(1);
      expect((await auditRows("network.unpublish")).length).toBeGreaterThan(0);
    });

    it("409s with the child's last lines when the process will not stop", async () => {
      const { entry } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      setUnpublishDepsForTests({
        getPlugin: () => entry,
        disarm: async () => {
          throw new Error("SIGKILL did not reap it");
        },
        lastLines: () => ["cloudflared: connection lost", "cloudflared: retrying"],
        setPluginGuards: () => {},
      });
      const res = await app.fetch(withCookie(`/api/network/${FAKE_ID}/unpublish`, adminCookie, { method: "POST" }));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("EXISTS_ERROR");
      expect(body.message).toContain("SIGKILL did not reap it");
      expect(body.message).toContain("cloudflared: retrying");
    });
  });

  describe("POST /api/network/:id/leave", () => {
    it("refuses a confirmation that is not the plugin id", async () => {
      const { entry, calls } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/leave`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ confirm: "something else" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(calls.leave).toBe(0);
    });

    it("unpublishes, leaves, and forgets the recorded state", async () => {
      const { entry, calls } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      const order: string[] = [];
      setUnpublishDepsForTests({
        getPlugin: () => entry,
        disarm: async () => {
          order.push("disarm");
        },
        lastLines: () => [],
        setPluginGuards: () => {},
      });
      await writeNetworkState(FAKE_ID, { settings: { hostname: "box" }, published: true });
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/leave`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ confirm: FAKE_ID }),
        }),
      );
      expect(res.status).toBe(200);
      expect(calls.leave).toBe(1);
      // Unpublish FIRST: leaving while a tunnel still points here would leave
      // that tunnel serving an address this machine no longer answers on.
      expect(order).toEqual(["disarm"]);
      expect((await readNetworkState(FAKE_ID)).settings).toEqual({});
      expect((await auditRows("network.leave")).length).toBeGreaterThan(0);
    });

    it("refuses to leave while the process will not stop", async () => {
      const { entry, calls } = makeFakePlugin();
      setNetworkDepsForTests(fakeDeps(entry));
      setUnpublishDepsForTests({
        getPlugin: () => entry,
        disarm: async () => {
          throw new Error("still running");
        },
        lastLines: () => [],
        setPluginGuards: () => {},
      });
      const res = await app.fetch(
        withCookie(`/api/network/${FAKE_ID}/leave`, adminCookie, {
          method: "POST",
          body: JSON.stringify({ confirm: FAKE_ID }),
        }),
      );
      expect(res.status).toBe(409);
      expect(calls.leave).toBe(0);
    });
  });

  it("keeps the fake report shape the deps hand out in step with the row builder", () => {
    // A guard on the helper rather than on production code: every suite here
    // asserts against rows built from this report, so a drift in it would make
    // the assertions describe something the server never produces.
    expect(fakeReport().type).toBe("network");
  });
});

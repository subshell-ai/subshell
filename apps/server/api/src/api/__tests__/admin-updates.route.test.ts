import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  NODE_PROTOCOL_VERSION,
  NODE_SIGNED_UPDATES_PROTOCOL_VERSION,
  parseReleaseManifest,
} from "@internal/subshell-protocol";
import type { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import { Elysia } from "elysia";
import { adminUpdatesRoutes, adminUpdatesSeams } from "@/api/admin-updates.route.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { releaseSeams, resetReleaseCacheForTests, setReleaseUrlForTests } from "@/services/releases.js";
import { SERVER_VERSION } from "@/version.js";
import { type AdminServerFixture, bearerRequest, setupAdminServerFixture } from "../admin-server/__tests__/fixture.js";
import { authedRequest } from "./helpers/auth-tables.js";

/**
 * `GET /api/admin/updates` — the whole Updates page in one read (spec §4.6).
 *
 * The suite runs with `SUBSHELL_RELEASE_URL` empty (`IS_TEST` pins it), so
 * these cases are the AIR-GAPPED instance, which is also the shape the e2e
 * stack renders: every release is null and every card says why. That is the
 * state the page has to be honest in, and the one nothing else covers.
 */

const app = new Elysia().use(errorHandlerPlugin).use(adminUpdatesRoutes);

interface UpdatesBody {
  server: { current: string; canApply: { reasons: string[] } };
  nodes: {
    release: unknown;
    reason: string | null;
    rows: {
      id: string;
      name: string;
      agentVersion: string | null;
      target: string | null;
      online: boolean;
      held: { reason: string } | null;
      updateAvailable: boolean;
      canUpdate: { ok: boolean; reason: string | null };
    }[];
  };
  desktop: { server: unknown; client: unknown };
}

describe("GET /api/admin/updates", () => {
  let fx: AdminServerFixture;
  const nodes = new NodesRepository(db);
  const created: string[] = [];
  const realHeld = adminUpdatesSeams.getHeldRows;

  async function read(cookie: string): Promise<UpdatesBody> {
    const res = await app.fetch(authedRequest("/api/admin/updates", cookie));
    expect(res.status).toBe(200);
    return (await res.json()) as UpdatesBody;
  }

  beforeAll(async () => {
    fx = await setupAdminServerFixture("admin-updates");
  });
  afterAll(async () => {
    for (const id of created) await nodes.deleteById(id);
    await fx.cleanup();
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
  });
  afterEach(() => {
    adminUpdatesSeams.getHeldRows = realHeld;
  });

  /** An enrolled agent row, cleaned up with the suite. */
  async function agent(over: {
    name: string;
    os?: string | null;
    arch?: string | null;
    version?: string | null;
    protocol?: number;
  }) {
    const id = crypto.randomUUID();
    created.push(id);
    await nodes.create({ id, ownerUserId: "system", name: over.name, kind: "agent" });
    if (over.version !== undefined && over.version !== null) {
      await nodes.applyReady(id, {
        agentVersion: over.version,
        protocolVersion: over.protocol ?? 1,
        os: over.os ?? "linux",
        arch: over.arch ?? "x64",
        hostname: over.name,
        capabilities: [],
      });
    }
    return id;
  }

  it("answers the three sections, with the air-gapped reason on each", async () => {
    const body = await read(fx.adminCookie);
    expect(Object.keys(body).sort()).toEqual(["desktop", "nodes", "server"]);
    expect(body.server.current).toBe(SERVER_VERSION);
    expect(body.server.canApply.reasons).toContain("no release source is configured (SUBSHELL_RELEASE_URL is empty)");
    expect(body.nodes.release).toBeNull();
    expect(body.nodes.reason).toContain("SUBSHELL_RELEASE_URL");
    expect(body.desktop.server).toBeNull();
    expect(body.desktop.client).toBeNull();
  });

  it("derives a row's target from the node's own os/arch, and null for a platform nobody publishes", async () => {
    const linux = await agent({ name: `upd-linux-${crypto.randomUUID()}`, version: "0.8.0" });
    const intel = await agent({
      name: `upd-intel-${crypto.randomUUID()}`,
      os: "darwin",
      arch: "x64",
      version: "0.8.0",
    });
    const body = await read(fx.adminCookie);
    const byId = new Map(body.nodes.rows.map((r) => [r.id, r]));
    expect(byId.get(linux)?.target).toBe("linux-x64");
    // An Intel Mac is a real population with no published artifact; the row
    // says so instead of guessing a nearby triple.
    expect(byId.get(intel)?.target).toBeNull();
  });

  it("never lists `local` — the control-plane host updates with the server", async () => {
    const body = await read(fx.adminCookie);
    expect(body.nodes.rows.some((r) => r.id === "local")).toBe(false);
  });

  it("carries a held node's reason and its version from the socket that was refused", async () => {
    const id = await agent({ name: `upd-held-${crypto.randomUUID()}`, version: null });
    adminUpdatesSeams.getHeldRows = () => [
      {
        nodeId: id,
        reason: "protocol-mismatch",
        agentVersion: "0.4.0",
        protocolVersion: 8,
        os: "linux",
        arch: "arm64",
      },
    ];
    const row = (await read(fx.adminCookie)).nodes.rows.find((r) => r.id === id);
    expect(row?.held).toEqual({ reason: "protocol-mismatch" });
    // A machine that never completed a `ready` has nothing on its row, so the
    // held entry is the only place these facts exist.
    expect(row?.agentVersion).toBe("0.4.0");
    expect(row?.target).toBe("linux-arm64");
  });

  it("offers no node update while the release source is off, and says why on every row", async () => {
    await agent({ name: `upd-reason-${crypto.randomUUID()}`, version: "0.8.0" });
    for (const row of (await read(fx.adminCookie)).nodes.rows) {
      expect(row.canUpdate.ok).toBe(false);
      expect(row.canUpdate.reason).toBeTruthy();
    }
  });

  it("is admin-only and refuses bearer keys", async () => {
    expect((await app.fetch(authedRequest("/api/admin/updates", fx.userCookie))).status).toBe(403);
    expect((await app.fetch(bearerRequest("/api/admin/updates", fx.bearer))).status).toBe(403);
  });

  // ── with an offerable release ────────────────────────────────────────────
  //
  // The version verdicts only exist once `rels.node` is non-null, which needs
  // a compatible SIGNED release. Same fake source and pinned verifier as
  // `nodes/__tests__/update-node.route.test.ts`: the real minisign crypto is
  // pinned once in the protocol package, and what these cases check is the
  // ROW's answer when the release side is fine.

  describe("with an offerable release", () => {
    const RELEASE_VERSION = "9.9.9";
    const TEST_ARMOR = "TEST-ARMOR";
    const realVerify = { ...releaseSeams };
    let release: ReturnType<typeof Bun.serve> | undefined;

    const acceptSigned: typeof verifyReleaseManifest = async (bytes, sig, _pub, expected) => {
      const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
      if (parsed === null) return { ok: false, reason: "test: the bytes are not a manifest" };
      if (sig.trim() !== TEST_ARMOR) return { ok: false, reason: "test: signature refused" };
      if (parsed.component !== expected.component || parsed.version !== expected.version) {
        return { ok: false, reason: `test: payload names ${parsed.component} ${parsed.version}` };
      }
      return { ok: true, manifest: parsed };
    };

    beforeAll(async () => {
      release = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/releases") {
            const base = `http://127.0.0.1:${release?.port}`;
            return Response.json([
              {
                tag_name: `cli-node-v${RELEASE_VERSION}`,
                draft: false,
                published_at: "2026-09-15T00:00:00Z",
                assets: [
                  { name: "release-manifest.json", browser_download_url: `${base}/manifest` },
                  { name: "release-manifest.json.sig", browser_download_url: `${base}/sig` },
                  { name: "subshell-node-cli-linux-x64", browser_download_url: `${base}/bin` },
                ],
              },
            ]);
          }
          if (url.pathname === "/manifest") {
            return Response.json({
              component: "cli-node",
              version: RELEASE_VERSION,
              nodeProtocol: NODE_PROTOCOL_VERSION,
              minNodeVersion: "0.9.0",
              commit: "deadbeef",
              assets: { "subshell-node-cli-linux-x64": "a".repeat(64) },
            });
          }
          if (url.pathname === "/sig") return new Response(TEST_ARMOR);
          return new Response("no", { status: 404 });
        },
      });
      releaseSeams.verifyManifest = acceptSigned;
      setReleaseUrlForTests(`http://127.0.0.1:${release.port}/releases`);
      resetReleaseCacheForTests();
    });

    afterAll(() => {
      Object.assign(releaseSeams, realVerify);
      release?.stop(true);
      setReleaseUrlForTests(null);
      resetReleaseCacheForTests();
    });

    it("refuses a row already on the offered release, and offers no update either", async () => {
      // The operator-reported bug: the button stayed live for a node already
      // current, and pressing it re-downloaded and reinstalled the same binary.
      const id = await agent({ name: `upd-equal-${crypto.randomUUID()}`, version: RELEASE_VERSION });
      const row = (await read(fx.adminCookie)).nodes.rows.find((r) => r.id === id);
      expect(row?.updateAvailable).toBe(false);
      expect(row?.canUpdate).toEqual({
        ok: false,
        reason: `already running ${RELEASE_VERSION}, the newest release this server can offer`,
      });
    });

    it("says a row AHEAD of the offer is ahead, not that it can go backwards", async () => {
      const id = await agent({ name: `upd-ahead-${crypto.randomUUID()}`, version: "99.0.0" });
      const row = (await read(fx.adminCookie)).nodes.rows.find((r) => r.id === id);
      expect(row?.updateAvailable).toBe(false);
      expect(row?.canUpdate).toEqual({
        ok: false,
        reason: "running 99.0.0, newer than the newest release this server can offer (9.9.9)",
      });
    });

    it("never refuses a row for a version it never got: an update may fix the ignorance", async () => {
      // No `ready` ever, so no version anywhere; held on a protocol that
      // supports signed updates, so everything else about it says updatable.
      const id = await agent({ name: `upd-unreported-${crypto.randomUUID()}`, version: null });
      adminUpdatesSeams.getHeldRows = () => [
        {
          nodeId: id,
          reason: "protocol-mismatch",
          agentVersion: null,
          protocolVersion: NODE_SIGNED_UPDATES_PROTOCOL_VERSION,
          os: "linux",
          arch: "x64",
        },
      ];
      const row = (await read(fx.adminCookie)).nodes.rows.find((r) => r.id === id);
      expect(row?.agentVersion).toBeNull();
      expect(row?.canUpdate).toEqual({ ok: true, reason: null });
    });
  });
});

import {
  hostReleaseTarget,
  MIN_NODE_VERSION,
  NODE_PROTOCOL_VERSION,
  NODE_SIGNED_UPDATES_PROTOCOL_VERSION,
  semverLt,
} from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { ReleaseRefSchema, ServerUpdateViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { isNodeOffline, listHeld } from "@/services/nodes/node-registry.js";
import { compatibleNodeRelease, releaseSourceUrl, resolveReleases } from "@/services/releases.js";
import { collectServerUpdateView, type ReleaseRef, releaseRef } from "@/services/server-update.js";

/**
 * `GET /api/admin/updates` — everything the Updates page renders, in ONE read
 * (spec 2026-09-15 §4.6).
 *
 * One route rather than four because the page is one question asked of four
 * things ("what on this instance is behind?"), and because every answer comes
 * out of the SAME release index: splitting it would make the page fetch that
 * index four times to render three cards, and leave the cards disagreeing
 * about `checkedAt` while they resolved.
 *
 * `local` is absent from `nodes.rows` by construction — the control-plane
 * host's update IS the server's, which is the card above.
 */

/** Why a stale node is being kept connected for one command. */
export interface HeldRow {
  nodeId: string;
  reason: "below-floor" | "protocol-mismatch";
  agentVersion: string | null;
  protocolVersion: number | null;
  os: string | null;
  arch: string | null;
}

/**
 * Test seams, and the ONE place the registry's held map is read (spec
 * 2026-09-15 §5.3): a node the plane refused for its version or protocol is
 * held open for exactly the `update` command, and this is where the page
 * learns which rows those are.
 *
 * @internal
 */
export const adminUpdatesSeams = {
  getHeldRows: (): HeldRow[] => listHeld(),
};

const NodeUpdateRowSchema = t.Object({
  id: t.String({ description: "Node id" }),
  name: t.String({ description: "The node's display name" }),
  agentVersion: t.Nullable(t.String(), { description: "Last-known subshell version, or null before the first ready" }),
  target: t.Nullable(t.String(), {
    description:
      "The release triple for this machine's reported os/arch (linux-x64, linux-arm64, darwin-arm64), or null when no artifact is published for it",
  }),
  protocolVersion: t.Nullable(t.Number(), {
    description: "The node protocol this machine speaks; null before the first ready. Reads with `nodes.protocol`",
  }),
  online: t.Boolean({ description: "Whether the node holds a live socket right now" }),
  held: t.Nullable(
    t.Object({
      reason: t.Union([t.Literal("below-floor"), t.Literal("protocol-mismatch")], {
        description: "Which gate refused this node",
      }),
    }),
    { description: "Set when the node was refused but is being kept connected so it can be updated" },
  ),
  updateAvailable: t.Boolean({ description: "Whether the offered node release is newer than this machine's version" }),
  canUpdate: t.Object(
    {
      ok: t.Boolean({ description: "Whether this row's Update button is live" }),
      reason: t.Nullable(t.String(), { description: "Why it is not, in a sentence the row renders verbatim" }),
    },
    { description: "Whether this node can be updated from here" },
  ),
});

const AdminUpdatesSchema = t.Object({
  server: ServerUpdateViewSchema,
  nodes: t.Object(
    {
      release: t.Nullable(ReleaseRefSchema, {
        description: "The newest node release this server can talk to (protocol match), or null",
      }),
      reason: t.Nullable(t.String(), { description: "Why no node release can be offered; null when one can" }),
      // Both numbers travel with the rows rather than being fetched from
      // `GET /api/admin/status`: a held row's whole sentence is a COMPARISON
      // ("speaks protocol 9, this server speaks 10"), and half a comparison
      // arriving from a second query is how a page renders "speaks protocol 9,
      // this server speaks undefined" for one paint.
      minNodeVersion: t.String({ description: "The oldest node version this server will accept on /ws/node" }),
      protocol: t.Number({ description: "The node protocol this server speaks; nodes must match it EXACTLY" }),
      rows: t.Array(NodeUpdateRowSchema, { description: "Every enrolled node; `local` is never here" }),
    },
    { description: "The fleet, and what it could be updated to" },
  ),
  desktop: t.Object(
    {
      server: t.Nullable(ReleaseRefSchema, { description: "The newest Subshell Server desktop release, or null" }),
      client: t.Nullable(ReleaseRefSchema, { description: "The newest Subshell Client desktop release, or null" }),
    },
    { description: "The two desktop apps' newest releases, for the rows that link to them" },
  ),
});

/** The node release this plane may hand a machine, and the desktop pair, from one index read. */
async function releases(): Promise<{
  node: ReleaseRef | null;
  nodeReason: string | null;
  desktopServer: ReleaseRef | null;
  desktopClient: ReleaseRef | null;
}> {
  if (releaseSourceUrl() === null) {
    return {
      node: null,
      nodeReason: "no release source is configured (SUBSHELL_RELEASE_URL is empty)",
      desktopServer: null,
      desktopClient: null,
    };
  }
  try {
    const [index, compatible] = await Promise.all([resolveReleases(), compatibleNodeRelease()]);
    return {
      node: releaseRef(compatible.release),
      nodeReason: compatible.reason,
      desktopServer: releaseRef(index.byComponent["desktop-server"]),
      desktopClient: releaseRef(index.byComponent["desktop-client"]),
    };
  } catch (error) {
    // The page renders either way and says what it could not read; the Server
    // card carries the same failure in its own `latestError`.
    const reason = error instanceof Error ? error.message : String(error);
    return { node: null, nodeReason: reason, desktopServer: null, desktopClient: null };
  }
}

export const adminUpdatesRoutes = new Elysia({ prefix: "/api/admin" }).use(requireAdmin).get(
  "/updates",
  async () => {
    const [server, rels, nodes] = await Promise.all([
      collectServerUpdateView(),
      releases(),
      new NodesRepository(db).listAgents(),
    ]);
    const held = new Map(adminUpdatesSeams.getHeldRows().map((row) => [row.nodeId, row]));

    const rows = nodes.map((node) => {
      const heldRow = held.get(node.id) ?? null;
      // A held node's os/arch come from the socket it was refused on, because
      // a machine that has never completed a `ready` has none on its row.
      const os = node.os ?? heldRow?.os ?? null;
      const arch = node.arch ?? heldRow?.arch ?? null;
      const target = os === null || arch === null ? null : hostReleaseTarget(os, arch);
      const agentVersion = node.agentVersion ?? heldRow?.agentVersion ?? null;
      const online = !isNodeOffline(node.id);
      return {
        id: node.id,
        name: node.name,
        agentVersion,
        target,
        protocolVersion: node.protocolVersion ?? heldRow?.protocolVersion ?? null,
        online,
        held: heldRow === null ? null : { reason: heldRow.reason },
        updateAvailable: rels.node !== null && agentVersion !== null && semverLt(agentVersion, rels.node.version),
        canUpdate: canUpdate(
          rels,
          target,
          agentVersion,
          online,
          heldRow !== null,
          node.protocolVersion ?? heldRow?.protocolVersion ?? null,
        ),
      };
    });

    return {
      server,
      nodes: {
        release: rels.node,
        reason: rels.nodeReason,
        minNodeVersion: MIN_NODE_VERSION,
        protocol: NODE_PROTOCOL_VERSION,
        rows,
      },
      desktop: { server: rels.desktopServer, client: rels.desktopClient },
    };
  },
  {
    response: AdminUpdatesSchema,
    detail: {
      operationId: "getAdminUpdates",
      tags: ["admin"],
      description:
        "Everything the Updates page renders: this server's own update view, the node release this plane can offer plus one row per enrolled node, and the two desktop apps' newest releases. Cookie-admin only; bearer keys are refused.",
    },
  },
);

/**
 * Whether a row's Update button may be pressed, and when not, the most USEFUL
 * reason rather than merely the first.
 *
 * A node that is offline AND on an unpublished platform is told about the
 * platform: reconnecting is something a person may be about to do, and being
 * told "offline" and then, a minute later, "no artifact for this machine" is
 * two trips to learn one fact. A HELD node counts as reachable — being held
 * is precisely being reachable for this one verb.
 *
 * The protocol check sits AFTER the release/platform facts and BEFORE
 * offline, in spec 2026-09-17 §6's words: a node below
 * {@link NODE_SIGNED_UPDATES_PROTOCOL_VERSION} would ignore the
 * `manifest`/`manifestSig` the command now carries, so it cannot be updated
 * from here no matter what else is true — and unlike "offline" that answer
 * does not fix itself when the machine next dials in.
 *
 * The up-to-date answer ranks ABOVE the protocol refusal: it says there is
 * nothing to do, while the protocol sentence describes how to do something
 * nobody needs done. A node that never reported a version is never refused
 * for it: an update may be exactly what fixes the ignorance.
 */
function canUpdate(
  rels: { node: ReleaseRef | null; nodeReason: string | null },
  target: string | null,
  agentVersion: string | null,
  online: boolean,
  isHeld: boolean,
  protocolVersion: number | null,
): { ok: true; reason: null } | { ok: false; reason: string } {
  if (rels.node === null) return { ok: false, reason: rels.nodeReason ?? "no node release can be offered" };
  if (target === null) return { ok: false, reason: "no node binary is published for this machine's platform" };
  if (rels.node !== null && agentVersion !== null && !semverLt(agentVersion, rels.node.version)) {
    // Equality spelled as two failing `semverLt`s, so semver normalization
    // (a `v` prefix, a dropped `-beta`) cannot make "equal" read as "ahead".
    const equal = !semverLt(rels.node.version, agentVersion);
    return equal
      ? { ok: false, reason: `already running ${agentVersion}, the newest release this server can offer` }
      : {
          ok: false,
          reason: `running ${agentVersion}, newer than the newest release this server can offer (${rels.node.version})`,
        };
  }
  if (protocolVersion === null || protocolVersion < NODE_SIGNED_UPDATES_PROTOCOL_VERSION) {
    return { ok: false, reason: "node predates signed updates" };
  }
  if (!online && !isHeld) return { ok: false, reason: "this node is offline" };
  return { ok: true, reason: null };
}

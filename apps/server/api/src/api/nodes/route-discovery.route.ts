import type { LinkKeyPair } from "@internal/subshell-protocol/node-link-crypto";
import {
  isPrivateNodeRoute,
  NODE_ROUTE_LIMIT,
  NODE_ROUTE_MAX_BYTES,
  openRouteRequest,
  type RouteEnvelope,
} from "@internal/subshell-protocol/node-route";
import { Elysia, t } from "elysia";
import { authenticateNodeUpgrade, getNodeWsDeps, type NodeWsDeps } from "@/api/ws/node-ws-handler.js";
import { HOST, SERVER_PORT } from "@/constants.js";
import { lanOrigins } from "@/modules/network/lan-origins.js";
import { loadNodeEncryptionKeys } from "@/modules/nodes/node-encryption-keys.js";
import { nodeRouteTickets } from "@/modules/nodes/route-tickets.js";
import { HttpError } from "@/shared/errors.js";

const RouteEnvelopeSchema = t.Object({
  ephemeral: t.String({ minLength: 1, maxLength: 64 }),
  ciphertext: t.String({ minLength: 1, maxLength: NODE_ROUTE_MAX_BYTES }),
});
interface RouteRequest {
  purpose: "node-route-v1";
  nodeKey: string;
  nodeId: string;
  nodePublicKey: string;
}

function isRouteRequest(value: unknown): value is RouteRequest {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.purpose === "node-route-v1" &&
    typeof row.nodeKey === "string" &&
    row.nodeKey.length > 0 &&
    row.nodeKey.length <= 4096 &&
    typeof row.nodeId === "string" &&
    row.nodeId.length > 0 &&
    row.nodeId.length <= 128 &&
    typeof row.nodePublicKey === "string" &&
    row.nodePublicKey.length > 0 &&
    row.nodePublicKey.length <= 64
  );
}

export interface RouteDiscoveryDeps {
  keys(): Promise<LinkKeyPair>;
  auth: Pick<NodeWsDeps, "verifyApiKey" | "nodes" | "accountDisabled">;
  origins(): string[];
}

function discoveryDeps(): RouteDiscoveryDeps {
  return {
    keys: loadNodeEncryptionKeys,
    auth: getNodeWsDeps(),
    origins: () => {
      const origins = lanOrigins(SERVER_PORT, HOST);
      if (!["0.0.0.0", "::", "[::]", "*"].includes(HOST)) origins.push(`http://${HOST}:${SERVER_PORT}`);
      return origins;
    },
  };
}

/** No socket opens during a probe, so it cannot supersede an attached node. */
export async function discoverNodeRoute(
  envelope: RouteEnvelope,
  deps: RouteDiscoveryDeps = discoveryDeps(),
): Promise<string> {
  let request: Awaited<ReturnType<typeof openRouteRequest>>;
  try {
    request = await openRouteRequest(await deps.keys(), envelope);
  } catch {
    throw new HttpError(401, "Could not verify this node connection");
  }
  if (!isRouteRequest(request.payload)) throw new HttpError(401, "Invalid node connection request");
  const payload = request.payload;
  const identity = await authenticateNodeUpgrade(deps.auth, `Bearer ${payload.nodeKey}`);
  if (
    identity.nodeId !== payload.nodeId ||
    identity.linkMode !== "handshake" ||
    identity.linkEncryptPublicKey !== payload.nodePublicKey
  ) {
    throw new HttpError(403, "The node must be paired before choosing a connection route");
  }
  const origins = deps.origins();
  const candidates = [...new Set(origins.map((origin) => `${origin.replace(/^http:/, "ws:")}/ws/node`))]
    .filter(isPrivateNodeRoute)
    .slice(0, NODE_ROUTE_LIMIT);
  return request.sealReply({
    purpose: "node-route-v1",
    candidates,
    ticket: nodeRouteTickets.issue(payload.nodeKey, payload.nodePublicKey),
  });
}

export function createRouteDiscoveryRoute(deps?: RouteDiscoveryDeps) {
  return new Elysia().post(
    "/route",
    ({ body, set }) => {
      set.headers["Cache-Control"] = "no-store";
      return discoverNodeRoute(body, deps);
    },
    { body: RouteEnvelopeSchema },
  );
}

export const routeDiscoveryRoute = createRouteDiscoveryRoute();

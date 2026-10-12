/** Authenticated route discovery reuses the node link's pinned-key encryption. */
import { createClientSession, createServerSession, ensureSodium, type LinkKeyPair } from "./node-link-crypto.js";

export const NODE_ROUTE_PATH = "/api/nodes/route";
export const NODE_ROUTE_LIMIT = 8;
export const NODE_ROUTE_MAX_BYTES = 16 * 1024;
export const NODE_ROUTE_TICKET_MS = 15_000;

export interface RouteEnvelope {
  ephemeral: string;
  ciphertext: string;
}

/** A fresh session per HTTP request prevents a reply from another probe authenticating this one. */
export async function sealRouteRequest(
  serverKey: string,
  payload: unknown,
): Promise<{
  envelope: RouteEnvelope;
  openReply(ciphertext: string): unknown;
}> {
  const sodium = await ensureSodium();
  const { session, ephemeralPublicKey } = await createClientSession({ serverStaticPublicKey: serverKey });
  return {
    envelope: {
      ephemeral: ephemeralPublicKey,
      ciphertext: sodium.to_base64(session.sealFrame(JSON.stringify(payload))),
    },
    openReply(ciphertext) {
      if (ciphertext.length > NODE_ROUTE_MAX_BYTES) throw new Error("Route reply is too large");
      const plaintext = session.openFrame(sodium.from_base64(ciphertext));
      if (plaintext === null) throw new Error("Route reply did not match the pinned control plane");
      return JSON.parse(plaintext);
    },
  };
}

export async function openRouteRequest(
  keys: LinkKeyPair,
  envelope: RouteEnvelope,
): Promise<{
  payload: unknown;
  sealReply(payload: unknown): string;
}> {
  if (envelope.ephemeral.length > 64 || envelope.ciphertext.length > NODE_ROUTE_MAX_BYTES) {
    throw new Error("Route request is too large");
  }
  const sodium = await ensureSodium();
  const session = await createServerSession({ serverStatic: keys, clientEphemeralPublicKey: envelope.ephemeral });
  const plaintext = session.openFrame(sodium.from_base64(envelope.ciphertext));
  if (plaintext === null) throw new Error("Invalid route request");
  return {
    payload: JSON.parse(plaintext),
    sealReply: (payload) => sodium.to_base64(session.sealFrame(JSON.stringify(payload))),
  };
}

/** Automatic probes only reach literal private IPv4/mesh addresses, never arbitrary advertised hosts. */
export function isPrivateNodeRoute(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "ws:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/ws/node"
    ) {
      return false;
    }
    const octets = url.hostname.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = octets;
    return (
      a === 10 ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127)
    );
  } catch {
    return false;
  }
}

/** Preserve an operator's proxy prefix when discovering through their configured WebSocket endpoint. */
export function routeDiscoveryUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  if (!["ws:", "wss:"].includes(url.protocol) || !url.pathname.endsWith("/ws/node") || url.username || url.password) {
    throw new Error("Unsupported node route");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.slice(0, -"/ws/node".length) + NODE_ROUTE_PATH;
  url.search = "";
  url.hash = "";
  return url.href;
}

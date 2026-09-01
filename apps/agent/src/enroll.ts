import { hostname } from "node:os";
import { join } from "node:path";
import { agentHome, saveConfig } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { AGENT_VERSION } from "./version.js";

/**
 * The control plane's os vocabulary — mirrors the `t.Literal` set of
 * EnrollBodySchema in apps/backend/src/api/nodes/enroll.route.ts (which in turn
 * mirrors the `ready` frame validator). Anything else must map to "unknown";
 * inventing a value here gets the enroll rejected with a 400.
 */
export type NodeOs = "linux" | "darwin" | "unknown";

/** Maps a runtime platform string onto {@link NodeOs}. */
export function mapOs(platform: string): NodeOs {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  return "unknown";
}

/** Inputs for one enrollment attempt. */
export interface EnrollOptions {
  /** Control-plane base URL (`--server`), http(s). */
  server: string;
  /** One-time `nsk_…` setup key (`--key`). */
  setupKey: string;
  /** Display name; defaults to the hostname. */
  name?: string;
  /** Data dir for the identity keypair; defaults to `<MOTE_AGENT_HOME>/data`. */
  dataDir?: string;
}

const ENROLL_TIMEOUT_MS = 30_000;

/**
 * Redeems a setup key into an enrolled node: tmux preflight → identity keypair
 * → `POST /api/nodes/enroll` → 0600 config write. Throws an actionable `Error`
 * on any failure; on failure NOTHING is persisted as config (the identity file
 * is allowed to pre-exist — it is only created, never overwritten, here).
 */
export async function runEnroll(opts: EnrollOptions): Promise<{ nodeId: string }> {
  assertTmux(); // BEFORE any network call — an unenrollable box shouldn't burn a setup key
  const serverUrl = normalizeServer(opts.server);
  const name = opts.name?.trim() || hostname();
  const dataDir = opts.dataDir ?? join(agentHome(), "data");
  const identity = await loadOrCreateIdentity(dataDir);

  const body = {
    setupKey: opts.setupKey,
    name,
    os: mapOs(process.platform),
    arch: process.arch,
    hostname: hostname(),
    agentVersion: AGENT_VERSION,
    publicKey: identity.publicJwk,
  };

  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/nodes/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`cannot reach the control plane at ${serverUrl}: ${(err as Error).message}`);
  }
  if (res.status !== 201) throw await enrollFailure(res, name);

  const ok = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const nodeId = typeof ok?.nodeId === "string" ? ok.nodeId : undefined;
  const nodeKey = typeof ok?.nodeKey === "string" ? ok.nodeKey : undefined;
  const controlPublicKey = typeof ok?.controlPublicKey === "string" ? ok.controlPublicKey : undefined;
  if (!nodeId || !nodeKey || !controlPublicKey) {
    throw new Error("enroll succeeded but the response was malformed — the setup key is spent; contact the operator");
  }

  await saveConfig({ serverUrl, nodeId, nodeKey, controlPublicKey, dataDir, name });
  return { nodeId };
}

/** The node can't run anything without tmux — refuse before touching the network. */
function assertTmux(): void {
  if (process.env.MOTE_AGENT_SKIP_TMUX_CHECK === "1") return;
  // @types/bun 1.3.14 omits `.error` from the spawnSync result type; Bun sets it
  // (ENOENT etc.) while `exitCode` stays null — runtime field, untyped.
  const probe = Bun.spawnSync(["tmux", "-V"]) as ReturnType<typeof Bun.spawnSync> & { error?: Error };
  if (probe.error) {
    const hint = process.platform === "darwin" ? " — on macOS: brew install tmux" : "";
    throw new Error(`tmux not found${hint}; install it and retry (escape hatch: MOTE_AGENT_SKIP_TMUX_CHECK=1)`);
  }
}

function normalizeServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--server must be a full URL (e.g. https://mote.example:5173), got '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--server must be http(s), got '${raw}'`);
  }
  return raw.replace(/\/+$/, "");
}

/** Turns a non-201 into the actionable message the operator needs (spec §5.2 error map). */
async function enrollFailure(res: Response, name: string): Promise<Error> {
  let serverMessage = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") serverMessage = body.message;
  } catch {
    /* body wasn't JSON — the status code still carries the meaning */
  }
  if (res.status === 401) {
    return new Error(
      "setup key is invalid, expired, or already used — mint a fresh one under Settings → Node setup keys",
    );
  }
  if (res.status === 409) {
    return new Error(serverMessage || `a node named '${name}' already exists — pass --name to pick another`);
  }
  return new Error(`enroll failed (HTTP ${res.status})${serverMessage ? `: ${serverMessage}` : ""}`);
}

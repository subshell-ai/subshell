import { hostname } from "node:os";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
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

/** Mirrors the `name` maxLength of EnrollBodySchema (apps/backend/src/api/nodes/enroll.route.ts). */
const MAX_NAME_LEN = 64;

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
  // Pre-flight the name cap BEFORE touching the identity/network: a hostname
  // like `some-box.internal.example.org` plus suffix can exceed it, and burning
  // a one-time setup key to learn that is a bad day. (Only the name is
  // pre-checked here; everything else stays the server's call.)
  if (name.length > MAX_NAME_LEN) {
    throw new Error(
      opts.name?.trim()
        ? `--name is ${name.length} characters — the control plane accepts at most ${MAX_NAME_LEN}; pass a shorter --name`
        : `the default node name (hostname '${name}') is ${name.length} characters — at most ${MAX_NAME_LEN} are accepted; pass --name <short-name>`,
    );
  }
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
  // Ledger 17c (P1-T12 carry): persist the SERVER-REPORTED dial URL. Tolerant
  // by design — a pre-17c control plane omits it and the daemon falls back to
  // deriving from `serverUrl`; we never treat its absence as malformed. An
  // EMPTY string is treated like absence too: "" would pin the daemon to a
  // dead dial target, while derivation from `serverUrl` at least dials home.
  const nodeWsUrl = typeof ok?.wsUrl === "string" && ok.wsUrl !== "" ? ok.wsUrl : undefined;

  await saveConfig({ serverUrl, nodeId, nodeKey, controlPublicKey, dataDir, name, nodeWsUrl });
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

/**
 * Maps a 401 from the enroll route onto per-state operator copy. Post-Task-17
 * the route sends structured bodies (`ApiErrorResponse`) with one of
 * `SETUP_KEY_INVALID` / `SETUP_KEY_CONSUMED` / `SETUP_KEY_EXPIRED`; the two
 * "definitely spent" states get their own advice (telling someone whose key
 * was already redeemed to "mint a fresh one" hides that the enrollment
 * already succeeded somewhere). Everything else — the generic INVALID, an
 * unknown code from a newer server, a bodyless/message-only 401 from an older
 * one — answers with the original sentence verbatim, so the CLI stays
 * forward- and backward-compatible.
 */
function setupKeyFailure(body: Record<string, unknown> | null): Error {
  const code = typeof body?.code === "string" ? body.code : undefined;
  if (code === BackendErrorCodes.SETUP_KEY_CONSUMED) {
    return new Error(
      "this setup key has already been used — each key enrolls one node; create a new setup key on the Nodes page",
    );
  }
  if (code === BackendErrorCodes.SETUP_KEY_EXPIRED) {
    return new Error("this setup key expired (they are valid 24 hours) — create a new one on the Nodes page");
  }
  return new Error("setup key is invalid, expired, or already used — mint a fresh one on the Nodes page");
}

/** Turns a non-201 into the actionable message the operator needs (spec §5.2 error map). */
async function enrollFailure(res: Response, name: string): Promise<Error> {
  let serverMessage = "";
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
    if (typeof body.message === "string") serverMessage = body.message;
  } catch {
    /* body wasn't JSON — the status code still carries the meaning */
  }
  if (res.status === 401) return setupKeyFailure(body);
  if (res.status === 409) {
    return new Error(serverMessage || `a node named '${name}' already exists — pass --name to pick another`);
  }
  return new Error(
    `enroll failed (HTTP ${res.status})${serverMessage ? `: ${serverMessage}` : ""}${validationDetails(body)}`,
  );
}

/**
 * Renders the field-level failures of a `400 INPUT_VALIDATION_ERROR` body into a
 * suffix like `; invalid input — setupKey: Expected string length greater or
 * equal to 8`. The shape mirrors the server: the VALIDATION branch of
 * apps/backend/src/plugins/error-handler.plugin.ts puts Elysia's `error.all`
 * items under `validationError.validation[]`, each carrying a JSON-pointer
 * `path` ("/name") and a human `message`. Field names only — never the offending
 * values (a rejected `publicKey` echo would be noise, a rejected key would be a
 * secret).
 */
function validationDetails(body: Record<string, unknown> | null): string {
  const validation = (body?.validationError as { validation?: unknown } | undefined)?.validation;
  if (!Array.isArray(validation) || validation.length === 0) return "";
  const parts = validation.map((raw) => {
    const item = raw as { path?: unknown; message?: unknown };
    const field = typeof item.path === "string" ? (item.path.replace(/^#?\//, "").split("/").pop() ?? "?") : "?";
    const message = typeof item.message === "string" ? item.message : "invalid value";
    return `${field}: ${message}`;
  });
  return `; invalid input — ${parts.join("; ")}`;
}

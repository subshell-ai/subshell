import { hostname } from "node:os";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_NAME_MAX, normalizeNodeName } from "@internal/subshell-protocol";
import { generateLinkKeyPair } from "@internal/subshell-protocol/node-link-crypto";
import { clientHome, saveConfig } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { NODE_VERSION } from "./version.js";

/**
 * The control plane's os vocabulary — mirrors the `t.Literal` set of
 * EnrollBodySchema in apps/server/api/src/api/nodes/enroll.route.ts (which in turn
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
  /**
   * Display name for the node, and REQUIRED. Nothing here guesses it: the old
   * hostname default is gone with the 2026-09-17 node-setup revamp, because the
   * machine is where the name is known — `setup` ASKS, `--name` answers for a
   * script, and a nameless pipe is a refusal rather than a hostname nobody chose.
   */
  name: string;
  /** Data dir for the identity keypair; defaults to `<SUBSHELL_CONFIG_HOME>/data`. */
  dataDir?: string;
}

/**
 * What a completed enrollment persisted. Everything here is a fact the enroll
 * RESOLVED (the normalized server URL, the defaulted name, the defaulted data
 * dir) rather than what the caller passed, so `subshell enroll --json` can
 * report the config without re-deriving any of it — and deliberately WITHOUT
 * the nodeKey, which the 0600 config file is the only home for.
 */
export interface EnrollResult {
  /** Server-assigned node id (uuid). */
  nodeId: string;
  /** Control-plane base URL as normalized and persisted. */
  serverUrl: string;
  /** Node display name actually stored (the normalized `--name`). */
  name: string;
  /** Data dir the identity keypair and runtime state live in. */
  dataDir: string;
}

const ENROLL_TIMEOUT_MS = 30_000;

/**
 * Redeems a setup key into an enrolled node: tmux preflight → identity keypair
 * → `POST /api/nodes/enroll` → 0600 config write. Throws an actionable `Error`
 * on any failure; on failure NOTHING is persisted as config (the identity file
 * is allowed to pre-exist — it is only created, never overwritten, here).
 */
export async function runEnroll(opts: EnrollOptions): Promise<EnrollResult> {
  assertTmux(); // BEFORE any network call — an unenrollable box shouldn't burn a setup key
  const serverUrl = normalizeServer(opts.server);
  // Pre-flight the NAME before touching the identity/network, for the reason the
  // cap check always had: burning a one-time setup key to learn the body was
  // unusable is a bad day. It now carries a second job — this is the last place
  // that can still say "you never named this machine" before the plane does.
  // Both rules are the control plane's own, imported rather than mirrored: the
  // cap is NODE_NAME_MAX and the shape is normalizeNodeName, so a name cannot be
  // stored differently depending on whether it came from --name, setup's prompt
  // or the desktop field. (Everything else stays the server's call.)
  // Counted in CODE POINTS, the unit the shared cap counts. `String.prototype.length`
  // is UTF-16 units, which would refuse a 40-emoji name here while the desktop field,
  // Rust's `chars().count()` and `normalizeNodeName` itself all called it 40 — four
  // doors agreeing on the constant and disagreeing on how to measure it is worse than
  // two constants.
  const raw = opts.name.trim();
  const nameLength = [...raw].length;
  if (nameLength > NODE_NAME_MAX) {
    throw new Error(
      `--name is ${nameLength} characters; the control plane accepts at most ${NODE_NAME_MAX}, so pass a shorter --name`,
    );
  }
  const name = normalizeNodeName(raw);
  if (name === "") {
    throw new Error("a node name needs at least one printable character — pass --name <name>");
  }
  const dataDir = opts.dataDir ?? join(clientHome(), "data");
  const identity = await loadOrCreateIdentity(dataDir);

  // The link-encryption static (spec 2026-09-24 §3): generated per enroll, a
  // fresh identity for the encrypted link — the post-14 server compares the
  // handshake's claim against the public half it stores from THIS body. Its
  // private half goes only into the 0600 config, like `nodeKey`.
  const link = await generateLinkKeyPair();

  const body = {
    setupKey: opts.setupKey,
    name,
    os: mapOs(process.platform),
    arch: process.arch,
    hostname: hostname(),
    agentVersion: NODE_VERSION,
    publicKey: identity.publicJwk,
    encryptPublicKey: link.publicKey,
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
  // REQUIRED, not tolerated-absent (ruling R1): this binary speaks protocol 14,
  // and enrolling without the link pin would silently provision a node that
  // cannot open an encrypted socket. A plane that omits it is too old to talk
  // to this agent at all, so its absence reads exactly like a missing
  // `controlPublicKey` — malformed, key already spent, contact the operator.
  const controlEncryptPublicKey =
    typeof ok?.controlEncryptPublicKey === "string" ? ok.controlEncryptPublicKey : undefined;
  if (!nodeId || !nodeKey || !controlPublicKey || !controlEncryptPublicKey) {
    throw new Error("enroll succeeded but the response was malformed. The setup key is spent; contact the operator");
  }
  // Ledger 17c (P1-T12 carry): persist the SERVER-REPORTED dial URL. Tolerant
  // by design — a pre-17c control plane omits it and the daemon falls back to
  // deriving from `serverUrl`; we never treat its absence as malformed. An
  // EMPTY string is treated like absence too: "" would pin the daemon to a
  // dead dial target, while derivation from `serverUrl` at least dials home.
  const nodeWsUrl = typeof ok?.wsUrl === "string" && ok.wsUrl !== "" ? ok.wsUrl : undefined;

  await saveConfig({
    serverUrl,
    nodeId,
    nodeKey,
    controlPublicKey,
    encryptKeyPair: link,
    controlEncryptPublicKey,
    dataDir,
    name,
    nodeWsUrl,
  });
  return { nodeId, serverUrl, name, dataDir };
}

/**
 * The node can't run anything without tmux — refuse before touching the network.
 *
 * Exported so `setup` (cli.ts) can run the SAME preflight as its first step
 * rather than inheriting it as a side effect of {@link runEnroll}. One
 * function, so the refusal an operator reads is byte-identical whichever verb
 * they typed; a second copy is how the two sentences come to disagree.
 * @throws Error naming the platform's install hint and the escape hatch
 */
export function assertTmux(): void {
  if (process.env.SUBSHELL_CLIENT_SKIP_TMUX_CHECK === "1") return;
  // @types/bun 1.3.14 omits `.error` from the spawnSync result type; Bun sets it
  // (ENOENT etc.) while `exitCode` stays null — runtime field, untyped.
  const probe = Bun.spawnSync(["tmux", "-V"]) as ReturnType<typeof Bun.spawnSync> & { error?: Error };
  if (probe.error) {
    const hint = process.platform === "darwin" ? " (on macOS: brew install tmux)" : "";
    throw new Error(`tmux not found${hint}; install it and retry (escape hatch: SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1)`);
  }
}

/**
 * The ONE control-plane URL normalization: http(s) only, trailing slashes
 * stripped, otherwise stored exactly as typed. Shared with `configure.ts` —
 * a repoint must write the same spelling an enroll would, or the two commands
 * would disagree about the same address.
 */
export function normalizeServer(raw: string): string {
  // Trimmed FIRST, and that is load-bearing rather than tidy: the URL
  // constructor strips surrounding whitespace to parse, so a pasted
  // "  http://x  " validates — and the old `raw.replace(/\/+$/, "")` then
  // returned the padded string, because the trailing characters were spaces
  // rather than slashes. That padding reached `config.json`, and `wsUrlFor`
  // turned it into a dial URL with spaces in it. The Rust `validate_server_url`
  // that Subshell Client's GUI uses has always trimmed, so leaving it out here
  // made "one normalization" two.
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`--server must be a full URL (e.g. https://subshell.example:5173), got '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--server must be http(s), got '${raw}'`);
  }
  // Rebuilt from the parsed scheme and authority, which the URL parser has
  // already lower-cased, rather than returned raw.
  //
  // Returning the raw string preserved a mixed-case scheme, and `wsUrlFor`
  // derives the dial URL with `serverUrl.replace(/^http/, "ws")` — a
  // CASE-SENSITIVE regex. Measured: `HTTP://X:3080` was stored verbatim and
  // came out as `HTTP://X:3080/ws/node`, which is not a WebSocket URL at all,
  // so the node could never connect and nothing said why.
  //
  // The PATH is kept verbatim (minus trailing slashes) because a control plane
  // behind a reverse-proxy subpath is a real deployment and a path is
  // case-sensitive; a fragment is dropped, being meaningless for a server
  // address.
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`.replace(/\/+$/, "");
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
      "this setup key has already been used. Each key enrolls one node; create a new setup key on the Nodes page",
    );
  }
  if (code === BackendErrorCodes.SETUP_KEY_EXPIRED) {
    return new Error("this setup key expired (they are valid 24 hours). Create a new one on the Nodes page");
  }
  return new Error("setup key is invalid, expired, or already used. Mint a fresh one on the Nodes page");
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
    return new Error(serverMessage || `a node named '${name}' already exists; pass --name to pick another`);
  }
  return new Error(
    `enroll failed (HTTP ${res.status})${serverMessage ? `: ${serverMessage}` : ""}${validationDetails(body)}`,
  );
}

/**
 * Renders the field-level failures of a `400 INPUT_VALIDATION_ERROR` body into a
 * suffix like `; invalid input — setupKey: Expected string length greater or
 * equal to 8`. The shape mirrors the server: the VALIDATION branch of
 * apps/server/api/src/plugins/error-handler.plugin.ts puts Elysia's `error.all`
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
  return `; invalid input: ${parts.join("; ")}`;
}

import { ApiError, parseErrorBody } from "@internal/node-admin";

/**
 * The SPA-side mirror of the `/api/ssh-runtime` family (design 2026-10-05
 * §1/§7) plus the refusal-copy map the wizard renders. The wire shapes are
 * the route schemas; the named codes ride `metadataSafe.sshCode`, which the
 * shared `apiFetch` error path drops - so this file carries its own thin
 * fetch that keeps the code for the copy table. Everything else (cookies,
 * the JSON contract) matches `apiFetch` exactly.
 */

/** One session as the server answers it (`SshRuntimeSessionView`). */
export interface SshRuntimeSessionView {
  id: string;
  /** The broker's node id; null once that machine row has been deleted */
  connectingNodeId: string | null;
  runtimeNodeId: string;
  alias: string;
  host: string;
  port: number;
  user: string | null;
  status: "opening" | "active" | "lost" | "closed";
  hello: {
    runtimeProtocol: number;
    agentVersion: string;
    os: string;
    arch: string;
    capabilities: string[];
    homeDir: string;
    dataDir: string;
    tmuxSocket: string;
    paneCount: number;
  } | null;
  createdAt: string;
  lastSeenAt: string | null;
  closedAt: string | null;
}

/** `GET /api/ssh-runtime/discovery` - alias NAMES on a node, never config contents. */
export interface SshRuntimeDiscoveryView {
  aliases: string[];
  includeCycle: boolean;
  truncated: boolean;
}

/** `POST /api/ssh-runtime/resolve` - a named refusal is a 200, not a transport failure. */
export type SshRuntimeResolveView =
  | {
      accepted: true;
      snapshot: {
        alias: string;
        host: string;
        user: string | null;
        port: number;
        identityFiles: string[];
      };
      connectingAccount?: string;
    }
  | { accepted: false; code: string; settings: string[] };

/** `GET /api/ssh-runtime/sessions/by-pane/:id` - the pane's trusted identity line. */
export interface SshRuntimePaneIdentity {
  sessionId: string;
  status: SshRuntimeSessionView["status"];
  alias: string;
  host: string;
  port: number;
  user: string | null;
  connectingNodeName: string | null;
}

/** `POST /:id/list-dirs` - one destination directory, dirs only. */
export interface SshRuntimeListDirsResult {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; kind: "dir" }[];
  truncated: boolean;
}

/** An ApiError that kept the named SSH code (the copy table branches on it). */
export class SshApiError extends ApiError {
  readonly sshCode: string | undefined;
  constructor(status: number, body: string, meta: { code?: string; errId?: string; sshCode?: string }) {
    super(status, body, meta);
    this.sshCode = meta.sshCode;
  }
}

/** `apiFetch` with the sshCode preserved out of `metadataSafe` (its own error parse; same success path). */
export async function sshRuntimeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "Server unreachable");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const { message, code, errId } = parseErrorBody(body);
    let sshCode: string | undefined;
    try {
      const parsed = JSON.parse(body) as { metadataSafe?: { sshCode?: unknown } };
      const candidate = parsed?.metadataSafe?.sshCode;
      if (typeof candidate === "string") sshCode = candidate;
    } catch {
      // a non-JSON body has no code to keep
    }
    throw new SshApiError(res.status, message, { code, errId, sshCode });
  }
  return (await res.json()) as T;
}

/** The destination as review copy spells it: `user@host:port`, account omitted when it is the connecting default. */
export function destinationLabel(view: { host: string; port: number; user: string | null }): string {
  return `${view.user === null ? "" : `${view.user}@`}${view.host}:${view.port}`;
}

/**
 * The wizard's refusal sentence (design §7: errors name the remedy). The key
 * is equality on the named code, never prose parsing; the fallback is the
 * server's own message. Two sentences max, no em dashes, and the runtime
 * guidance names the BINARY only - never enrollment, never `subshell setup`.
 */
export function sshRuntimeErrorCopy(err: unknown, facts: { host: string; machine: string }): string {
  const code = err instanceof SshApiError ? err.sshCode : undefined;
  switch (code) {
    case "runtime_missing":
      return `Install the Subshell binary on ${facts.host}, then connect again. This machine's SSH already reaches the account.`;
    case "session_protocol":
      return `The runtime on ${facts.host} speaks a protocol this server does not share. Update the Subshell binary there.`;
    case "session_quota":
      return `${facts.machine} already carries its share of open sessions. Close one of them and try again.`;
    case "host_key_unknown":
    case "host_key_changed":
    case "host_key_revoked":
      return `The host key for ${facts.host} is not trusted by ${facts.machine}. Whoever manages that machine's SSH trust must fix it, then connect again.`;
    case "auth_mode_unsupported":
      return `The destination needs a sign-in method Subshell does not run. ${facts.host} must accept key-based SSH.`;
    case "key_unavailable":
      return `The identity file this host names is not available on ${facts.machine}. Check the path and its permissions there.`;
    case "connection_failed":
      return `${facts.host} could not be reached over SSH from ${facts.machine}. Check the network and the address, then try again.`;
    default:
      return err instanceof ApiError
        ? err.message.slice(0, 300)
        : "The session could not be opened. Try again, and check the machine's connection if it keeps failing.";
  }
}

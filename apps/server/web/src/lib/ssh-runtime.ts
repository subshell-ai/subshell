import { ApiError, parseErrorBody } from "@internal/node-admin";
import type { SshErrorCode } from "@internal/subshell-protocol";

/**
 * The SPA-side mirror of the `/api/ssh-runtime` family (design 2026-10-05
 * §1/§7) plus the refusal-copy map the wizard renders. The wire shapes are
 * the route schemas; the named codes ride `metadataSafe.sshCode`, which the
 * shared `apiFetch` error path drops - so this file carries its own thin
 * fetch that keeps the code for the copy table. Everything else (cookies,
 * the JSON contract) matches `apiFetch` exactly. The named codes are the
 * frozen `@internal/subshell-protocol` set (imported, never restated, the
 * `lib/ssh.ts` precedent), so a refusal can be mapped by EQUALITY into
 * `SSH_ERROR_DESCRIPTIONS`.
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
  | {
      accepted: false;
      /** Named limitation; the route schema admits only the frozen set (the ssh-api-types convention). */
      code: SshErrorCode;
      /** Config keywords that blocked, when the code names several. */
      settings: string[];
    };

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

/** One cached/just-detected harness on a session's destination (`GET/POST /:id/harnesses`). */
export interface SshRuntimeHarnessEntry {
  harnessId: string;
  /** Display name from the plane's manifest (the id when the plugin is unknown). */
  harnessName: string;
  /** The destination's binary answer: found and executable there. */
  installed: boolean;
  binaryPath: string | null;
  rawVersion: string | null;
  reason: string | null;
  checkedAt: string | null;
}

/** `GET /:id/harnesses` and `POST /:id/harnesses/detect` - the destination's harness mirror. */
export interface SshRuntimeHarnessesView {
  sessionId: string;
  runtimeNodeId: string;
  /** Whether a live session backs this view right now. */
  online: boolean;
  harnesses: SshRuntimeHarnessEntry[];
  env: Record<string, string>;
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
      return `SSH connected to ${facts.host}, but Subshell isn’t installed there yet. Follow the steps below, then try again.`;
    case "session_protocol":
      return `The Subshell version on ${facts.host} isn’t compatible with this server. Update Subshell on that host, then try again.`;
    case "session_quota":
      return `${facts.machine} has reached its limit of open SSH connections. Close one you’re no longer using, then try again.`;
    case "session_in_use":
      return `There’s already an active session on ${facts.host}. Close that session before connecting again.`;
    case "host_key_unknown":
    case "host_key_changed":
    case "host_key_revoked":
      return `${facts.machine} can’t verify the SSH identity of ${facts.host}. Follow the steps below to check it before connecting.`;
    case "auth_mode_unsupported":
      return `${facts.host} is asking for a sign-in method Subshell can’t use. Set up SSH key access from ${facts.machine}, then try again.`;
    case "key_unavailable":
      return `Subshell can’t read the SSH key file on ${facts.machine}. Check that the file exists and the account running Subshell can read it.`;
    case "connection_failed":
      return `We couldn’t reach ${facts.host} from ${facts.machine}. Check the host address and network connection, then try again.`;
    default:
      return err instanceof ApiError
        ? err.message.slice(0, 300)
        : "We couldn’t connect. Please try again, and check the connecting computer’s network if the problem continues.";
  }
}

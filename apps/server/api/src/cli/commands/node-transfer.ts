import { APP_BASE_URL, SERVER_PORT } from "@/constants.js";

/**
 * `subshell-server node transfer`: the machine door to the ownership
 * handover (spec 2026-11-07). A running server answers the act; this command
 * is a client of it, authenticating with an automation key that carries the
 * `nodes:transfer` grant. That is also the reason for the one hard rule of
 * this file: the key arrives on STDIN and nowhere else. An argv credential
 * is `ps`-visible to every local user and written to shell history, the
 * posture `docs/security.md` already refuses for bearer tokens generally,
 * so a `--key <value>` spelling is not a missing convenience but a door this
 * command deliberately does not open (and its refusal quotes the flag's
 * name, never the token, so even the `--key=value` form can't leak).
 */

/** The parsed command; `null` from the parser means "refuse, usage printed". */
export interface NodeTransferOptions {
  /** The node's exact id (this is the route's own addressing; no name lookup from here) */
  nodeId: string;
  /** The receiving account's user id */
  toUserId: string;
  /** Share the machine back to the giving account at manage (default true, always sent) */
  retainAccessAsManager: boolean;
  /** Server origin, validated http(s), no trailing slash */
  baseUrl: string;
  /** Machine-readable success document on stdout */
  json: boolean;
}

export interface NodeTransferDeps {
  log: (line: string) => void;
  error: (line: string) => void;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Reads the API key (the `--key-stdin` half; production reads stdin). */
  readKey: () => Promise<string> | string;
}

/** Parses `node ...` argv (after the verb word). `null` = refused; reasons already printed. */
export function parseNodeArgs(
  args: string[],
  error: (line: string) => void,
): (NodeTransferOptions & { keyStdin: true }) | null {
  if (args[0] !== "transfer") {
    error(`node: unknown subcommand "${args[0] ?? ""}" (transfer is the only one)`);
    return null;
  }
  let nodeId = "";
  let toUserId = "";
  let retainAccessAsManager = true;
  let baseUrl = "";
  let keyStdin = false;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--to" || arg === "--base-url") {
      // A value that starts with `-` is the NEXT flag, not this flag's answer:
      // `--to --key-stdin` must name `--to` as the hole, not later contradict
      // the operator about a missing `--key-stdin` it just swallowed.
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        error(
          arg === "--to"
            ? "node transfer: --to needs the receiving account's id (a flag is not an id)"
            : "node transfer: --base-url needs the server address (a flag is not an address)",
        );
        return null;
      }
      i += 1;
      if (arg === "--to") toUserId = value;
      else baseUrl = value;
    } else if (arg === "--key-stdin") keyStdin = true;
    else if (arg === "--keep-manage") retainAccessAsManager = true;
    else if (arg === "--no-keep-manage") retainAccessAsManager = false;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) {
      // `--key <value>` and `--key=<value>` both land here on purpose: there
      // is no argv spelling of the credential, and the refusal must name the
      // one that exists. The echo is the flag's NAME up to any `=`, never the
      // token as typed: the equals form hides the whole bearer inside `arg`,
      // and a refusal that printed it would persist the key in terminal
      // scrollback and CI logs, the exact exposure this command exists to
      // refuse.
      const name = arg.split("=")[0] ?? arg;
      error(
        `node transfer: unknown flag "${name}"${name === "--key" || name === "--api-key" ? " (the key comes from --key-stdin, never the command line)" : ""}`,
      );
      return null;
    } else if (!nodeId && arg.startsWith("subshell_")) {
      // A flag-order slip can park the bearer in the node-id slot, and
      // encodeURIComponent does not make a path segment private: the server
      // log carries paths. Node ids are UUIDs, so nothing legitimate starts
      // this way and the refusal costs nothing.
      error(
        "node transfer: that looks like an automation key, not a node id; the key comes from --key-stdin and the id is the machine's (list it at Settings → Nodes)",
      );
      return null;
    } else if (!nodeId) nodeId = arg;
    else {
      // Echo the stray token as typed UNLESS it looks like a credential:
      // printing a slipped key back persists it in scrollback and CI logs,
      // the exact exposure this command exists to refuse.
      if (arg.startsWith("subshell_")) {
        error(
          "node transfer: an extra argument looks like an automation key, so it is not echoed; the key comes from --key-stdin",
        );
        return null;
      }
      error(`node transfer: unexpected argument "${arg}"`);
      return null;
    }
  }
  if (!nodeId) {
    error("node transfer: which node? subshell-server node transfer <nodeId> --to <userId> --key-stdin");
    return null;
  }
  if (!toUserId) {
    error("node transfer: --to <userId> is required (the receiving account's id)");
    return null;
  }
  if (!keyStdin) {
    error(
      "node transfer: --key-stdin is required; the automation key is read from stdin and never from the command line",
    );
    return null;
  }
  let origin: string;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      origin = url.origin;
    } catch {
      error(`node transfer: --base-url must be an http(s) address, not "${baseUrl}"`);
      return null;
    }
  } else {
    // The configured base URL, the same address the browser uses. It always
    // has a value (constants defaults it to this host's port), and the key
    // authenticates against THIS instance wherever it points.
    origin = APP_BASE_URL.replace(/\/+$/, "");
    if (origin === "") origin = `http://127.0.0.1:${SERVER_PORT}`;
  }
  return { nodeId, toUserId, retainAccessAsManager, baseUrl: origin, json, keyStdin: true };
}

/** Runs the command; returns the exit code. Never throws, never echoes the key. */
export async function runNodeTransfer(opts: NodeTransferOptions, deps: NodeTransferDeps): Promise<number> {
  const key = String(await deps.readKey()).trim();
  if (key === "") {
    deps.error("node transfer: --key-stdin was given an empty key");
    return 1;
  }
  let res: Response;
  try {
    res = await deps.fetch(`${opts.baseUrl}/api/nodes/${encodeURIComponent(opts.nodeId)}/transfer`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ toUserId: opts.toUserId, retainAccessAsManager: opts.retainAccessAsManager }),
    });
  } catch {
    // The key is deliberately NOT interpolated into any failure text; the
    // address is what the operator needs to fix a wrong `--base-url`.
    deps.error(
      `node transfer: could not reach the server at ${opts.baseUrl}; is it running, and is that the right address?`,
    );
    return 1;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      body !== null && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `the server answered HTTP ${res.status}`;
    deps.error(`node transfer: ${message}`);
    return 1;
  }
  if (opts.json) {
    deps.log(JSON.stringify(body, null, 2));
    return 0;
  }
  const result = (body ?? {}) as { nodeId?: string; ownerUserId?: string; retainedAccessAsManager?: boolean };
  deps.log(
    `Transferred node ${result.nodeId ?? opts.nodeId} to account ${result.ownerUserId ?? opts.toUserId}${
      result.retainedAccessAsManager ? "; you kept a Manage share on it" : "; no access retained"
    }.`,
  );
  return 0;
}

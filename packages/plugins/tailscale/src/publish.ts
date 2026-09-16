import type { NetworkContext, NetworkState, PluginHost, PublishOutcome, PublishRefusal } from "@subshell-ai/plugin-api";
import { firstLine, magicDnsName, resolveBinary } from "./cli.js";
import { HTTPS_DOCS_URL } from "./hints.js";
import { readNetwork } from "./status.js";

/** `serve` is a daemon round trip, not a network fetch; the default deadline is ample. */
const SERVE_TIMEOUT_MS = 30_000;

/** The port `tailscale serve --https` terminates TLS on. Tailscale supports only 443, 8443 and 10000. */
const HTTPS_PORT = 443;

/** One sentence per state this machine can be in that is not ready to publish. */
const NOT_READY: Partial<Record<NetworkState, string>> = {
  "not-installed": "Tailscale is not installed on this machine, so there is nothing to publish on.",
  "daemon-down": "The Tailscale daemon is not running, so this server cannot be published yet.",
  "needs-privilege": "This server may not drive Tailscale yet, so it cannot publish.",
  "needs-login": "This machine is not on a tailnet yet. Join one first, then publish.",
};

/**
 * Puts this server behind a MagicDNS HTTPS address on the tailnet.
 *
 * Refuses rather than throwing for everything an operator can fix, because a
 * refusal is an ANSWER: "enable certificates for your tailnet" is the next
 * thing to do, and an exception would render as a failure with no next step.
 * Only the state is re-read first — never remembered from a previous call —
 * since a plugin holds nothing and the port may have changed since.
 */
export async function publishServer(host: PluginHost, ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
  const read = await readNetwork(host, ctx);

  // State before certificates, which inverts the order these two are usually
  // listed in, and deliberately: `CertDomains` is empty on a machine with no
  // Tailscale at all, so checking it first would answer "not installed" with a
  // lecture about the admin console.
  const notReady = NOT_READY[read.status.state];
  if (notReady) {
    const hint = read.status.hints[0];
    return {
      refused: {
        text: notReady,
        ...(hint?.command ? { command: hint.command } : {}),
        ...(hint?.docsUrl ? { docsUrl: hint.docsUrl } : {}),
        ...(hint?.privileged ? { privileged: true } : {}),
      },
    };
  }

  const json = read.json;
  const binary = read.binary;
  // Unreachable given a state at or above `joined`, which is only produced
  // from a parsed body and a resolved binary. Narrowing rather than asserting,
  // because a `!` here would be the one line that could throw out of a publish.
  if (!json || !binary) {
    return { refused: { text: "This server could not read Tailscale's status, so it did not try to publish." } };
  }

  if ((json.CertDomains ?? []).length === 0) {
    return {
      refused: {
        text: "Tailscale has no HTTPS certificate for this tailnet yet. Enable HTTPS certificates and MagicDNS in the Tailscale admin console, then publish again.",
        docsUrl: HTTPS_DOCS_URL,
      },
    };
  }

  const dnsName = magicDnsName(json);
  if (!dnsName) {
    return {
      refused: {
        text: "Tailscale did not report a MagicDNS name for this machine, so there is no HTTPS address to publish it at.",
        docsUrl: HTTPS_DOCS_URL,
      },
    };
  }

  // Reset first, so publishing twice — or publishing after the server's port
  // changed — replaces the old handler instead of layering a second one under
  // the same name. A machine that was serving nothing is not an error here.
  await host.run([binary, "serve", "reset"], { timeoutMs: SERVE_TIMEOUT_MS });

  const target = `http://127.0.0.1:${ctx.port}`;
  const result = await host.run([binary, "serve", "--bg", `--https=${HTTPS_PORT}`, target], {
    timeoutMs: SERVE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    return {
      refused: {
        text: firstLine(result.stderr) || firstLine(result.stdout) || "`tailscale serve` failed with no output.",
        docsUrl: "https://tailscale.com/kb/1242/tailscale-serve",
      },
    };
  }

  // One address, and https: this is what the publish CREATED. The tailnet IP
  // addresses a status read also reports were reachable before this call and
  // are unchanged by it, and putting one here would offer the host a
  // non-secure-context origin to promote to base URL.
  return {
    addresses: [{ url: `https://${dnsName}`, scheme: "https", label: "MagicDNS", secureContext: true }],
  };
}

/**
 * Takes the serve configuration down.
 *
 * `serve reset` clears everything this machine serves, which is the right
 * scope precisely because {@link publishServer} resets before it publishes: a
 * host that serves anything else has already lost it there, so a narrower undo
 * would leave the two halves disagreeing about what they own.
 *
 * A non-zero exit is ignored. The commonest one is a machine that was serving
 * nothing at all, and "stop doing what you are not doing" is a success; the
 * rest are logged and left, because an unpublish that reports failure gives
 * the operator nothing they can act on.
 */
export async function unpublishServer(host: PluginHost): Promise<void> {
  const binary = await resolveBinary(host);
  if (!binary) return;
  const result = await host.run([binary, "serve", "reset"], { timeoutMs: SERVE_TIMEOUT_MS });
  if (result.code !== 0) host.log.warn(`tailscale serve reset exited ${result.code}: ${firstLine(result.stderr)}`);
}

/**
 * Takes this machine off the tailnet.
 *
 * Best-effort by contract: a machine that was never logged in, or whose daemon
 * is already gone, is not an error — there is nothing left to leave.
 */
export async function leaveTailnet(host: PluginHost): Promise<void> {
  const binary = await resolveBinary(host);
  if (!binary) return;
  const result = await host.run([binary, "logout"], { timeoutMs: SERVE_TIMEOUT_MS });
  if (result.code !== 0) host.log.warn(`tailscale logout exited ${result.code}: ${firstLine(result.stderr)}`);
}

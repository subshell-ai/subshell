import type { NetworkContext, NetworkState, PluginHost, PublishOutcome, PublishRefusal } from "@subshell-ai/plugin-api";
import { firstLine, resolveBinary, runTailscale, tailnetName } from "./cli.js";
import { HEADSCALE_SERVE_ISSUE_URL } from "./hints.js";
import { readNetwork } from "./status.js";

/** `serve` is a daemon round trip, not a network fetch; the default deadline is ample. */
const SERVE_TIMEOUT_MS = 30_000;

/**
 * **UNMEASURED — spec 2026-09-15 § 10.3, still open as this plugin ships
 * (spec 2026-09-16 § 4).** Whether `tailscale serve --bg --http=80` is
 * accepted by a current Headscale has never been run against one. The design
 * posture that ships anyway: TRY the serve, and if the CLI refuses, answer
 * with an honest refusal that names the unknown and points at the plain
 * `http://<DNSName>:<port>` address the status already lists. A `published`
 * state is never fabricated on a refusal.
 */
const SERVE_PORT = 80;

/** One sentence per state this machine can be in that is not ready to publish. */
const NOT_READY: Partial<Record<NetworkState, string>> = {
  "not-installed": "Tailscale is not installed on this machine, so there is nothing to publish on.",
  "daemon-down": "The Tailscale daemon is not running, so this server cannot be published yet.",
  "needs-privilege": "This server is not allowed to control Tailscale yet, so it cannot publish.",
  "needs-login": "This machine is not on a tailnet yet. Join one first, then publish.",
};

/**
 * Puts this server behind a MagicDNS http address on the self-hosted tailnet.
 *
 * The shape is `@subshell-ai/plugin-tailscale`'s publish — read the state,
 * refuse with the state's own sentence (never inventing one), reset before
 * serving — with § 4's differences: `--http=80` instead of `--https=443`
 * (there are no certificates to terminate; headscale#2527), and a CLI refusal
 * landing on the § 10.3 sentence rather than a generic one.
 *
 * Refuses rather than throwing for everything an operator can fix, because a
 * refusal is an ANSWER, and the § 10.3 refusal is not an error at all — it is
 * the honest statement of the most likely outcome.
 */
export async function publishServer(host: PluginHost, ctx: NetworkContext): Promise<PublishOutcome | PublishRefusal> {
  const read = await readNetwork(host, ctx);

  // State before anything else, copied from the origin: the not-installed
  // case must not be answered with a lecture about the control server.
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
  // Unreachable given a state at or above `joined`; narrowing rather than
  // asserting, copied from the origin.
  if (!json || !binary) {
    return { refused: { text: "This server could not read Tailscale's status, so it did not try to publish." } };
  }

  const dnsName = tailnetName(json);
  if (!dnsName) {
    return {
      refused: {
        text: "Tailscale did not report a MagicDNS name for this machine, so there is no tailnet name to publish it at.",
      },
    };
  }

  // Reset first, so publishing twice — or publishing after the server's port
  // changed — replaces the old handler instead of layering a second one.
  await runTailscale(host, binary, ["serve", "reset"], { timeoutMs: SERVE_TIMEOUT_MS });

  const target = `http://127.0.0.1:${ctx.port}`;
  const result = await runTailscale(host, binary, ["serve", "--bg", `--http=${SERVE_PORT}`, target], {
    timeoutMs: SERVE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    // The § 10.3 branch of the design: try, be refused, say what was tried
    // and what is not known, and point at the address that already works.
    // `addresses` stays absent — an outcome that lists one is a claim of
    // success, and this run did not succeed.
    const cliSaid = firstLine(result.stderr) || firstLine(result.stdout);
    return {
      refused: {
        text:
          `Tailscale Serve refused to publish this server${cliSaid ? `: ${cliSaid}` : " with no explanation"}. ` +
          `Whether Serve works against a given Headscale is unmeasured (design spec 2026-09-15 § 10.3) and a refusal is expected. ` +
          `This server is reachable on your tailnet without it at http://${dnsName}:${ctx.port} — ` +
          `add that address under Settings → Addresses before signing in there; this refused publish did not add it.`,
        docsUrl: HEADSCALE_SERVE_ISSUE_URL,
      },
    };
  }

  // The address this publish CREATED: serve on port 80, so the name needs no
  // port. http and `secureContext: false` state what the browser will refuse
  // there — never claim a certificate this control server does not issue.
  return {
    addresses: [{ url: `http://${dnsName}`, scheme: "http", label: "MagicDNS", secureContext: false }],
  };
}

/**
 * Takes the serve configuration down.
 *
 * Copied from `@subshell-ai/plugin-tailscale`'s `src/publish.ts` (§ 4:
 * unpublish is `tailscale serve reset`), including the non-zero-exit
 * tolerance: a machine serving nothing refused the reset and that is success.
 */
export async function unpublishServer(host: PluginHost): Promise<void> {
  const binary = await resolveBinary(host);
  if (!binary) return;
  const result = await runTailscale(host, binary, ["serve", "reset"], { timeoutMs: SERVE_TIMEOUT_MS });
  if (result.code !== 0) host.log.warn(`tailscale serve reset exited ${result.code}: ${firstLine(result.stderr)}`);
}

/**
 * Takes this machine off the tailnet.
 *
 * Copied from `@subshell-ai/plugin-tailscale`'s `src/publish.ts` (§ 4: leave
 * is `tailscale logout`). Best-effort by contract: a machine never logged in
 * is not an error.
 */
export async function leaveTailnet(host: PluginHost): Promise<void> {
  const binary = await resolveBinary(host);
  if (!binary) return;
  const result = await runTailscale(host, binary, ["logout"], { timeoutMs: SERVE_TIMEOUT_MS });
  if (result.code !== 0) host.log.warn(`tailscale logout exited ${result.code}: ${firstLine(result.stderr)}`);
}

import type { JoinInput, JoinOutcome, NetworkContext, PluginHost } from "@subshell-ai/plugin-api";
import { firstLine, loginUrl, parseStatusJson, resolveBinary, runNetbird } from "./cli.js";

/**
 * How long `netbird up` may block waiting for a human.
 *
 * Generous on purpose, because the deadline is not how this run normally ends:
 * an interactive `up` prints its login URL within a second and then waits
 * indefinitely, and the plugin aborts it the moment the URL appears. The timeout
 * only catches a CLI that printed nothing at all.
 */
const LOGIN_TIMEOUT_MS = 120_000;

/** The status re-read that follows an interactive join, bounded like a page load. */
const STATUS_TIMEOUT_MS = 15_000;

/** Any https URL, used only on a line that already says it is the one to open. */
const ANY_URL_RE = /https:\/\/\S+/;

/** The words that mark a line as carrying the login URL. */
const LOGIN_LINE_RE = /open|url|login|auth|browser|sign[\s-]?in/i;

/** A device code NetBird prints for an out-of-band flow, e.g. `ABCD-1234-EFGH`. */
const DEVICE_CODE_RE = /code[^A-Za-z0-9]*([A-Za-z0-9][A-Za-z0-9-]{3,})/i;

/**
 * The `--management-url` argument, when the operator set one.
 *
 * NetBird points at the SaaS management service by default; a self-hosted
 * NetBird needs the explicit URL. Absent means the default, so the argument is
 * omitted entirely rather than passed empty.
 */
function managementArg(ctx: NetworkContext): string[] {
  const url = ctx.settings.managementUrl?.trim();
  return url ? [`--management-url=${url}`] : [];
}

/**
 * Puts this machine on a NetBird network.
 *
 * Two paths, chosen by whether the operator pasted a setup key. Both are one
 * `netbird up`; what differs is how it ends — a key returns a machine that is on
 * the network, and no key returns a URL someone has to open.
 *
 * Throws rather than returning for a refused `up`, because {@link JoinOutcome}
 * has no shape for "this did not happen". The streaming join route reaches the
 * operator as the stream's terminal `error` frame, not a status code — the
 * body is open before any plugin verb runs.
 *
 * **The setup key's shape is not validated.** NetBird setup keys are opaque
 * (account-scoped UUIDs in the current scheme), and a wrong-length guess would
 * refuse a key that happens to be valid — so a malformed one is the CLI's to
 * reject, and its own words come back. This mirrors the join route's own note
 * that the credential's shape is the vendor's business.
 */
export async function joinNetwork(host: PluginHost, input: JoinInput, ctx: NetworkContext): Promise<JoinOutcome> {
  const binary = await resolveBinary(host);
  if (!binary) throw new Error("NetBird is not installed on this machine, so there is nothing to join.");

  const management = managementArg(ctx);

  const credential = input.credential?.trim();
  if (credential) {
    // The key is an argv element and is therefore `ps`-visible on this host for
    // the life of the command — the same accepted exposure as every other mesh
    // credential this server passes to a CLI. It is never stored: a join
    // credential is transient by contract.
    const result = await runNetbird(host, binary, ["up", `--setup-key=${credential}`, ...management], {
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) || firstLine(result.stdout) || "`netbird up` failed with no output.");
    }
    return { state: "joined" };
  }

  return interactiveJoin(host, binary, management);
}

/**
 * Runs `netbird up --no-browser` only as far as the login URL, then stops it.
 *
 * The abort IS the success path. An interactive `up` prints the URL (and, for a
 * flow that uses one, a device code) and then blocks until the person finishes in
 * a browser — so the URL is read off the output stream and the run is ended. The
 * fallback mirrors the Tailscale join: if nothing arrived on the stream, ask the
 * daemon whether the machine is already up rather than guessing from the exit
 * code. NetBird's status carries no login URL of its own, so "not joined and no
 * URL" is a genuine failure with the CLI's words, not a URL to hand back.
 */
async function interactiveJoin(host: PluginHost, binary: string, management: string[]): Promise<JoinOutcome> {
  const controller = new AbortController();
  const found: { url: string | null; code: string | null } = { url: null, code: null };

  const result = await runNetbird(host, binary, ["up", "--no-browser", ...management], {
    timeoutMs: LOGIN_TIMEOUT_MS,
    signal: controller.signal,
    onLine: (line) => {
      const code = line.match(DEVICE_CODE_RE);
      if (code?.[1] && !found.code) found.code = code[1];
      if (found.url) return;
      const any = line.match(ANY_URL_RE);
      if (!any) return;
      // The URL arrives either inside a sentence naming it ("…open this URL…")
      // or on a bare line of its own. A line that is JUST an https URL during an
      // interactive `up` (which prints progress, not stray doc links) is the
      // login URL, so both spellings are honoured rather than only the prose one.
      if (LOGIN_LINE_RE.test(line) || line.trim().startsWith("http")) {
        found.url = tidyUrl(any[0]);
        controller.abort();
      }
    },
  });

  if (found.url) {
    const url = loginUrl(found.url);
    if (url) {
      return {
        state: "needs-login",
        loginUrl: url,
        ...(found.code ? { loginCode: found.code } : {}),
      };
    }
  }

  // No usable URL on the stream. Either the machine is already up, or the run
  // failed. Ask, rather than guessing from the exit code.
  const status = await runNetbird(host, binary, ["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
  const json = parseStatusJson(status.stdout);
  if (json && json.management?.connected === true) return { state: "joined" };

  throw new Error(
    firstLine(result.stderr) ||
      firstLine(result.stdout) ||
      "`netbird up` printed no login URL and this machine is still not on a NetBird network.",
  );
}

/**
 * Drops sentence punctuation a URL picked up from its line.
 *
 * `\S+` is greedy by design — a login URL carries a long opaque token and
 * anything narrower would truncate it — so the cost is a trailing full stop when
 * the CLI wraps the URL in a sentence.
 */
function tidyUrl(url: string): string {
  return url.replace(/[.,;:)\]]+$/, "");
}

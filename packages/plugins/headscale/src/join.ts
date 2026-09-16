import type { JoinInput, JoinOutcome, NetworkContext, PluginHost } from "@subshell-ai/plugin-api";
import { firstLine, loginUrl, parseStatusJson, resolveBinary, runTailscale } from "./cli.js";

/**
 * Puts this machine on a self-hosted tailnet.
 *
 * **Structurally a copy of `@subshell-ai/plugin-tailscale`'s `src/join.ts`**
 * (spec 2026-09-16 § 4: "URL capture and abort exactly as tailscale's join
 * does"), with the two differences that section names: every `up` carries
 * `--login-server <controlUrl>`, and a join without a configured control
 * server REFUSES before anything runs.
 */

/** How long `tailscale up` may block waiting for a human. */
const LOGIN_TIMEOUT_MS = 120_000;

/** Headscale pre-auth keys share the vendor's prefix — the client validates the shape. */
const AUTH_KEY_RE = /^tskey-/;

/** The URL an interactive `tailscale up` prints for a human to open. */
const LOGIN_URL_RE = /https:\/\/login\.tailscale\.com\/\S+/;

/** Any https URL, used only on a line that already says it is the one to open. */
const ANY_URL_RE = /https:\/\/\S+/;

/**
 * Puts this machine on its Headscale tailnet.
 *
 * Two paths, chosen by whether the operator pasted a key, exactly as the
 * tailscale plugin's do; what differs is that BOTH name the control server,
 * because a `tailscale up` without `--login-server` would join this machine to
 * Tailscale's SaaS instead — the quiet wrong-tailnet failure the plugin's whole
 * README is about.
 *
 * Throws rather than returning for its refusals. § 4 shows the missing-URL
 * refusal shaped `{ refused: { text } }`, which is PUBLISH's answer —
 * `JoinOutcome` has no refusal member, and the origin plugin documents the
 * same conclusion: a join either moved this machine or it failed, and the
 * host maps the throw to the operator (the route's own `configurationRefusal`
 * answers first for cookie callers; this is the guarantee for every caller).
 */
export async function joinHeadscaleNetwork(
  host: PluginHost,
  input: JoinInput,
  ctx: NetworkContext,
): Promise<JoinOutcome> {
  const binary = await resolveBinary(host);
  if (!binary) throw new Error("Tailscale is not installed on this machine, so there is nothing to join.");

  // § 4's sentence, verbatim. Checked BEFORE the binary even ran, and before
  // the credential's shape, so a half-configured plugin fails with the thing
  // that is actually missing.
  const controlUrl = ctx.settings.controlUrl?.trim();
  if (!controlUrl) {
    throw new Error("Headscale needs the URL of your control server before this machine can join.");
  }

  const loginArgs = ["--login-server", controlUrl];
  const hostnameArgs = input.hostname?.trim() ? [`--hostname=${input.hostname.trim()}`] : [];

  const credential = input.credential?.trim();
  if (credential) {
    // Checked here rather than handed to the CLI, copied reasoning from the
    // origin: `up` with a nonsense key fails seconds later with a network
    // error that says nothing about the key's shape.
    if (!AUTH_KEY_RE.test(credential)) {
      throw new Error("That does not look like a Headscale auth key: they begin with `tskey-`.");
    }
    // The key is an argv element and therefore `ps`-visible for the life of
    // the command — the accepted mesh-key exposure (spec 2026-09-15 § 4.4:
    // "join passes it once in argv"), never stored.
    const result = await runTailscale(host, binary, ["up", ...loginArgs, `--auth-key=${credential}`, ...hostnameArgs], {
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) || firstLine(result.stdout) || "`tailscale up` failed with no output.");
    }
    return { state: "joined" };
  }

  return interactiveJoin(host, binary, loginArgs, hostnameArgs);
}

/**
 * Runs `tailscale up --login-server …` only as far as the login URL, then
 * stops it.
 *
 * Copied from `@subshell-ai/plugin-tailscale`'s `src/join.ts`: the abort IS
 * the success path. The daemon keeps the login pending either way, so the
 * next `status` reports the same URL — and on Headscale the admin then has to
 * approve the machine, which the needs-login hint says.
 */
async function interactiveJoin(
  host: PluginHost,
  binary: string,
  loginArgs: string[],
  hostnameArgs: string[],
): Promise<JoinOutcome> {
  const controller = new AbortController();
  // A holder rather than a `let`, as in the origin: the assignment happens in
  // a callback and TypeScript loses a captured `let`'s narrowing.
  const found: { url: string | null } = { url: null };

  const result = await runTailscale(host, binary, ["up", ...loginArgs, ...hostnameArgs], {
    timeoutMs: LOGIN_TIMEOUT_MS,
    signal: controller.signal,
    onLine: (line) => {
      if (found.url) return;
      const direct = line.match(LOGIN_URL_RE);
      if (direct) {
        found.url = tidyUrl(direct[0]);
        controller.abort();
        return;
      }
      // The case that MATTERS here, copied from the origin and load-bearing
      // for a self-hosted control server: a Headscale prints its own host, so
      // recognition cannot rest on the vendor's login domain.
      if (/authenticate|visit/i.test(line)) {
        const any = line.match(ANY_URL_RE);
        if (any) {
          found.url = tidyUrl(any[0]);
          controller.abort();
        }
      }
    },
  });

  if (found.url) return { state: "needs-login", loginUrl: found.url };

  // No URL on the stream: the daemon may already know the pending login, or
  // the machine was already up. Ask, rather than guessing from the exit code.
  const status = await runTailscale(host, binary, ["status", "--json"], { timeoutMs: 15_000 });
  const json = parseStatusJson(status.stdout);
  const authUrl = loginUrl(json?.AuthURL);
  if (authUrl) return { state: "needs-login", loginUrl: authUrl };
  if (json?.BackendState === "Running") return { state: "joined" };

  throw new Error(
    firstLine(result.stderr) ||
      firstLine(result.stdout) ||
      "`tailscale up` printed no login URL and this machine is still not on a tailnet.",
  );
}

/**
 * Drops sentence punctuation a URL picked up from its line.
 *
 * Copied from `@subshell-ai/plugin-tailscale`'s `src/join.ts`: the URL regex
 * is greedy by necessity, so a trailing full stop is the cost.
 */
function tidyUrl(url: string): string {
  return url.replace(/[.,;:)\]]+$/, "");
}

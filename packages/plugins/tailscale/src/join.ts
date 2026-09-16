import type { JoinInput, JoinOutcome, PluginHost } from "@subshell-ai/plugin-api";
import { firstLine, parseStatusJson, resolveBinary } from "./cli.js";

/**
 * How long `tailscale up` may block waiting for a human.
 *
 * Generous on purpose, because the deadline is not how this run normally ends:
 * an interactive `up` prints its login URL within a second and then waits
 * indefinitely, and the plugin aborts it the moment the URL appears. The
 * timeout only catches a CLI that printed nothing at all.
 */
const LOGIN_TIMEOUT_MS = 120_000;

/** Tailscale pre-authentication keys all carry this prefix. */
const AUTH_KEY_RE = /^tskey-/;

/** The URL an interactive `tailscale up` prints for a human to open. */
const LOGIN_URL_RE = /https:\/\/login\.tailscale\.com\/\S+/;

/** Any https URL, used only on a line that already says it is the one to open. */
const ANY_URL_RE = /https:\/\/\S+/;

/**
 * Puts this machine on a tailnet.
 *
 * Two paths, chosen by whether the operator pasted a key. Both are one
 * `tailscale up`; what differs is how it ends — a key returns a machine that
 * is on the tailnet, and no key returns a URL someone has to open.
 *
 * Throws rather than returning for a malformed key and for a refused `up`,
 * because {@link JoinOutcome} has no shape for "this did not happen": a
 * refusal an operator can act on is what a publish answers with, and a join
 * either moved this machine or it failed. The host maps the throw.
 */
export async function joinTailnet(host: PluginHost, input: JoinInput): Promise<JoinOutcome> {
  const binary = await resolveBinary(host);
  if (!binary) throw new Error("Tailscale is not installed on this machine, so there is nothing to join.");

  const hostnameArgs = input.hostname?.trim() ? [`--hostname=${input.hostname.trim()}`] : [];

  const credential = input.credential?.trim();
  if (credential) {
    // Checked here rather than handed to the CLI, because `tailscale up` with
    // a nonsense key fails several seconds later with a network error that
    // says nothing about the key's shape. The host maps a throw to a 400, so
    // the message is what the operator reads.
    if (!AUTH_KEY_RE.test(credential)) {
      throw new Error("That does not look like a Tailscale auth key: they begin with `tskey-`.");
    }
    // The key is an argv element and is therefore `ps`-visible on this host
    // for the life of the command — the same accepted exposure as every other
    // credential this server passes to a CLI. It is never stored: a join
    // credential is transient by contract.
    const result = await host.run([binary, "up", `--auth-key=${credential}`, ...hostnameArgs], {
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) || firstLine(result.stdout) || "`tailscale up` failed with no output.");
    }
    return { state: "joined" };
  }

  return interactiveJoin(host, binary, hostnameArgs);
}

/**
 * Runs `tailscale up` only as far as the login URL, then stops it.
 *
 * The abort IS the success path. An interactive `up` prints the URL and then
 * blocks until the person finishes in a browser, which can be minutes and
 * which nothing here should hold a request open for — so the URL is read off
 * the output stream and the run is ended. The daemon keeps the login pending
 * either way, so the next `status` read reports the same URL.
 */
async function interactiveJoin(host: PluginHost, binary: string, hostnameArgs: string[]): Promise<JoinOutcome> {
  const controller = new AbortController();
  // A holder rather than a `let`: the assignment happens inside a callback,
  // and TypeScript keeps a captured `let`'s narrowing from its initializer, so
  // the `if` below would read as unreachable. A property's type comes from its
  // declaration, which is what this is for.
  const found: { url: string | null } = { url: null };

  const result = await host.run([binary, "up", ...hostnameArgs], {
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
      // A self-hosted control server prints its own host, so the vendor URL
      // cannot be the only thing recognized. Narrowed to lines that say what
      // the URL is for, so an unrelated link in a warning is not mistaken for
      // a login.
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

  // No URL on the stream. Two things can be true: the daemon already knows the
  // pending login (and reports it on `status`), or the machine was already up
  // and `up` simply returned. Ask, rather than guessing from the exit code.
  const status = await host.run([binary, "status", "--json"], { timeoutMs: 15_000 });
  const json = parseStatusJson(status.stdout);
  const authUrl = json?.AuthURL?.trim();
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
 * `\S+` is greedy by design — a login URL carries a long opaque token and
 * anything narrower would truncate it — so the cost is a trailing full stop
 * when the CLI wraps the URL in a sentence.
 */
function tidyUrl(url: string): string {
  return url.replace(/[.,;:)\]]+$/, "");
}

import { confirm, intro, isCancel, outro } from "@clack/prompts";
import type { CliResult } from "./cli.js";
import { configPath } from "./config.js";
import { assertTmux, runEnroll } from "./enroll.js";
import { installService, type ServiceDeps } from "./service.js";

/**
 * `subshell setup` — the whole enrollment in ONE verb (spec 2026-09-15 §4.5):
 * tmux preflight, enroll, ask about the background service, install it, and
 * say where to look.
 *
 * The defect it closes is a sequencing one rather than a missing capability.
 * Every step already existed and nothing pointed at the next: `install.sh`
 * ended at `subshell run`, a FOREGROUND daemon that dies with the SSH session
 * that started it, and neither it nor `enroll` ever named `service install`.
 * A headless operator therefore finished the documented path with an agent
 * that would be gone by morning.
 *
 * `enroll` stays a primitive and is unchanged — whoever composes their own
 * flow still has it. This is the composed one.
 */

/**
 * The interactive question seam. Same shape as the server CLI's
 * (`apps/server/api/src/cli.ts`), widened by a Promise arm because this CLI's
 * `run()` is already async and the production answerer ({@link promptConfirm})
 * is clack, which is not. Tests keep injecting a plain synchronous function.
 *
 * It answers in BOOLEANS, not in "y"/"n" text. A text seam made every caller
 * re-derive what the operator meant, and this CLI briefly did exactly that with
 * its own word parser while the server CLI next door had already decided the
 * opposite (review, 2026-09-15). The parsing belongs to whatever renders the
 * question, which is the one place that knows how it was asked.
 *
 * Returns the answer, or `null` for "nothing answered" — EOF, a closed stdin,
 * or a cancelled prompt. Null is a DECLINE, never a default: a question someone
 * walked away from must not install a service on their machine.
 */
export type ConfirmFn = (question: string, def: boolean) => boolean | null | Promise<boolean | null>;

/** The one question `setup` asks. Default yes — backgrounded is what an operator came for. */
export const SERVICE_QUESTION = "Run the agent in the background and start it at login?";

/** The command that does later what the question offers now — named on every path that skips it. */
const SERVICE_HINT = "subshell service install";

/** Why no background service is running after a successful enrollment. */
export type SetupServiceSkip = "declined" | "failed";

/** One `subshell setup` invocation, as parsed off the command line. */
export interface SetupOptions {
  /** Control-plane base URL (`--server`), http(s). */
  server: string;
  /** One-time `nsk_…` setup key (`--key`). */
  setupKey: string;
  /** Display name for this node; defaults to the hostname. */
  name?: string;
  /** Data dir for the identity keypair; defaults to `<SUBSHELL_CONFIG_HOME>/data`. */
  dataDir?: string;
  /** `--no-service`: enroll only, ask nothing, install nothing. */
  noService: boolean;
  /** `--yes`: take every default without asking. */
  assumeYes: boolean;
  /** `--json`: emit a machine-readable body and never prompt. */
  json: boolean;
}

/** Injectable effects for {@link runSetup}. */
export interface SetupDeps {
  /** Service-manager + filesystem seams handed to {@link installService}. */
  service: ServiceDeps;
  /** How the service question is asked (production: {@link promptConfirm}). */
  prompt: ConfirmFn;
  /** Can anything answer a question? False ⇒ take the default in silence. */
  interactive: boolean;
}

/**
 * Production prompt: a clack confirm, framed by `intro`/`outro` so the
 * rendered bar opens and closes around the one question this CLI asks.
 *
 * It refuses to render on a non-TTY even though {@link runSetup} already gates
 * on that — defence in depth, because the alternative failure is a piped
 * install hanging forever on a read that can never complete. A cancel
 * (Ctrl-C, or clack's own `isCancel`) returns null, which the caller reads as
 * a decline.
 */
export async function promptConfirm(question: string, def: boolean): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null;
  intro("subshell setup");
  const answer = await confirm({ message: question, initialValue: def });
  if (isCancel(answer)) {
    outro("cancelled");
    return null;
  }
  outro("");
  return answer;
}

/**
 * Runs the sequence and returns what to print plus the exit code. The exit
 * code is the SERVICE step's, so a script can tell "fully set up" from "half
 * set up" — and the human output says which half, because a bare non-zero
 * after a spent single-use setup key would read as "nothing happened".
 */
export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<CliResult> {
  // FIRST, and before any network call: the same preflight `runEnroll` runs,
  // hoisted here so the sequence's first step is the one an unenrollable box
  // fails on — and so it fails before the single-use setup key is spent.
  assertTmux();

  const enrolled = await runEnroll({
    server: opts.server,
    setupKey: opts.setupKey,
    name: opts.name,
    dataDir: opts.dataDir,
  });

  // One rule for every question (spec §3.1): `--yes`, `--json` and a
  // terminal that cannot answer all take the default, which here is yes.
  // `--no-service` is the opt-out — for scripts, and for the desktop apps,
  // which install the service themselves with their own autostart choice.
  let wantService: boolean;
  if (opts.noService) {
    wantService = false;
  } else if (opts.json || opts.assumeYes || !deps.interactive) {
    wantService = true;
  } else {
    wantService = (await deps.prompt(SERVICE_QUESTION, true)) ?? false;
  }

  // installService's output rides through VERBATIM: on Linux it carries the
  // lingering hint, which is the difference between a service that survives
  // logout and one that silently does not.
  const service = wantService ? await installService(deps.service) : undefined;
  const skip: SetupServiceSkip | undefined =
    service === undefined ? "declined" : service.code === 0 ? undefined : "failed";

  if (opts.json) {
    // Same rule as `enroll --json` and `status --json`: the nodeKey is NEVER
    // here. A GUI or an installer drives this, so a leak would land the
    // node's bearer credential in a webview or a CI log.
    const body = {
      nodeId: enrolled.nodeId,
      serverUrl: enrolled.serverUrl,
      name: enrolled.name,
      dataDir: enrolled.dataDir,
      configPath: configPath(),
      service: { installed: skip === undefined, ...(skip === undefined ? {} : { reason: skip }) },
    };
    return { code: service?.code ?? 0, out: `${JSON.stringify(body, null, 2)}\n`, err: service?.err ?? "" };
  }

  const lines = [`Enrolled as ${enrolled.nodeId}.`];
  if (skip === "failed") {
    // The enrollment is DONE and the key is spent, so "it failed" without
    // saying what survived would send someone back to mint a second key.
    lines.push(
      `The background service was not installed (see the error below). The enrollment is saved — retry with: ${SERVICE_HINT}`,
    );
  } else if (skip === "declined") {
    lines.push(`No background service installed. To run the agent in the background later: ${SERVICE_HINT}`);
  } else if (service) {
    lines.push(service.out.trimEnd());
  }
  lines.push(`This machine is a node. Open ${enrolled.serverUrl}/nodes to see it.`);
  return { code: service?.code ?? 0, out: `${lines.join("\n")}\n`, err: service?.err ?? "" };
}

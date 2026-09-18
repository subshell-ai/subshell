import { hostname } from "node:os";
import { confirm, intro, isCancel, outro, text } from "@clack/prompts";
import { NODE_NAME_MAX, normalizeNodeName } from "@internal/subshell-protocol";
import type { CliResult } from "./cli.js";
import { configPath } from "./config.js";
import { assertTmux, runEnroll } from "./enroll.js";
import { installService, type ServiceDeps } from "./service.js";

/**
 * `subshell setup` — the whole enrollment in ONE verb (spec 2026-09-15 §4.5):
 * tmux preflight, the node's name, enroll, ask about the background service,
 * install it, and say where to look.
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

/**
 * The interactive TEXT seam (the name question). Same rules as {@link ConfirmFn}:
 * it answers with the text or `null` for "nothing answered" — EOF, a closed
 * stdin, a cancel — and null is never a default, because a name nobody entered
 * must not become a node row.
 */
export type PromptTextFn = (question: string, def: string) => string | null | Promise<string | null>;

/**
 * Why a candidate node name is unusable, or `undefined` when it is fine.
 *
 * The rule is the control plane's — `normalizeNodeName` from
 * `@internal/subshell-protocol`, the same function enroll runs the answer
 * through and the same one the rename route applies afterwards — so the prompt
 * cannot accept something the server will refuse. The length is checked on the
 * RAW text rather than the normalized one because the normalizer TRUNCATES: a
 * 70-character answer would otherwise be silently chopped at 64 instead of
 * bounced back to the person typing it.
 *
 * @param raw - What has been typed so far
 * @returns A one-line reason, or undefined
 */
export function nodeNameProblem(raw: string): string | undefined {
  if (normalizeNodeName(raw) === "") return "A node name needs at least one printable character";
  // Code points, not `String.length` — the unit `normalizeNodeName` caps in, and the
  // unit `runEnroll`'s identical preflight counts (review, 2026-09-18). Measuring this
  // one in UTF-16 units would have the live prompt reject an emoji name at half length
  // and the same name pass `--name`.
  const typed = [...raw.trim()].length;
  if (typed > NODE_NAME_MAX) {
    return `At most ${NODE_NAME_MAX} characters — this is ${typed}`;
  }
  return undefined;
}

/**
 * The first QUESTION `setup` asks (the tmux preflight runs before it, so a box
 * that could host no pane never costs anyone an answer): what to call this
 * machine on the plane.
 */
export const NAME_QUESTION = "Name this node";

/** The second question. Default yes — backgrounded is what an operator came for. */
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
  /**
   * Display name. Absent means ASK on this machine — which is what a piped,
   * `--yes` or `--json` run cannot do, so `subshell setup` refuses those without
   * it (the check lives with the other argv checks in `cli.ts`).
   */
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
  /** How the name question is asked (production: {@link promptName}). */
  promptName: PromptTextFn;
  /** How the service question is asked (production: {@link promptConfirm}). */
  prompt: ConfirmFn;
  /** Can anything answer a question? False ⇒ take the default in silence. */
  interactive: boolean;
}

/**
 * `intro` draws its bar once per process, however many questions this verb
 * asks. It used to be drawn by {@link promptConfirm} alone, which was right
 * when there was exactly one question and reads as two separate wizards now
 * that the name is asked first.
 */
let introDrawn = false;

/**
 * Forgets that the bar was drawn. A process runs `setup` once, so production never
 * needs this; a test that exercises the production prompts (or any future caller
 * that runs the verb twice) would otherwise get a second run with no header and no
 * explanation.
 *
 * @internal
 */
export function resetPromptFramingForTests(): void {
  introDrawn = false;
}

/** Production prompt: a clack confirm (see {@link promptName} for the text twin). */
export async function promptConfirm(question: string, def: boolean): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null;
  if (!introDrawn) {
    introDrawn = true;
    intro("subshell setup");
  }
  const answer = await confirm({ message: question, initialValue: def });
  if (isCancel(answer)) {
    outro("cancelled");
    return null;
  }
  outro("");
  return answer;
}

/**
 * Production name prompt: a clack text input prefilled with the machine's
 * hostname, so Enter accepts "what the box calls itself" and typing replaces it.
 *
 * This is where the name comes from now. It used to be typed into the Add-node
 * dialog on the control plane — a machine nobody was standing at, named by a
 * guess, and the label never reached the node anyway because the one-liner ran
 * `setup` with no name. The hostname is the DEFAULT here, not the answer: the
 * operator sees it, and one edit makes it theirs.
 *
 * Refuses to render on a non-TTY for the same reason {@link promptConfirm}
 * does, and a cancel (Ctrl-C, clack's `isCancel`) is null = nothing named.
 */
export async function promptName(question: string, def: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  if (!introDrawn) {
    introDrawn = true;
    intro("subshell setup");
  }
  const answer = await text({ message: question, initialValue: def, validate: (v) => nodeNameProblem(v ?? "") });
  if (isCancel(answer)) {
    outro("cancelled");
    return null;
  }
  return answer;
}

/**
 * Runs the sequence and returns what to print plus the exit code. The exit
 * code is the SERVICE step's, so a script can tell "fully set up" from "half
 * set up" — and the human output says which half, because a bare non-zero
 * after a spent single-use setup key would read as "nothing happened".
 */
export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<CliResult> {
  // FIRST, and before anything else — a question, a network call, or the key:
  // the same preflight `runEnroll` runs, hoisted here so the sequence's first
  // step is the one an unenrollable box fails on. Asking what to call a machine
  // that then cannot host a pane would be a question with no answer at the end
  // of it, and the box is unenrollable whatever the answer was.
  assertTmux();

  // The name, asked BEFORE the key can be spent on it. `--name` wins when given
  // (a script, the desktop app, `SUBSHELL_NODE_NAME` from the one-liner);
  // otherwise the machine is ASKED, because this is the one place that knows what
  // it is and the one moment a person is standing at it. A cancel is a full stop:
  // enrolling under a name nobody chose, or answering a question nobody answered
  // with a default, are both worse than stopping.
  let name = opts.name?.trim() ?? "";
  if (name === "") {
    const answer = await deps.promptName(NAME_QUESTION, hostname());
    if (answer === null) {
      return {
        code: 1,
        out: "",
        err: "subshell: cancelled — nothing was enrolled. Name this machine with --name <n> to run unattended.\n",
      };
    }
    name = answer.trim();
  }

  const enrolled = await runEnroll({
    server: opts.server,
    setupKey: opts.setupKey,
    name,
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

/**
 * `<self> report …` — out-of-band reporting from a harness hook, shared by the
 * server binary and the node agent exactly as the `mcp` subcommand is.
 *
 * It exists because a hook runs on the PANE's machine, where the only thing
 * guaranteed to be present is the binary that launched the pane. The hooks
 * used to be `bun -e '<inlined JS>'`, which assumed a bun on the pane PATH —
 * true of the container image that assumption was written for, false of every
 * desktop install, where the compiled binary is the whole point.
 *
 * Everything here is FIRE-AND-FORGET by contract: a hook's stdout/stderr and
 * its exit code land in the user's session, and a lost report costs one
 * notification (or one re-reported conversation id), never a broken turn. So
 * nothing throws, nothing logs, and every path is bounded.
 */

import { readMcpEnv } from "./env.js";

/**
 * The attention signals a harness hook can raise about its own subshell.
 * These spellings ARE the wire values the attention endpoint takes, so the
 * verb a hook types needs no translation on the way out.
 *
 * `resumed` is the CLEAR, and it is the only one that reaches every pane:
 * the plane's idle-watcher clear can only observe a log on the plane's own
 * disk, so an agent-node pane — whose log lives on the node — had nothing
 * that could ever take its "waiting for you" back off while it kept working
 * (operator report + live repro, 2026-09-24). The pane's own hooks know when
 * work resumed — a prompt submitted, a tool starting after an approval —
 * and that knowledge has to travel from wherever the pane runs.
 */
export type AttentionKind = "turn_complete" | "needs_attention" | "resumed";

/** Every {@link AttentionKind}, for validating an argv word. */
export const ATTENTION_KINDS: readonly AttentionKind[] = ["turn_complete", "needs_attention", "resumed"];

/**
 * Every verb `report` accepts in its first slot. `attention` takes a second
 * word — an {@link AttentionKind} — and `session` takes none; both CLIs
 * validate against these rather than restating them.
 */
export const REPORT_VERBS: readonly string[] = ["attention", "session", "exit"];

/** Injectable seams so tests can pin every path (defaults: the real ones). */
export interface ReportIo {
  /** Environment source (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Transport (default: global `fetch`). */
  fetch?: typeof fetch;
  /** Reads the hook payload (default: bounded read of `process.stdin`). */
  readStdin?: () => Promise<string>;
}

/**
 * How long a report may take. Deliberately short on both halves: a
 * `SessionStart` hook BLOCKS the harness until it exits, so the budget is the
 * pane's start latency, not the server's convenience.
 *
 * `resumed` gets a fraction of it: its hook is PreToolUse, which runs before
 * EVERY tool call, so a browned-out plane would otherwise add 2 s to every
 * call of a long run. A lost clear is self-healing — the next prompt or tool
 * reports again, and the pane-local watcher clears on output wherever it can
 * see the log.
 */
const POST_TIMEOUT_MS = 2000;
const RESUMED_POST_TIMEOUT_MS = 750;
const STDIN_TIMEOUT_MS = 2000;

/**
 * The POST budget for one report argv — the whole per-verb decision, as a
 * pure function so the test can pin the numbers instead of reaching into an
 * `AbortSignal` for a value Bun does not expose (Node's `.timeout` getter is
 * non-standard and absent here; measured on bun 1.4.2).
 */
export function postTimeoutMs(argv: string[]): number {
  return argv[0] === "attention" && argv[1] === "resumed" ? RESUMED_POST_TIMEOUT_MS : POST_TIMEOUT_MS;
}

/**
 * Reads stdin to end, but never waits forever: a hook whose stdin is left
 * unclosed by the harness must not stall the pane. An expired read yields ""
 * (an unparseable payload — the same swallowed path as malformed JSON).
 */
async function readStdinBounded(): Promise<string> {
  const timeout = new Promise<string>((resolve) => {
    setTimeout(() => resolve(""), STDIN_TIMEOUT_MS).unref?.();
  });
  return Promise.race([new Response(process.stdin as never).text(), timeout]);
}

/**
 * Runs one report verb.
 *
 * @param argv - the words AFTER `report` (`["attention", "turn_complete"]`, `["session"]`)
 * @param io - injectable seams; defaults to the real environment and transport
 * @returns always resolves, and never with a value — the caller exits 0 regardless
 */
export async function runReport(argv: string[], io: ReportIo = {}): Promise<void> {
  try {
    // An incomplete pane env means this was not spawned as a subshell hook.
    // `readMcpEnv` throws there, which is this function's "do nothing".
    const { apiKey, baseUrl, subshellId } = readMcpEnv(io.env ?? process.env);
    const body = await resolveBody(argv, io);
    if (!body) return;

    const doFetch = io.fetch ?? fetch;
    await doFetch(`${baseUrl}/api/subshells/${subshellId}/${body.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body.json),
      // PreToolUse pays the `resumed` budget on EVERY tool call; the rare
      // event reports keep the full one (see postTimeoutMs).
      signal: AbortSignal.timeout(postTimeoutMs(argv)),
    });
  } catch {
    // Every failure is a lost report: an unreachable server, a refused POST,
    // a malformed payload, an incomplete env. None of them is the hook's
    // business, and none may reach the pane.
  }
}

/** What to POST, or undefined when this argv reports nothing. */
async function resolveBody(
  argv: string[],
  io: ReportIo,
): Promise<{ path: string; json: Record<string, string> } | undefined> {
  const [verb, ...rest] = argv;

  if (verb === "attention") {
    const kind = rest[0];
    if (!kind || !(ATTENTION_KINDS as readonly string[]).includes(kind)) return undefined;
    // The Stop hook fires for a session PARKED on background work too, and
    // Claude Code hands the hook the arrays that tell the two apart. A
    // `turn_complete` POSTs only for a genuinely-done turn (spec 2026-09-23);
    // `needs_attention` never reads stdin — the plugin's Notification matcher
    // is its filter. `resumed` never reads it either, and that is a privacy
    // rule as much as a latency one: UserPromptSubmit's stdin carries the
    // user's prompt text, PreToolUse's the full tool input — the report is
    // the fact "work resumed", never what the work is.
    if (kind === "turn_complete" && (await parkedOnBackgroundWork(io))) return undefined;
    return { path: "attention", json: { kind } };
  }

  if (verb === "exit") {
    // `report exit <status>` — the argument is tmux's own
    // `#{pane_dead_status}`, interpolated into the `pane-died` hook when it
    // was registered. tmux leaves it EMPTY when it has no status to give, and
    // that is reported as null rather than coerced: 0 is a real exit code, so
    // guessing one would turn "could not be read" into "exited cleanly".
    const raw = rest[0];
    const code = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : null;
    return { path: "exit", json: { exitCode: code } as unknown as Record<string, string> };
  }

  if (verb === "session") {
    // The SessionStart payload is metadata ({session_id, transcript_path, cwd,
    // source, …}) and ONLY `session_id` is forwarded — the rest names the
    // user's directories and transcript files, which the server has no reason
    // to receive from a hook.
    const raw = await (io.readStdin ?? readStdinBounded)();
    const parsed: unknown = JSON.parse(raw);
    const sessionId = (parsed as { session_id?: unknown })?.session_id;
    if (typeof sessionId !== "string" || sessionId === "") return undefined;
    return { path: "harness-session", json: { sessionId } };
  }

  return undefined;
}

/**
 * True when this Stop hook's own stdin payload says the session will wake
 * itself: Claude Code documents `background_tasks` / `session_crons`
 * precisely to distinguish "session is done" from "session is paused waiting
 * for background work to wake it back up" (spec 2026-09-23).
 *
 * Everything the gate cannot read answers false — absent or empty stdin,
 * malformed JSON, an older Claude Code without the fields, and the docs'
 * own caveat that an unreachable registry presents as empty arrays. The
 * gate fails TOWARD the push: a wrong suppression costs silence, a wrong
 * push costs one notification. The outer `runReport` catch must never be
 * what swallows a malformed payload here — its own catch is what turns
 * "unparseable" into "push anyway".
 */
async function parkedOnBackgroundWork(io: ReportIo): Promise<boolean> {
  try {
    const raw = await (io.readStdin ?? readStdinBounded)();
    const parsed = JSON.parse(raw) as { background_tasks?: unknown; session_crons?: unknown };
    return (
      (Array.isArray(parsed.background_tasks) && parsed.background_tasks.length > 0) ||
      (Array.isArray(parsed.session_crons) && parsed.session_crons.length > 0)
    );
  } catch {
    return false;
  }
}

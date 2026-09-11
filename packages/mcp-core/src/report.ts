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
 */
export type AttentionKind = "turn_complete" | "needs_attention";

/** Every {@link AttentionKind}, for validating an argv word. */
export const ATTENTION_KINDS: readonly AttentionKind[] = ["turn_complete", "needs_attention"];

/**
 * Every verb `report` accepts in its first slot. `attention` takes a second
 * word — an {@link AttentionKind} — and `session` takes none; both CLIs
 * validate against these rather than restating them.
 */
export const REPORT_VERBS: readonly string[] = ["attention", "session"];

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
 */
const POST_TIMEOUT_MS = 2000;
const STDIN_TIMEOUT_MS = 2000;

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
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
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
    return { path: "attention", json: { kind } };
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

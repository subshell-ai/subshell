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

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readMcpEnv } from "./env.js";

/** Claude keeps labels beside the transcript, including for resumed agents.
 * Read only the small metadata sidecar; never read conversation contents.
 */
async function claudeAgentMetadata(transcript: unknown, id: string): Promise<{ name?: string; activity?: string }> {
  if (
    typeof transcript !== "string" ||
    !isAbsolute(transcript) ||
    !transcript.endsWith(".jsonl") ||
    !/^[a-zA-Z0-9_-]+$/.test(id)
  )
    return {};
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      join(transcript.slice(0, -6), "subagents", `agent-${id}.meta.json`),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) return {};
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) return {};
    const data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!data || typeof data !== "object") return {};
    const activity = typeof data.description === "string" ? data.description.trim().slice(0, 160) : "";
    const name = typeof data.name === "string" ? data.name.trim().slice(0, 160) : "";
    return { ...(activity ? { activity } : {}), ...(name ? { name } : {}) };
  } catch {
    // Older versions and a still-being-written sidecar fall back to hook metadata.
    return {};
  } finally {
    await file?.close().catch(() => {});
  }
}

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
 * Every verb `report` currently implements. `attention` takes a second word —
 * an {@link AttentionKind} — and `session` takes none. The NODE CLI's parser
 * reads this as the set of verbs whose argument rules it knows: the
 * typo-guard's authority is membership, and a word BEYOND this list is
 * admitted and answered silently as version skew (a newer plane's verb is
 * data in a generated hook line, and a refusal would exit 2 into a pane
 * whose hooks block on 2). The server CLI runs `runReport` unvalidated.
 * Either way {@link runReport}'s own filter is the backstop: a verb listed
 * here but not implemented there sends nothing.
 */
export const REPORT_VERBS: readonly string[] = ["attention", "session", "exit", "subagents"];

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
 * The self-extension that rides every report, capped BELOW the slowest main
 * POST so it never lengthens a hook's worst case: the two run in parallel and
 * the process lives for the max, which stays the main budget's number.
 */
const EXTEND_TIMEOUT_MS = 750;

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
    const post = doFetch(`${baseUrl}/api/subshells/${subshellId}/${body.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body.json),
      // PreToolUse pays the `resumed` budget on EVERY tool call; the rare
      // event reports keep the full one (see postTimeoutMs).
      signal: AbortSignal.timeout(postTimeoutMs(argv)),
    });
    // The extend the MCP child arms at its boot, the report verbs arm at
    // theirs: an MCP-disabled pane launches no child, and without this its
    // hooks would quietly 401 once the 7-day TTL ran out under a pane in
    // daily use. Same door, same ownership check, still best-effort; `exit`
    // skips it because the token dies with the pane anyway.
    const extend =
      argv[0] === "exit"
        ? undefined
        : doFetch(`${baseUrl}/api/subshells/${subshellId}/extend-token`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(EXTEND_TIMEOUT_MS),
          }).catch(() => {});
    await post;
    await extend;
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
): Promise<{ path: string; json: Record<string, unknown> } | undefined> {
  const [verb, ...rest] = argv;

  if (verb === "subagents") {
    const raw = await (io.readStdin ?? readStdinBounded)();
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const hook = payload.hook_event_name;
    const extra = payload.extra && typeof payload.extra === "object" ? (payload.extra as Record<string, unknown>) : {};
    const hermes = hook === "subagent_start" || hook === "subagent_stop";
    // /clear, /fork and an in-pane /resume move the pane to a different
    // conversation, and the reported children died with the old one, so the
    // roster resets. /compact keeps ONE conversation's history (and any live
    // children) and must not clear them; startup needs nothing. A launch
    // with --resume also lands here, where the reset is provably harmless:
    // the server dropped everything the moment the row's generation changed.
    // Keeping on resume was the wrong trade: a resumed conversation cannot
    // re-announce its children, so a stale roster would sit there forever,
    // while resetting costs at most a live row until its next event.
    // Sources per the hooks reference: startup|resume|clear|compact|fork.
    if (
      hook === "SessionStart" &&
      (payload.source === "clear" || payload.source === "fork" || payload.source === "resume")
    )
      return { path: "subagents/report", json: { event: "reset" } };
    // Claude Code's SubagentStart payload carries no task label (measured
    // against the hooks reference), but the Agent tool's own input does:
    // PreToolUse for a spawn hands over {subagent_type, description, prompt},
    // and ONLY the two short harness-written labels are forwarded. The server
    // pairs the label with the child its SubagentStart announces next.
    if (
      (hook === "PreToolUse" || hook === "PostToolUse") &&
      (payload.tool_name === "Agent" || payload.tool_name === "Task")
    ) {
      const toolInput =
        payload.tool_input && typeof payload.tool_input === "object"
          ? (payload.tool_input as Record<string, unknown>)
          : {};
      const description = toolInput.description;
      const activity = typeof description === "string" ? description.trim().slice(0, 160) : "";
      const agentName = typeof toolInput.name === "string" ? toolInput.name.trim().slice(0, 160) : "";
      if (!activity && !agentName) return undefined;
      const response = payload.tool_response as Record<string, unknown> | undefined;
      const agentId = response && typeof response.agentId === "string" ? response.agentId : undefined;
      if (hook === "PostToolUse" && (!agentId || agentId.length > 256)) return undefined;
      const agentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type.trim() : "";
      return {
        path: "subagents/report",
        json: {
          event: "describe",
          agentType: agentType.slice(0, 160),
          ...(activity ? { activity } : {}),
          ...(agentName ? { agentName } : {}),
          ...(hook === "PostToolUse" ? { agentId } : {}),
        },
      };
    }
    // The parent's own turn-end payload enumerates the harness's live
    // background work, and it is the ONLY enumeration that can be trusted.
    // Edge events alone leak: a background child killed with `TaskStop` fires
    // no lifecycle hook at all (measured against Claude Code 2.1.296 — neither
    // SubagentStop nor PostToolUse runs on that path), so a row its
    // SubagentStart added would otherwise sit "running" forever, and a resume
    // re-fires SubagentStart, re-adding the child each time (operator report,
    // 2026-10-20: a killed fixer pinned the rail for hours). This snapshot is
    // the FULL current set — the server replaces its roster with it, and the
    // children it omits are genuinely gone. Only `subagent` entries belong on
    // the rail; the same array also carries background bash, crons and
    // monitors. An older harness without the field reports nothing, keeping
    // the edge-event behaviour that works there. SubagentStop is deliberately
    // NOT a snapshot source: measured on the same build, its own payload still
    // lists the finishing child as "running", so a snapshot from it would
    // re-add the very child it announces dead.
    if (hook === "Stop" && Array.isArray(payload.background_tasks)) {
      const agents = payload.background_tasks
        .flatMap((task) => {
          if (!task || typeof task !== "object") return [];
          const entry = task as Record<string, unknown>;
          if (entry.type !== "subagent" || typeof entry.id !== "string" || !entry.id || entry.id.length > 256)
            return [];
          const type = typeof entry.agent_type === "string" ? entry.agent_type.trim() : "";
          const description = typeof entry.description === "string" ? entry.description.trim() : "";
          return [
            {
              id: entry.id,
              name: (type || "Subagent").slice(0, 160),
              status: entry.status === "running" ? "running" : entry.status === "pending" ? "waiting" : "idle",
              ...(description ? { activity: description.slice(0, 160) } : {}),
            },
          ];
        })
        .slice(0, 256);
      return { path: "subagents/report", json: { event: "snapshot", agents } };
    }
    const id = hermes ? extra.child_session_id : payload.agent_id;
    if (typeof id !== "string" || !id || id.length > 256) return undefined;
    if (hook === "SubagentStop" || hook === "subagent_stop")
      return { path: "subagents/report", json: { event: "stop", agentId: id } };
    if (hook !== "SubagentStart" && hook !== "subagent_start") return undefined;
    const metadata = hermes ? {} : await claudeAgentMetadata(payload.transcript_path, id);
    const label = metadata.name ?? (hermes ? extra.child_role : payload.agent_type);
    // A whitespace-only type label is the same absence as none, and the
    // sidebar numbers the generic name the same way the pi bridge does.
    const name = typeof label === "string" && label.trim() ? label : "Subagent";
    // Hermes names the task right here (`child_goal`); Claude Code's label
    // arrives from the PreToolUse branch above. Hermes's `child_summary` is
    // the child's OUTPUT, and stays exactly as private as the prompt.
    const goal = hermes ? extra.child_goal : metadata.activity;
    const activity = typeof goal === "string" && goal.trim() ? goal.trim().slice(0, 160) : undefined;
    return {
      path: "subagents/report",
      json: {
        event: "start",
        agents: [{ id, name: name.slice(0, 160), status: "running", ...(activity ? { activity } : {}) }],
      },
    };
  }

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
    return { path: "exit", json: { exitCode: code } };
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

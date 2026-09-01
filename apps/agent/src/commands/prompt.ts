import { stripAnsi } from "@internal/backend-errors";
import type { JsonValue, NodePromptDeliverResult } from "@internal/session-protocol";
import { resolveSocket } from "./basics.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * The `prompt_deliver` executor (spec 2026-08-31 §6.5) — a verbatim port of
 * `LocalLauncher.deliverPrompt`: poll `capture-pane` until the pane shows
 * output (a blank screen means the harness is still booting), then type the
 * prompt and press Enter. Never settled — or an input failure — reports
 * delivery as `false` rather than typing blind. No throws escape the executor;
 * timeouts have no side effects.
 *
 * The two seam differences from the local original: the socket comes from the
 * per-session meta store (via `resolveSocket`, id-gated), and the deadline
 * math runs on the injectable `ctx.nowMs()` clock so tests own time.
 */

/**
 * Types `text` into a freshly-spawned pane once it shows output, then submits
 * with Enter. Port of `LocalLauncher.deliverPrompt` (spec §3.4/§6.5).
 * @param ctx - the per-daemon execution context (tmux, meta, injectable clock)
 * @param cmd - the verified `prompt_deliver` command
 * @returns `{ok:true, data:{promptDelivered}}` — always; a malformed session id
 * answers `{ok:false, error:"invalid session id"}` (the store-throwing-id rule,
 * enforced here so the promise itself never rejects).
 */
export async function execPromptDeliver(ctx: CommandContext, cmd: Cmd<"prompt_deliver">): Promise<CommandResult> {
  let socket: string;
  try {
    socket = await resolveSocket(ctx, cmd.sessionId); // id gate FIRST (store throws on bad ids)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const settled = await waitForSettled(ctx, socket, cmd.sessionId, cmd.settleTimeoutMs, cmd.pollMs);
  let promptDelivered = false;
  if (settled) {
    try {
      ctx.tmux.sendInput(socket, cmd.sessionId, cmd.text);
      ctx.tmux.pressEnter(socket, cmd.sessionId);
      promptDelivered = true;
    } catch {
      // an input failure is a false answer, never a throw — the caller decides what to do
    }
  }
  // JSON-safe by construction (`node-results.ts` owns the shape); an interface
  // cannot structurally satisfy JsonValue's index signature, so the seam cast
  // is the intended route (same as execProbe).
  const data: NodePromptDeliverResult = { promptDelivered };
  return { ok: true, data: data as unknown as JsonValue };
}

/**
 * Poll `capture-pane` until the screen holds anything after ANSI stripping —
 * a blank pane is still booting. Capture errors are swallowed (the pane is
 * simply not queryable yet; keep polling). Bounded by `settleTimeoutMs` on the
 * injected clock, paced by real `pollMs` sleeps (a fake-timer host controls
 * both).
 * @returns true when the pane showed output inside the window
 */
async function waitForSettled(
  ctx: CommandContext,
  socket: string,
  sessionId: string,
  settleTimeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = ctx.nowMs() + settleTimeoutMs;
  while (ctx.nowMs() < deadline) {
    try {
      if (stripAnsi(ctx.tmux.capturePane(socket, sessionId)).trim()) return true;
    } catch {
      // pane not queryable yet; keep polling
    }
    await Bun.sleep(pollMs);
  }
  return false;
}

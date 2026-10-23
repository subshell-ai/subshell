import { deliverPromptInto } from "@internal/pane-runtime";
import type { JsonValue, NodePromptDeliverResult } from "@internal/subshell-protocol";
import { resolveSocket } from "./basics.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * The `prompt_deliver` executor (spec 2026-08-31 §6.5) — the node-side half
 * of the ONE prompt-delivery policy, which lives in
 * `@internal/pane-runtime`'s `deliverPromptInto` (the control plane's
 * `LocalLauncher.deliverPrompt` calls the same function). The pane gets the
 * prompt once it shows output, and the Enter waits until the typed text is
 * visible on screen: a harness that renders early and mounts its stdin
 * reader late eats a queued Enter as a paste, leaving the prompt sitting
 * unsubmitted. Never settled — or an input failure — reports delivery as
 * `false` rather than typing blind. No throws escape the executor; timeouts
 * have no side effects.
 *
 * The two seam differences from the local original: the socket comes from the
 * per-subshell meta store (via `resolveSocket`, id-gated), and the deadline
 * math runs on the injectable `ctx.nowMs()` clock so tests own time.
 */

/**
 * Types `text` into a freshly-spawned pane once it shows output, then submits
 * with Enter — through the shared `deliverPromptInto` (spec §3.4/§6.5).
 * @param ctx - the per-daemon execution context (tmux, meta, injectable clock)
 * @param cmd - the verified `prompt_deliver` command
 * @returns `{ok:true, data:{promptDelivered}}` — always; a malformed subshell id
 * answers `{ok:false, error:"invalid subshell id"}` (the store-throwing-id rule,
 * enforced here so the promise itself never rejects).
 */
export async function execPromptDeliver(ctx: CommandContext, cmd: Cmd<"prompt_deliver">): Promise<CommandResult> {
  let socket: string;
  try {
    socket = await resolveSocket(ctx, cmd.subshellId); // id gate FIRST (store throws on bad ids)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const promptDelivered = await deliverPromptInto(ctx.tmux, socket, cmd.subshellId, cmd.text, {
    settleTimeoutMs: cmd.settleTimeoutMs,
    pollMs: cmd.pollMs,
    nowMs: () => ctx.nowMs(),
  });
  // JSON-safe by construction (`node-results.ts` owns the shape); an interface
  // cannot structurally satisfy JsonValue's index signature, so the seam cast
  // is the intended route (same as execProbe).
  const data: NodePromptDeliverResult = { promptDelivered };
  return { ok: true, data: data as unknown as JsonValue };
}

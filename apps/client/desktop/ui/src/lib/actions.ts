/**
 * The shape of a guarded action, shared by the runner and the screens.
 *
 * Two rules from the vanilla page survive as types here, because both were
 * bugs before they were rules:
 *
 * 1. An action reports its own words ({@link ActionOutcome.output}), and the
 *    re-probe that follows it cannot overwrite them — the probe is a separate
 *    query and this value is derived from the MUTATION.
 * 2. An action may end by ASKING instead of doing
 *    ({@link ActionOutcome.confirm}), so nothing destructive happens on one
 *    click. The confirmation carries its own `run`, which goes back through the
 *    same runner and is therefore serialized like any other action.
 */
import type { ActionResult } from "@/lib/ipc";

/** What one action produced. */
export interface ActionOutcome {
  /** CLI output to render VERBATIM, or null to leave the output block empty. */
  output: ActionResult | null;
  /** A confirmation this action raised instead of finishing. */
  confirm: PendingConfirmation | null;
}

/** An action body. Runs inside the runner's serialization, never on its own. */
export type ActionRun = () => Promise<ActionOutcome>;

/** Something the user has to accept before it happens. */
export interface PendingConfirmation {
  title: string;
  /** One paragraph each. CLI text quoted in here keeps its whitespace. */
  messages: string[];
  acceptLabel: string;
  /** Re-submitted through the runner on an explicit accept — never automatically. */
  run: ActionRun;
}

/** An action that finished, with the CLI's own words (or none). */
export function finished(output: ActionResult | null): ActionOutcome {
  return { output, confirm: null };
}

/**
 * An action that is ASKING. `output` is whatever the attempt already said —
 * a restart refusal, for instance, which the confirmation then quotes.
 */
export function asks(confirm: PendingConfirmation, output: ActionResult | null = null): ActionOutcome {
  return { output, confirm };
}

/**
 * A rejection as a sentence.
 *
 * Tauri surfaces a Rust `Err(String)` as the string itself, and those strings
 * are actionable: `node_open_path` rejects with the `journalctl` command to run
 * instead, `node_set_plane` with "the server URL must be http or https".
 */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return String(message ?? err);
}

import { BackendErrorCodes, throwApiError } from "@internal/backend-errors";
import { SSH_ERROR_DESCRIPTIONS, type SshErrorCode } from "@internal/subshell-protocol";
import type { SshDecision, SshPolicyCode } from "@/services/ssh/ssh-policy.js";

/**
 * The refusal grammar of the SSH surface, stated once so every route (and,
 * through them, MCP prose and SPA copy) maps a decision the same way -
 * `ssh-api-types.ts`'s header: refusals carry the named code in
 * `code`/metadata, equality over parsing a sentence.
 *
 * The HTTP shape follows the house convention the policy doc names:
 * `not_found` → 404 (the non-enumerating invisibility), every other refusal →
 * 403, quota/storage refusals → 409 (a state to wait out, not a permission
 * to request), and the node's `run_conflict`/`run_unknown` → 409 like the
 * other durable-dispatch facts.
 */

/** One named SSH refusal an operation surfaced (node answer or policy decision). */
export class SshRefusalError extends Error {
  readonly status: number;
  /** The frozen named code (`SshErrorCode` or `SshPolicyCode`), verbatim on the wire. */
  readonly sshCode: SshErrorCode | SshPolicyCode;
  constructor(sshCode: SshErrorCode | SshPolicyCode, status: number, message: string) {
    super(message);
    this.name = "SshRefusalError";
    this.sshCode = sshCode;
    this.status = status;
  }
}

/**
 * Throw the route-visible error for a policy {@link SshDecision}. The named
 * code rides `metadataSafe.sshCode` so E's `describeToolError` and the SPA
 * can branch on it; the message is a fixed sentence per code (never state the
 * policy refused to carry).
 */
export function refuseSshDecision(decision: Extract<SshDecision, { allow: false }>): never {
  const { code, detail } = decision;
  const _status = code === "not_found" ? 404 : 403;
  throwApiError({
    code: code === "not_found" ? BackendErrorCodes.NOT_FOUND_ERROR : BackendErrorCodes.ACCESS_DENIED,
    message: POLICY_SENTENCES[code],
    doNotLog: true,
    ...(detail === undefined ? {} : { metadataSafe: { sshCode: code, detail } }),
  });
}

/** The one sentence per policy code; the remedy's LOCATION, never a diagnosis of hidden state. */
const POLICY_SENTENCES: Record<SshPolicyCode, string> = {
  cookie_required: "SSH configuration acts require a signed-in human session, not a machine credential.",
  not_found: "Not found.",
  not_granted: "This connection is not granted to this pane. A human grants it from SSH connections settings.",
  grant_revoked: "The grant for this connection was revoked. A human must grant it again.",
  token_stale:
    "This pane's credential predates its last restart, and grants bind the current one. A human can re-grant the restarted pane.",
  revision_mismatch:
    "The connection's configuration changed since this access was granted; the grant pins the old revision.",
  pane_lifecycle: "The pane is not in a lifecycle state that admits this act (not running, or already ended).",
  node_ineligible: "The connecting node is offline, in maintenance, or otherwise not taking SSH work right now.",
  human_control: "A human holds this terminal's input; agent reads and writes stay blocked until it is returned.",
  sharing_unsupported: "SSH panes and connections cannot be shared in v1.",
  active_work: "This connection has runs or managed terminals still active; finish or stop them first.",
};

/**
 * Throw for a named {@link SshErrorCode} — the node's refusal (matched by
 * EQUALITY on `NodeRpcError.detail`, or carried in a parsed result envelope)
 * or a config-grammar refusal from the server's own validation. The sentence
 * is the protocol's own shipped description; the code rides the metadata.
 */
export function refuseSshErrorCode(code: SshErrorCode, extra?: string): never {
  throwApiError({
    code:
      code === "run_conflict" ||
      code === "run_unknown" ||
      code === "quota_runs" ||
      code === "quota_terminals" ||
      code === "storage_full"
        ? BackendErrorCodes.EXISTS_ERROR
        : BackendErrorCodes.ACCESS_DENIED,
    message: extra === undefined ? SSH_ERROR_DESCRIPTIONS[code] : `${SSH_ERROR_DESCRIPTIONS[code]} (${extra})`,
    doNotLog: true,
    metadataSafe: { sshCode: code },
  });
}

import { BackendErrorCodes } from "@internal/backend-errors";
import type { SshAnswer } from "@/services/ssh-launch.service.js";
import type { SetupHereResult } from "@/services/ssh-setup-here.service.js";

/** Only host-selected stages cross the status endpoint; installer output never does. */
export type SshSetupStage = "checking" | "installing" | "connecting" | "complete" | "failed";
export interface SshSetupProgress {
  /** Server-observed stage; no installer output is exposed. */
  stage: SshSetupStage;
  /** ISO timestamp for elapsed-time display. */
  startedAt: string;
  /** Enrolled destination once its connection is confirmed. */
  nodeId: string | null;
  /** Safe failure explanation. */
  error: string | null;
}

/** Owner-scoped, bounded status for installs that outlive a browser request or dialog. */
export function createSshSetupTracker(now = Date.now) {
  const entries = new Map<
    string,
    { progress: SshSetupProgress; settledAt: number | null; result: Promise<SshAnswer<SetupHereResult>> }
  >();
  const key = (owner: string, pane: string) => JSON.stringify([owner, pane]);
  const prune = () => {
    for (const [id, entry] of entries)
      if (entry.settledAt !== null && now() - entry.settledAt > 3_600_000) entries.delete(id);
  };
  return {
    read(owner: string, pane: string): SshSetupProgress | null {
      prune();
      const value = entries.get(key(owner, pane))?.progress;
      return value ? { ...value } : null;
    },
    run(
      owner: string,
      pane: string,
      work: (stage: (value: SshSetupStage) => void) => Promise<SshAnswer<SetupHereResult>>,
    ): Promise<SshAnswer<SetupHereResult>> {
      prune();
      const id = key(owner, pane);
      const existing = entries.get(id);
      if (existing && existing.progress.stage !== "failed") return existing.result;
      if (!existing && entries.size >= 500)
        return Promise.resolve({
          ok: false,
          refusal: {
            status: 409,
            code: BackendErrorCodes.SSH_UPGRADE_FAILED,
            message: "Too many recent setup operations. Try again later.",
          },
        });
      const progress: SshSetupProgress = {
        stage: "checking",
        startedAt: new Date(now()).toISOString(),
        nodeId: null,
        error: null,
      };
      const entry = {
        progress,
        settledAt: null as number | null,
        result: Promise.resolve().then(() =>
          work((stage) => {
            progress.stage = stage;
          }),
        ),
      };
      entries.set(id, entry);
      entry.result = entry.result.then(
        (answer) => {
          entry.settledAt = now();
          progress.stage = answer.ok ? "complete" : "failed";
          if (answer.ok) progress.nodeId = answer.value.nodeId;
          else
            progress.error =
              answer.refusal.status === 422 ? "The destination could not be set up." : answer.refusal.message;
          return answer;
        },
        () => {
          entry.settledAt = now();
          progress.stage = "failed";
          progress.error = "Setup status could not be confirmed. Check the destination and Nodes before retrying.";
          return {
            ok: false,
            refusal: { status: 502, code: BackendErrorCodes.SSH_NODE_REFUSED, message: progress.error },
          };
        },
      );
      return entry.result;
    },
  };
}

/** No timers, credentials, sockets or disk access at import time. */
export const sshSetupTracker = createSshSetupTracker();

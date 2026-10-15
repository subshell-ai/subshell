import { apiFetch, apiPost, errMessage, isAlreadyGone } from "@internal/node-admin";
import { parseSshKeyBridgeResult, SSH_AGENT_FAILURE_BASE64, SSH_LOCAL_KEY_TTL_MS } from "@internal/subshell-protocol";
import { desktopInvoke, desktopInvokeStrict } from "@/lib/desktop";
import type { SshLaunchRequest, SshLaunchResponse } from "@/lib/ssh";
import { type BrowserKeyMaterial, type LocalKeySigner, openBrowserKey } from "@/lib/ssh-browser-key";

export interface LocalKeyPreparation {
  id: string;
  host: string;
  port: number;
  user: string;
  hostKey: string;
}
interface NativeSelection {
  id: string;
  publicKey: string;
  expiresAt: number;
}

/** Only public agent traffic crosses the API; private signing stays on this device. */
export async function launchWithLocalKey(
  request: SshLaunchRequest,
  launch: (request: SshLaunchRequest) => Promise<SshLaunchResponse>,
  onLaunched: (id: string) => void,
  signal: AbortSignal,
  browser?: {
    take: () => BrowserKeyMaterial;
    confirm: (target: LocalKeyPreparation) => Promise<boolean>;
  },
  onDiscarded?: () => void,
): Promise<SshLaunchResponse | null> {
  if (!browser && !(await desktopInvoke("desktop_ssh_key_available")))
    throw new Error("Open this server in an updated Subshell desktop app to use a key from your machine.");
  let prepared: LocalKeyPreparation | undefined;
  let signer: LocalKeySigner | undefined;
  let selected: NativeSelection | null = null;
  let picking = false;
  let created: SshLaunchResponse | undefined;
  let signed = false;
  const check = () => {
    if (signal.aborted) throw new Error("SSH key selection was cancelled.");
  };
  const closeNative = () => {
    signer?.close();
    if (selected) void desktopInvoke("desktop_ssh_key_close", { id: selected.id });
    else if (picking) void desktopInvoke("desktop_ssh_key_close", {});
  };
  signal.addEventListener("abort", closeNative);
  window.addEventListener("pagehide", closeNative);
  try {
    check();
    prepared = await apiPost<LocalKeyPreparation>("/api/ssh/local-key", {
      node: request.node,
      destination: request.destination,
      ...(request.expectedDestination ? { expectedDestination: request.expectedDestination } : {}),
    });
    check();
    if (browser) {
      if (!(await browser.confirm(prepared))) return null;
      check();
      signer = await openBrowserKey(browser.take(), prepared, signal);
      check();
    } else {
      picking = true;
      try {
        selected = await desktopInvokeStrict<NativeSelection | null>("desktop_ssh_key_pick", {
          host: prepared.host,
          port: prepared.port,
          user: prepared.user,
          hostKey: prepared.hostKey,
        });
      } finally {
        picking = false;
      }
      check();
      if (!selected) return null;
      const handle = selected.id;
      signer = {
        expiresAt: selected.expiresAt,
        request: (payload) =>
          desktopInvokeStrict<{ response: string; done: boolean }>("desktop_ssh_key_request", {
            id: handle,
            request: payload,
          }),
        close: () => {
          void desktopInvoke("desktop_ssh_key_close", { id: handle });
        },
      };
    }
    created = await launch({ ...request, localKeyId: prepared.id });
    onLaunched(created.subshell.id);
    const deadline = Math.min(signer.expiresAt, Date.now() + SSH_LOCAL_KEY_TTL_MS);
    let reply: { seq: number; payload: string } | undefined;
    while (Date.now() < deadline) {
      check();
      const raw = await apiPost<unknown>(`/api/ssh/local-key/${prepared.id}/exchange`, reply ? { reply } : {});
      reply = undefined;
      const state = parseSshKeyBridgeResult(raw);
      if (!state) throw new Error("The connecting node returned an invalid SSH signing request.");
      if (state.done) {
        if (!signed)
          throw new Error(
            "SSH ended before requesting a signature. Confirm that your selected key is authorized for the destination account. If it is, check that the node and destination support host-bound SSH authentication.",
          );
        return created;
      }
      if (state.request) {
        check();
        const answer = await signer.request(state.request.payload);
        // Accumulate, never re-derive: once one signature has been issued,
        // every later answer - including a failure reply - keeps the attempt
        // "signed", and the catch block's keep-the-pane rule must hold.
        signed ||= answer.done && answer.response !== SSH_AGENT_FAILURE_BASE64;
        reply = { seq: state.request.seq, payload: answer.response };
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(
      "The temporary key expired before SSH authentication finished. Start a new connection to choose the key again.",
    );
  } catch (error) {
    // Before a signature is issued, this attempt cannot have authenticated.
    // Once one is issued, a transport error leaves the outcome uncertain:
    // preserve the subshell instead of potentially killing a working login.
    if (created && !signed) {
      signer?.close();
      try {
        await apiFetch(`/api/subshells/${created.subshell.id}`, { method: "DELETE" });
      } catch (cleanupError) {
        if (!isAlreadyGone(cleanupError))
          throw new Error(
            `${errMessage(error, "SSH authentication failed.")} The failed subshell couldn't be removed. Remove it from the subshell list before retrying.`,
          );
      }
      onDiscarded?.();
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", closeNative);
    window.removeEventListener("pagehide", closeNative);
    signer?.close();
    if (selected) await desktopInvoke("desktop_ssh_key_close", { id: selected.id });
    if (prepared) await apiFetch(`/api/ssh/local-key/${prepared.id}`, { method: "DELETE" }).catch(() => {});
  }
}

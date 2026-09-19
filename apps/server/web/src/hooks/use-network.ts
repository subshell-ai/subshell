import { ApiError, apiFetch, NetworkError, parseErrorBody } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readInstallStream } from "@/hooks/use-install-agent";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";
import type {
  NetworkInstallResult,
  NetworkJoinResult,
  NetworkLeaveResult,
  NetworkList,
  NetworkPublishResult,
  NetworkUnpublishResult,
} from "@/types/network";

/** Query key of the network plugin list (`GET /api/network`, admin cookie only). */
export const NETWORK_QUERY_KEY = ["network"] as const;

/**
 * The key EVERY write below is filed under, so a page can ask "is anything
 * happening to a network right now" with `useIsMutating` instead of each card
 * reporting its own busy state upwards.
 *
 * That question has a real consumer: the list polls slowly at rest and
 * quickly while an act is in flight, and the act lives in a card the route
 * does not otherwise hear from.
 */
export const NETWORK_MUTATION_KEY = ["network", "op"] as const;

/**
 * The network plugins and where each one stands on this host.
 *
 * `enabled` is the caller's CONFIRMED admin flag rather than a default of
 * true: every route in this group 403s everyone else, so an unknown flag must
 * read as not-admin or a member's mount fires a doomed request — the gate
 * `/settings/status` established and `/settings/service` copies.
 *
 * The cadence is the caller's because the right one depends on what is on
 * screen: a page watching for an interactive sign-in to complete has to poll
 * in seconds, and a page at rest is reading facts that change only when
 * somebody changes them.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 * @param refetchMs - poll cadence in ms; omitted = no polling
 */
export function useNetwork(enabled: boolean, refetchMs?: number) {
  return useQuery({
    queryKey: NETWORK_QUERY_KEY,
    queryFn: () => apiFetch<NetworkList>("/api/network"),
    enabled,
    refetchInterval: refetchMs,
    // Matched to the interval, so a remount never renders a view older than
    // the cadence the page promises. Unset means "no promise".
    staleTime: refetchMs,
  });
}

/**
 * One field's complaint from a 400 `PATCH .../settings`.
 *
 * The route answers with `issues: [{ field, message }]` rather than one
 * sentence, because a settings form has several inputs and a refusal about
 * the third of them belongs under the third of them.
 */
export interface NetworkSettingsIssue {
  /** The `settingsFields` key it is about */
  field: string;
  /** What is wrong with the value that was sent */
  message: string;
}

/**
 * A settings refusal that names fields.
 *
 * `apiFetch` throws the message and drops the body, which is exactly the part
 * the form needs — so this call reads its own failure body and carries the
 * issues on the error it throws. Still an {@link ApiError}, so every caller
 * that only wants a sentence keeps working.
 */
export class NetworkSettingsError extends ApiError {
  /** Per-field refusals; empty when the server named no field */
  readonly issues: NetworkSettingsIssue[];
  constructor(
    status: number,
    message: string,
    meta: { code?: string; errId?: string },
    issues: NetworkSettingsIssue[],
  ) {
    super(status, message, meta);
    this.name = "NetworkSettingsError";
    this.issues = issues;
  }
}

/** The `issues` array of a failed settings body, or empty when it carries none. */
function issuesOf(raw: string): NetworkSettingsIssue[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const issues = (parsed as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) return [];
    return issues.flatMap((entry) => {
      const { field, message } = (entry ?? {}) as { field?: unknown; message?: unknown };
      return typeof field === "string" && typeof message === "string" ? [{ field, message }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Writes the plugin's own settings (`PATCH /api/network/:id/settings`).
 *
 * Every value goes as a STRING, including a secret: the form never holds a
 * stored secret (the list reports `{ set }` in its place), so what is sent is
 * only ever what was just typed.
 */
export function useUpdateNetworkSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: NETWORK_MUTATION_KEY,
    mutationFn: async ({ id, settings }: { id: string; settings: Record<string, string> }): Promise<{ ok: true }> => {
      let res: Response;
      try {
        res = await fetch(`/api/network/${id}/settings`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        });
      } catch (err) {
        throw new NetworkError(err);
      }
      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        const { message, code, errId } = parseErrorBody(raw);
        throw new NetworkSettingsError(res.status, message, { code, errId }, issuesOf(raw));
      }
      return (await res.json()) as { ok: true };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY }),
  });
}

/**
 * POSTs to an NDJSON route and reads it to its terminal frame.
 *
 * The protocol, the stall bound and the "ended without saying" failure are
 * {@link readInstallStream}'s, shared with the agent and tmux installers —
 * these routes stream the same frames for the same reason, and a second copy
 * of that reader would be a second place for them to drift.
 *
 * Read with `fetch` rather than `EventSource` for the reason the installers
 * are: the route streams from an ordinary POST, so the HttpOnly cookie goes
 * with it and the admin gate is the one that was already there.
 */
async function streamPost<TDone>(path: string, body: unknown, onLine?: (line: string) => void): Promise<TDone> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(err);
  }
  // Refusals are decided before the body opens — not an admin, no such
  // plugin, an act this state does not allow — so they are still a status
  // code with a JSON body, and should surface as the ApiError every other
  // call produces.
  if (!res.ok) {
    const { message, code, errId } = parseErrorBody(await res.text().catch(() => ""));
    throw new ApiError(res.status, message, { code, errId });
  }
  if (!res.body) throw new ApiError(res.status, "The server sent no output.");
  return await readInstallStream<TDone>(res.body, onLine);
}

/**
 * Runs the plugin's own install command on the control-plane host
 * (`POST /api/network/:id/install`), reporting the installer's output as it
 * arrives.
 *
 * Offered only for a row carrying `install`: a privileged command is copy-only
 * because the server has no terminal to answer a password prompt, which is the
 * same rule the tmux installer follows.
 *
 * @param onLine - called with each line the installer prints, and the row it belongs to
 */
export function useInstallNetwork(onLine?: (id: string, line: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: NETWORK_MUTATION_KEY,
    mutationFn: ({ id }: { id: string }) =>
      streamPost<NetworkInstallResult>(`/api/network/${id}/install`, {}, (line) => onLine?.(id, line)),
    // Settled, not succeeded: an installer that exited non-zero may still
    // have changed the host, and the row's own status is what answers.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY }),
  });
}

/**
 * Joins the network (`POST /api/network/:id/join`).
 *
 * Two shapes of the same act, and the outcome says which happened: a
 * credential (an auth key, a token) joins outright, while an empty body starts
 * an interactive sign-in and comes back `needs-login` with a URL for the
 * person to open. The page polls from there — the vendor tells the DAEMON that
 * the sign-in landed, never this browser.
 *
 * Settled, not succeeded: a join that reached `needs-login` changed nothing
 * yet, but a stream that failed after the daemon joined may already have
 * widened the list.
 *
 * @param onLine - called with each line the join prints, and the row it belongs to
 */
export function useJoinNetwork(onLine?: (id: string, line: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: NETWORK_MUTATION_KEY,
    mutationFn: ({ id, credential, hostname }: { id: string; credential?: string; hostname?: string }) =>
      streamPost<NetworkJoinResult>(
        `/api/network/${id}/join`,
        // Absence, never null: an empty body is what asks for the interactive
        // path, and a `credential: ""` beside it is a different request.
        { ...(credential ? { credential } : {}), ...(hostname ? { hostname } : {}) },
        (line) => onLine?.(id, line),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
      // A join to a private network widens the EFFECTIVE allowlist the moment
      // the plugin reports addresses — no publish, no config write, no
      // restart (2026-09-16) — and `GET /api/settings/public → trustedOrigins`
      // is where the mobile dialog and the setup checklist read it. Left
      // stale, the picker a person opens seconds after joining a tailnet
      // still showed loopback only for up to 30 s.
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    },
  });
}

/**
 * Publishes this server on the network (`POST /api/network/:id/publish`).
 *
 * It writes nothing to config.env — the server trusts the published addresses
 * live (2026-09-16) — so the invalidations are the list and the public
 * settings.
 */
export function usePublishNetwork(onLine?: (id: string, line: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: NETWORK_MUTATION_KEY,
    mutationFn: ({ id }: { id: string }) =>
      streamPost<NetworkPublishResult>(`/api/network/${id}/publish`, {}, (line) => onLine?.(id, line)),
    // Settled rather than succeeded: a publish that was REFUSED still tells
    // the row something (the refusal is an answer), and a publish that failed
    // mid-way may already have trusted addresses before it did.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    },
  });
}

/**
 * Stops publishing this server on the network; the machine stays joined.
 * The origins this unpublish names stop being accepted the moment the server
 * answers, and the public settings say so.
 */
export function useUnpublishNetwork() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: NETWORK_MUTATION_KEY,
    mutationFn: ({ id }: { id: string }) =>
      apiFetch<NetworkUnpublishResult>(`/api/network/${id}/unpublish`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    },
  });
}

/**
 * Leaves the network entirely (`POST /api/network/:id/leave`). The answer
 * names the origins that stopped being trusted with it — for an
 * implicit-publish network this, not the unpublish button, is the press that
 * takes its addresses off the allowlist.
 *
 * `confirm` is the route's own guard — it carries what the person typed, and
 * the server decides whether it matches. The card asks for it rather than
 * inventing a value, so the two ends cannot disagree about what confirms.
 */
export function useLeaveNetwork() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: NETWORK_MUTATION_KEY,
    mutationFn: ({ id, confirm }: { id: string; confirm: string }) =>
      apiFetch<NetworkLeaveResult>(`/api/network/${id}/leave`, {
        method: "POST",
        body: JSON.stringify({ confirm }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
    },
  });
}

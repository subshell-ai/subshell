/**
 * Deciding whether a socket may attach, and to what.
 *
 * Split from the attach itself because it is a different question with a
 * different shape: everything here is "who is asking, may they, and about
 * which subshell", it ends at one decision, and it needs no WebSocket — the
 * caller hands in the three things it reads (the URL, the cookie header, the
 * User-Agent) and gets an outcome back. That is what makes the auth path
 * testable without standing up a socket, which it previously was not.
 *
 * Refusals are RETURNED rather than closed here, so the one place that owns
 * the socket also owns every close code.
 */

import type { SubshellTable } from "@/db/types/subshells.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { type Access, accessAtLeast, loadSubshellAccess } from "@/lib/subshell-access.js";
import { logger } from "@/utils/logger.js";
import { type AttachParams, parseAttachParams } from "@/ws/attach-params.js";
import { consumeWsToken } from "@/ws/ws-token.js";

/** What the attach handler reads about the caller; no socket required. */
export interface AttachRequest {
  /** The connect URL, query intact. */
  url: URL;
  /** Raw `Cookie` header, for the no-token path (same-host WS, no proxy). */
  cookieHeader: string;
  /** User-Agent, for the attach log line. */
  attachUa: string;
}

/** The attach may proceed. */
export interface AttachResolved {
  ok: true;
  /** The subshell row the socket attaches to. */
  row: SubshellTable;
  /** The caller's access to it — `view` watches, `edit`/`owner` may type. */
  access: Access;
  /** What the client declared on its URL. */
  params: AttachParams;
}

/** The attach is refused; the caller closes with exactly this. */
export interface AttachRefused {
  ok: false;
  /** WebSocket close code (4001 unauthorized, 4004 not found). */
  code: number;
  /** Close reason, shown in the client's console. */
  reason: string;
}

/**
 * Authenticates the caller, resolves their access to the subshell, and reads
 * what the client declared about itself.
 *
 * @param input - The URL, cookie header and User-Agent behind the socket
 * @returns The row, access and params, or the refusal to close with
 */
export async function resolveAttach(input: AttachRequest): Promise<AttachResolved | AttachRefused> {
  const subshellId = input.url.searchParams.get("subshell");
  if (!subshellId) return { ok: false, code: 4001, reason: "missing subshell" };

  // Auth: the `token` query param is a short-lived WS token issued by
  // POST /api/auth/ws-token (the frontend authenticates via its HttpOnly
  // cookie on that call). Fall back to reading the session cookie when it
  // reaches us directly (same-host WS without a proxy).
  const tokenParam = input.url.searchParams.get("token");

  let userId: string | null = null;
  if (tokenParam) {
    userId = consumeWsToken(tokenParam);
  } else {
    // Same shared extraction as the REST guard — accepts the https
    // `__Secure-` spelling and re-presents it under both names.
    const session = await resolveCookieSession(input.cookieHeader);
    userId = session?.user.id ?? null;
  }
  if (!userId) return { ok: false, code: 4001, reason: "unauthorized" };

  const { repos } = getRequestlessContext();
  // Resolve the caller's access to THIS subshell (a human browser path: admin
  // and shared grants both count). Invisible (absent or unshared) closes with
  // the same 4004 an owner-mismatch used to, so a stranger learns nothing.
  const { row, access } = await loadSubshellAccess(
    { subshells: repos.subshells, shares: repos.subshellShares, userMeta: repos.userMeta },
    userId,
    subshellId,
  );
  // Invisible and refused look identical on the wire, so a stranger cannot
  // probe ids: absent, unshared and forbidden all answer the same 4004.
  if (!row || !accessAtLeast(access, "view")) return { ok: false, code: 4004, reason: "subshell not found" };

  // The client's fitted geometry rides the URL so the pane can be resized
  // BEFORE the replay is captured: a capture taken at tmux's 80×24 birth size
  // (or any stale size) re-wraps history rows against the wrong column count,
  // which is exactly the mis-positioned garbage that used to scroll up and
  // stay garbled. Both attach branches consume it.
  // Every attach input, read off the URL once — see `attach-params.ts`.
  const params = parseAttachParams(input.url);
  // One line per attach makes "still jumbled" reports diagnosable from the
  // journal alone: `geometry WxH` proves the browser's cols/rows survived
  // proxy + plugin handoff; `geometry MISSING` names the remaining culprits
  // (stale client bundle that sends no geometry, or a proxy stripping the
  // WS upgrade query).
  // The UA names the app behind the socket: `geometry MISSING` plus a plain
  // browser UA = a stale PWA bundle that predates the geometry feature (and
  // the paste fixes) — a reload/reinstall is the cure, not a server change.
  // It rides `ws.data.attachUa`, stashed by the plugin's `upgrade` hook,
  // because `ws.raw.request` is NOT populated in Elysia's WS open context
  // (that read is the fallback for direct callers, e.g. tests).
  const ua = input.attachUa;
  // WHICH BUNDLE is asking. A cached PWA keeps running old JavaScript across
  // any number of server deploys, and static requests are not logged, so
  // "did the client actually load the fix" was unanswerable — the 2026-09-04
  // session burned hours on renderer theories while the phone may never have
  // fetched the new chunk. `build=` is the client's own asset hash, so a
  // reload is visible as a CHANGED id; `build MISSING` is itself the answer,
  // meaning a bundle older than this line.
  logger.info(
    params.size
      ? `ws attach ${row.id}: geometry ${params.size.cols}x${params.size.rows} build=${params.build} ua="${ua.slice(0, 90)}"`
      : `ws attach ${row.id}: geometry MISSING (stale client predates cols/rows) build=${params.build} ua="${ua.slice(0, 90)}"`,
  );
  return { ok: true, row, access, params };
}

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
import { accountDisabled } from "@/services/account-status.js";
import { logger } from "@/utils/logger.js";
import { type AttachParams, parseAttachParams } from "@/ws/attach-params.js";
import { consumeWsToken, type WsTokenIdentity } from "@/ws/ws-token.js";

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
  /**
   * Whose account admitted this socket — the token's recorded identity or the
   * cookie's user. The attach stamps it onto `ws.data.attachUserId` so an
   * account disable can FIND the open socket later: the viewer registry keys
   * panes, not people (see `ws/viewers.ts:dropTerminalSocketsFor`).
   */
  userId: string;
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
  /**
   * WebSocket close code (4001 unauthorized; 4005 subshell not found; 4004
   * the transient family — not running, unreachable, node offline — which
   * the Wave D client retries).
   */
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

  let identity: WsTokenIdentity | null = null;
  if (tokenParam) {
    identity = consumeWsToken(tokenParam);
    // A SCOPED token (any Bearer-key mint — the route binds one at issue
    // time) can attach ONLY to the pane it names. Checked AFTER consumption,
    // so a wrong-subshell attempt burns the token: one guess per captured
    // token, never a free binding oracle. The refusal is the SAME pair a bad
    // token gets, so a scoped token cannot probe which ids exist either.
    if (identity && identity.subshellId !== null && identity.subshellId !== subshellId) {
      return { ok: false, code: 4001, reason: "unauthorized" };
    }
    // The post-ATTACH re-ask doctrine (`handleNodeOpen`, ruling 2026-09-24),
    // on the other credential that can outlive its check. The mint passes
    // `authGuard`, the disable commits, `dropUserTokensFor` walks the store —
    // and a mint whose insert lands after that walk survives the sweep for
    // its whole 30 s life. The store alone cannot see that (the disable's
    // sweep is a check-then-act with the insert sitting between them), but
    // the FLAG cannot be beaten: re-asking at redeem time refuses exactly
    // what the sweep missed. It runs AFTER `consumeWsToken` on purpose — a
    // refused redeem still burns the token, the wrong-scope rule above being
    // the precedent — and the refusal is the uniform unknown-token pair, so
    // a disable is never an enumeration signal. The cookie branch needs no
    // twin: it re-asks `accountDisabled` on the session below.
    if (identity) {
      const { db } = getRequestlessContext();
      if (await accountDisabled(db, identity.userId)) {
        return { ok: false, code: 4001, reason: "unauthorized" };
      }
    }
  } else {
    // Same shared extraction as the REST guard — accepts the https
    // `__Secure-` spelling and re-presents it under both names. A cookie
    // identity is unscoped by definition.
    const session = await resolveCookieSession(input.cookieHeader);
    // A DISABLED account is unauthenticated here exactly as `authGuard`'s
    // derive refuses it on REST (one function, `accountDisabled`, on both
    // doors). The admin path revokes sessions when it sets the flag, so
    // usually `resolveCookieSession` already answers null — but that is the
    // route's behaviour, not its guarantee: between the flag landing and the
    // revocation there is a transient, and a session restored from any other
    // path must not find the WS door open when the REST door is shut.
    if (session) {
      const { db } = getRequestlessContext();
      if (await accountDisabled(db, session.user.id)) {
        return { ok: false, code: 4001, reason: "unauthorized" };
      }
    }
    identity = session ? { userId: session.user.id, subshellId: null } : null;
  }
  if (!identity) return { ok: false, code: 4001, reason: "unauthorized" };

  const { repos } = getRequestlessContext();
  // Resolve the identity's access to THIS subshell with the FULL human gate
  // (admin boost and shared grants count) — true for a cookie session, and
  // correct for a scoped bearer token too because a scoped token records the
  // subshell's OWNER (see ws-token.ts): the scope check above already
  // confined it to that one pane, so resolving as its owner grants nothing
  // beyond the pane it can only ever reach. Invisible (absent or unshared)
  // closes with the same 4005 an owner-mismatch used to, so a stranger
  // learns nothing.
  const { row, access } = await loadSubshellAccess(
    { subshells: repos.subshells, shares: repos.subshellShares, userMeta: repos.userMeta },
    identity.userId,
    subshellId,
  );
  // Invisible and refused look identical on the wire, so a stranger cannot
  // probe ids: absent, unshared and forbidden all answer the same 4005.
  //
  // 4005, NOT 4004 (spec 2026-09-21 Wave D review): "not found" is permanent,
  // while the 4004 family (not running, unreachable, node offline) is what
  // the client now retries. Wire-ADDITIVE — every client older than this
  // split treats any 4xxx it cannot retry as terminal (the pre-Wave D rule
  // was `code < 4000` retries, everything else terminal), and none of them
  // ever retried 4004 either, so no cached PWA's behavior changes by the
  // move; a current client retries exactly 4004 and nothing else.
  if (!row || !accessAtLeast(access, "view")) return { ok: false, code: 4005, reason: "subshell not found" };

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
  logger.info(attachJournalLine(row.id, params, input.attachUa));
  // Attention answers the unseen push (spec 2026-09-23). The human marker is
  // `identity.subshellId === null`: the cookie fallback and the cookie-minted
  // ws-token are the ONLY unbound identities — every Bearer-key mint is bound
  // at issue, including a system key's — so a machine credential that
  // resolves as the owner still attends nothing, and the owner check is the
  // row itself. Best-effort: an uncleared urgency costs one extra escalation,
  // a throwing update must not refuse an admitted attach.
  if (identity.subshellId === null && identity.userId === row.userId && row.lastPushUrgency !== null) {
    try {
      await repos.subshells.update(row.id, { lastPushUrgency: null });
    } catch {
      logger.warn(`unseen-push clear failed for ${row.id} (escalation may double)`);
    }
  }
  return { ok: true, userId: identity.userId, row, access, params };
}

/** Longest User-Agent the attach line will print (unchanged from the raw slice). */
const MAX_UA_LEN = 90;

/**
 * The characters a real User-Agent actually contains.
 *
 * `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
 * Chrome/120.0.0.0 Safari/537.36` is the template; the set adds what client
 * markers actually use — `_`/`-` (OS version spellings), `+`/`=` (Presto/Gecko
 * tails and some app SDKs), `,` (inside the parentheses is ordinary), `[`/`]`
 * (Facebook's in-app browsers append `[FBAN/…]`), and `:`/`;`/`/`/`.` . It is
 * an allow-set on purpose, mirroring `parseClientBuild` in `attach-params.ts`:
 * the UA is untrusted display data interpolated into a quoted field of the one
 * forensics line an operator greps, and everything that would let it escape
 * the field — `"`, CR/LF, ESC, backslash, control bytes — is exactly what no
 * honest UA carries. Anything else is dropped, not escaped: a log field is not
 * worth inventing an encoding for.
 */
const UA_UNSAFE = /[^A-Za-z0-9 ._:;/(),+\-=[\]]/g;

/**
 * The UA reduced to what the journal may carry: clamped to the allow-set,
 * THEN sliced to {@link MAX_UA_LEN}.
 *
 * The order matters: slice-first lets a padding-prefixed attack string spend
 * the 90-character budget on the noise and keep a real payload beyond the
 * cut. Clamp-first can only ever smuggle characters the set admits.
 */
export function sanitizeAttachUa(ua: string): string {
  return ua.replace(UA_UNSAFE, "").slice(0, MAX_UA_LEN);
}

/**
 * The per-attach journal line, built as one function so its sanitization is
 * testable WITHOUT a logger (which is disabled under tests) — this string is
 * exactly what `logger.info` receives, and a client-supplied UA or build id
 * must not be able to mint a second `ws attach` record, forge a line break,
 * or write ANSI into the operator's journal.
 *
 * @param subshellId - The row the socket attaches to
 * @param params - What the client declared on its URL (already parsed)
 * @param ua - The raw User-Agent behind the socket
 * @returns The log line
 */
export function attachJournalLine(subshellId: string, params: AttachParams, ua: string): string {
  const safeUa = sanitizeAttachUa(ua);
  // WHICH BUNDLE is asking. A cached PWA keeps running old JavaScript across
  // any number of server deploys, and static requests are not logged, so
  // "did the client actually load the fix" was unanswerable — the 2026-09-04
  // session burned hours on renderer theories while the phone may never have
  // fetched the new chunk. `build=` is the client's own asset hash, so a
  // reload is visible as a CHANGED id; `build MISSING` is itself the answer,
  // meaning a bundle older than this line. It arrives from `parseClientBuild`,
  // which clamps to the same "drop what a real value never carries" rule.
  return params.size
    ? `ws attach ${subshellId}: geometry ${params.size.cols}x${params.size.rows} build=${params.build} ua="${safeUa}"`
    : `ws attach ${subshellId}: geometry MISSING (stale client predates cols/rows) build=${params.build} ua="${safeUa}"`;
}

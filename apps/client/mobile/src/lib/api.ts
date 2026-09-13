import { ApiError, parseErrorBody } from "@/lib/api-error";
import { cookieHeader, tokenFromSetCookie } from "@/lib/cookie";
import type { ExploreResult } from "@/types/files";
import type { Node } from "@/types/node";
import type { PluginView } from "@/types/plugin";
import type { PresetView } from "@/types/preset";
import type { SignInResponse, SubshellLogTail, SubshellSummary, SubshellView, WsTokenResponse } from "@/types/subshell";

/**
 * Persistent token storage, injected so the client stays unit-testable and no
 * module below `src/lib` imports a native module. Production passes
 * expo-secure-store; tests pass a Map.
 */
export interface TokenStore {
  /** @returns The stored session token, or null when signed out */
  get(): Promise<string | null>;
  /** @param token - Session token to persist (Keychain-backed in production) */
  set(token: string): Promise<void>;
  /** Removes any stored token. */
  clear(): Promise<void>;
}

/** Construction options for {@link SubshellClient}. */
export interface SubshellClientOptions {
  /** Base URL from `normalizeInstanceOrigin`, no trailing slash. */
  baseUrl: string;
  /** Where the session token lives. */
  store: TokenStore;
  /** Fetch to use — `expo/fetch` in production, a fake in tests. */
  fetchImpl?: typeof fetch;
  /** Called on any 401 so the app can clear state and re-prompt. */
  onUnauthorized?: () => void;
}

/**
 * Authenticated REST client for one subshell instance.
 *
 * Authenticates as the **better-auth cookie actor** — not a bearer key. That is
 * a design constraint, not a preference: `api/ws-token.route.ts:26` and
 * `api/notifications.route.ts:41` reject non-cookie actors deliberately, so a
 * key cannot attach a terminal or enroll a device, and a human holding a phone
 * is exactly the principal those gates mean to accept.
 *
 * Every request after sign-in replays the token as a `Cookie` header under both
 * spellings (see `src/lib/cookie.ts`), and picks up better-auth's rotation from
 * each response's `Set-Cookie`.
 */
export class SubshellClient {
  private readonly fetchImpl: typeof fetch;

  /**
   * @param opts - Base URL, token store and optional fetch override
   */
  constructor(private readonly opts: SubshellClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The instance origin every request goes to (WS URL construction needs it). */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /**
   * One request: cookie injected, rotation captured, non-2xx thrown as
   * {@link ApiError} with the backend's structured fields.
   * @param path - Path beginning with `/`
   * @param init - Method/body/extra headers
   * @returns The parsed JSON body
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.opts.store.get();
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    // RN sends no Origin; production instances enforce better-auth's origin
    // check, and the instance's own origin is always on its allowlist.
    if (path.startsWith("/api/auth/") && !headers.has("origin")) headers.set("origin", this.opts.baseUrl);
    const cookie = cookieHeader(token);
    if (cookie) headers.set("cookie", cookie);

    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, { ...init, headers });
    // Awaited, NOT fire-and-forget: a floating `store.set(rotation)` could land
    // AFTER the 401 path's `store.clear()` below and re-persist the token the
    // clear was removing (or outlive signOut's clear the same way). Serializing
    // keeps the operation the caller intended LAST on the store. (review #16)
    await this.captureRotation(res);

    if (res.status === 401 && token) {
      // 7-day session with a 5-minute cookie cache: expiry mid-use is routine.
      await this.opts.store.clear();
      this.opts.onUnauthorized?.();
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const { message, code, errId } = parseErrorBody(body);
      throw new ApiError(res.status, message, { code, errId });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Reads a rotated token off a response and persists it. `expo/fetch` exposes
   * `getSetCookie()`; core RN's `Headers` may only surface one value via
   * `get()`, which is why both are tried. If neither ever yields the cookie,
   * rotation stops being captured and the app will 401 at the 7-day boundary
   * rather than silently refreshing — the M1 spike asserts this works.
   * Awaiting the write is what keeps it ordered against a later clear().
   */
  private async captureRotation(res: Response): Promise<void> {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const single = res.headers.get("set-cookie");
    const rotated = tokenFromSetCookie(raw.length ? raw : single ? [single] : []);
    if (rotated) await this.opts.store.set(rotated);
  }

  /**
   * Signs in with email/password. better-auth 1.7.x SIGNS its session cookie
   * (`"<token>.<sig>"` in Set-Cookie) and accepts only that value as a Cookie
   * credential — the 32-char token in the JSON body is the unsigned one and
   * 401s on every guarded route (proven live by the M1 harness: body→401,
   * Set-Cookie→200). `request()`'s captureRotation has already persisted the
   * Set-Cookie value by the time we get here, so the body token is kept only
   * as the fallback for instances that set no cookie at all. Rate-limited per
   * email by the backend.
   * @throws ApiError 401/403 bad credentials, 429 rate-limited
   */
  async signIn(email: string, password: string): Promise<SignInResponse> {
    const body = await this.request<SignInResponse>("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!(await this.opts.store.get()) && body?.token) await this.opts.store.set(body.token);
    return body;
  }

  /** Best-effort server-side sign-out, then clears the local token either way. */
  async signOut(): Promise<void> {
    try {
      await this.request("/api/auth/sign-out", { method: "POST" });
    } catch {
      // Already-invalid sessions 401; the local clear below is what matters.
    }
    await this.opts.store.clear();
  }

  /** @returns A single-use 30 s token for `/ws` (and `/api/events`) */
  wsToken(): Promise<WsTokenResponse> {
    return this.request<WsTokenResponse>("/api/auth/ws-token", { method: "POST" });
  }

  /** @returns Every subshell the signed-in user owns. */
  subshells(): Promise<SubshellView[]> {
    return this.request<SubshellView[]>("/api/subshells");
  }

  /** @param id - Subshell id @returns One subshell view */
  subshell(id: string): Promise<SubshellView> {
    return this.request<SubshellView>(`/api/subshells/${encodeURIComponent(id)}`);
  }

  /**
   * The pane log tail — already ANSI-stripped server-side, which is what makes
   * the native LOG tab cost zero parsing.
   * @param id - Subshell id
   */
  subshellLog(id: string): Promise<SubshellLogTail> {
    return this.request<SubshellLogTail>(`/api/subshells/${encodeURIComponent(id)}/log`);
  }

  /**
   * Waiting/running counts for the tab badge (`GET /api/subshells/summary`).
   * Older instances 404 — callers must fall back to deriving `waiting` from
   * the polled subshell list (see `lib/subshell-order.waitingCount`).
   */
  summary(): Promise<SubshellSummary> {
    return this.request<SubshellSummary>("/api/subshells/summary");
  }

  /**
   * Toggles the per-subshell bell — the only push policy switch, and the action
   * exposed as a non-destructive lock-screen notification button.
   * @param id - Subshell id
   * @param notify - True to ring for this subshell's events
   */
  setNotify(id: string, notify: boolean): Promise<unknown> {
    return this.request(`/api/subshells/${encodeURIComponent(id)}/notify`, {
      method: "PATCH",
      body: JSON.stringify({ notify }),
    });
  }

  /**
   * Renames a subshell (operator-owned name; flips `nameLocked` server-side).
   * @param id - Subshell id @param name - New display name (1–120 chars)
   */
  rename(id: string, name: string): Promise<unknown> {
    return this.request(`/api/subshells/${encodeURIComponent(id)}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  /**
   * Revives the subshell IN PLACE — same id, rotated token (contract 53654a8).
   * Deep links and notifications survive a restart because the id does.
   * @param id - Subshell id
   */
  restart(id: string): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    return this.request(`/api/subshells/${encodeURIComponent(id)}/restart`, { method: "POST" });
  }

  // No terminate(): the human UI dropped the action (spec 2026-09-03) —
  // closeSubshell below stops the process AND removes the row in one act.

  /** Removes the row (terminating it first). Terminal — the UI calls this "Close". @param id - Subshell id */
  deleteSubshell(id: string): Promise<unknown> {
    return this.request(`/api/subshells/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * The signed-in user's presets (spec 2026-09-13: what profiles became —
   * the New screen's OPTIONAL preset chips; the launch itself keys on the
   * harness, not on these).
   */
  presets(): Promise<PresetView[]> {
    return this.request<PresetView[]>("/api/presets");
  }

  /**
   * The instance plugin catalog — the New screen's Agent chips and the
   * default-agent rule (spec 2026-09-10: the instance store is the single
   * catalog). The `{ plugins }` envelope is unwrapped here so callers speak
   * `PluginView[]`. Any signed-in actor may read.
   */
  async plugins(): Promise<PluginView[]> {
    const res = await this.request<{ plugins: PluginView[] }>("/api/plugins");
    return res.plugins;
  }

  /**
   * One level of the host filesystem for the folder sheet (cookie-only route —
   * the app is a cookie actor, which is exactly what unlocks it).
   * @param path - Directory to list; omitted = the server's home.
   */
  filesExplore(path?: string): Promise<ExploreResult> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return this.request<ExploreResult>(`/api/files/explore${q}`);
  }

  /**
   * Nodes visible to the caller (owned or shared; the seeded `local` included
   * via its Everyone grant) — the new-subshell launch picker. The `{ nodes }`
   * envelope is unwrapped here so callers speak `Node[]`. Cookie-only route.
   * @returns Every visible node, `local` first in practice (server order)
   */
  async nodes(): Promise<Node[]> {
    const res = await this.request<{ nodes: Node[] }>("/api/nodes");
    return res.nodes;
  }

  /**
   * Creates and launches a subshell (spec 2026-09-13 §4: harness-first,
   * preset optional).
   * @param input - harnessId (+ workingDir), optional presetId, name, first
   *   prompt, and launch node (omit the node for `local` — the server
   *   default; a pick of an invisible node 404s, an offline agent 409s
   *   NODE_OFFLINE). A null/absent `presetId` stays OFF the wire: the frozen
   *   body type is `presetId?: string`, so "presetless launch" is absence,
   *   not null.
   * @returns The new subshell id (the pane may still be settling)
   */
  createSubshell(input: {
    harnessId: string;
    presetId?: string | null;
    workingDir: string;
    name?: string;
    prompt?: string;
    nodeId?: string;
  }): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    const { presetId, ...rest } = input;
    return this.request("/api/subshells", {
      method: "POST",
      body: JSON.stringify(presetId ? { ...rest, presetId } : rest),
    });
  }

  /**
   * Enrolls this phone for native push (cookie-only route). Called on every
   * cold start and after sign-in so token rotation stays bounded.
   * @param token - `data` from `getExpoPushTokenAsync()`
   * @param platform - `"ios" | "android"` as reported by the OS
   */
  enrollDevice(token: string, platform: "ios" | "android"): Promise<{ ok: boolean }> {
    return this.request("/api/devices", { method: "POST", body: JSON.stringify({ token, platform }) });
  }

  /**
   * Idempotent removal of a device token — sign-out deregistration, so a
   * signed-out phone stops ringing.
   * @param token - The token previously enrolled
   */
  forgetDevice(token: string): Promise<{ ok: boolean }> {
    return this.request("/api/devices", { method: "DELETE", body: JSON.stringify({ token }) });
  }
}

import { ApiError, parseErrorBody } from "@/lib/api-error";
import { cookieHeader, tokenFromSetCookie } from "@/lib/cookie";
import type { ExploreResult, ProfileView } from "@/types/profile";
import type { SessionLogTail, SessionSummary, SessionView, SignInResponse, WsTokenResponse } from "@/types/session";

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

/** Construction options for {@link MoteClient}. */
export interface MoteClientOptions {
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
 * Authenticated REST client for one mote instance.
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
export class MoteClient {
  private readonly fetchImpl: typeof fetch;

  /**
   * @param opts - Base URL, token store and optional fetch override
   */
  constructor(private readonly opts: MoteClientOptions) {
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
   * Signs in with email/password. The session token comes back in the JSON
   * body (verified against better-auth 1.7.1: `signInEmail` returns
   * `{redirect, token, url, user}`), which is what makes a header-based native
   * client possible at all. Rate-limited per email by the backend.
   * @throws ApiError 401/403 bad credentials, 429 rate-limited
   */
  async signIn(email: string, password: string): Promise<SignInResponse> {
    const body = await this.request<SignInResponse>("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (body?.token) await this.opts.store.set(body.token);
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

  /** @returns Every session the signed-in user owns. */
  sessions(): Promise<SessionView[]> {
    return this.request<SessionView[]>("/api/sessions");
  }

  /** @param id - Session id @returns One session view */
  session(id: string): Promise<SessionView> {
    return this.request<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
  }

  /**
   * The pane log tail — already ANSI-stripped server-side, which is what makes
   * the native LOG tab cost zero parsing.
   * @param id - Session id
   */
  sessionLog(id: string): Promise<SessionLogTail> {
    return this.request<SessionLogTail>(`/api/sessions/${encodeURIComponent(id)}/log`);
  }

  /**
   * Waiting/running counts for the tab badge (`GET /api/sessions/summary`).
   * Older instances 404 — callers must fall back to deriving `waiting` from
   * the polled session list (see `lib/session-order.waitingCount`).
   */
  summary(): Promise<SessionSummary> {
    return this.request<SessionSummary>("/api/sessions/summary");
  }

  /**
   * Toggles the per-session bell — the only push policy switch, and the action
   * exposed as a non-destructive lock-screen notification button.
   * @param id - Session id
   * @param notify - True to ring for this session's events
   */
  setNotify(id: string, notify: boolean): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/notify`, {
      method: "PATCH",
      body: JSON.stringify({ notify }),
    });
  }

  /**
   * Renames a session (operator-owned name; flips `nameLocked` server-side).
   * @param id - Session id @param name - New display name (1–120 chars)
   */
  rename(id: string, name: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  /**
   * Sets the operator note.
   * @param id - Session id @param notes - Note text (null clears it)
   */
  setNotes(id: string, notes: string | null): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    });
  }

  /**
   * Revives the session IN PLACE — same id, rotated token (contract 53654a8).
   * Deep links and notifications survive a restart because the id does.
   * @param id - Session id
   */
  restart(id: string): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/restart`, { method: "POST" });
  }

  /** Kills the pane (resumable — restart can revive it). @param id - Session id */
  terminate(id: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/terminate`, { method: "POST" });
  }

  /** Removes the row. Terminal. @param id - Session id */
  deleteSession(id: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * The signed-in user's usable profiles (new-session picker; disabled
   * harnesses are already filtered out server-side).
   */
  profiles(): Promise<ProfileView[]> {
    return this.request<ProfileView[]>("/api/profiles");
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
   * Creates and launches a session (spec §Screens New session).
   * @param input - profileId + workingDir, optional name and first prompt
   * @returns The new session id (the pane may still be settling)
   */
  createSession(input: {
    profileId: string;
    workingDir: string;
    name?: string;
    prompt?: string;
  }): Promise<{ id: string; tmuxSocket: string; promptDelivered: boolean }> {
    return this.request("/api/sessions", { method: "POST", body: JSON.stringify(input) });
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

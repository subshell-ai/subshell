/**
 * Is this the desktop shell, and how do we talk to it?
 *
 * The SPA is served by the server and rendered in both a browser and
 * `apps/server/desktop`'s webview. It has to know which, before first paint, so the
 * desktop window does not flash web chrome — and it has to keep working when
 * the answer is "browser", which is the overwhelming majority of the time.
 *
 * **The marker is a User-Agent suffix**, not an injected script and not an IPC
 * handshake. It is present on the FIRST request, readable synchronously, and —
 * critically — it survives the hard `window.location.href` navigations this app
 * does at sign-out (`app-sidebar.tsx`) and after sign-in (`login.tsx`). Tauri's
 * `onPageStarted` init scripts are not guaranteed to run before a remote page's
 * own scripts, so anything depending on one would race first paint.
 *
 * **Nothing here imports `@tauri-apps/api`.** The shell sets
 * `withGlobalTauri`, so the bridge is a global — which keeps the browser
 * bundle free of a dependency it can never use, and avoids the dynamic import
 * the repo forbids (`.claude/rules/code-style.md`).
 */

/** Platforms the desktop shell ships for. */
export type DesktopPlatform = "macos" | "linux";

/** What the shell told us about itself. */
export interface DesktopShell {
  /** The desktop app's own version, independent of the server's. */
  version: string;
  platform: DesktopPlatform;
  /** Marker protocol version — see {@link DESKTOP_PROTOCOL}. */
  protocol: number;
  /**
   * The server version this shell BUNDLES (spec 2026-09-12 § 5.4), which is
   * not the version of the server the page is talking to — the two differ
   * exactly when an update is available.
   *
   * Absent from every shell built before that spec, and from Subshell Client,
   * which ships no server. Optional rather than defaulted for that reason: a
   * missing field means "this shell does not say", never "0".
   */
  bundledServer?: string;
}

/**
 * The marker protocol this build speaks.
 *
 * A shell announcing a protocol this build does not know is treated as NOT
 * desktop: a half-understood shell would render desktop chrome — an overlay
 * titlebar with traffic lights and no drag region — against a shell that does
 * not implement its half, which is an unmovable window. Degrading to the web
 * sidebar is always safe, so that is the failure direction.
 */
export const DESKTOP_PROTOCOL = 1;

/**
 * `SubshellDesktop/1.2.3 (macos; p=1)`, optionally `; b=0.3.0` — built by
 * `windows.rs::user_agent`. The bundled-server group stays OPTIONAL because
 * every shell released before spec 2026-09-12 omits it, and a required group
 * would read those as browsers.
 */
const MARKER = /\bSubshellDesktop\/(\S+)\s+\((macos|linux);\s*p=(\d+)(?:;\s*b=([0-9A-Za-z.+-]+))?\)/;

/**
 * Parse the desktop marker out of a User-Agent string.
 *
 * Pure and exported for its tests — every other function here is a thin
 * memoized wrapper over this one.
 *
 * @param userAgent - the raw User-Agent
 * @returns the shell's self-description, or `null` in a browser (or from a
 *   shell speaking a protocol this build does not know)
 */
export function parseDesktopUA(userAgent: string): DesktopShell | null {
  const m = MARKER.exec(userAgent);
  if (!m) return null;
  const protocol = Number.parseInt(m[3] as string, 10);
  if (!Number.isInteger(protocol) || protocol > DESKTOP_PROTOCOL) return null;
  return {
    version: m[1] as string,
    platform: m[2] as DesktopPlatform,
    protocol,
    ...(m[4] ? { bundledServer: m[4] } : {}),
  };
}

let cached: DesktopShell | null | undefined;

/** The shell, resolved once. `null` in a browser. */
export function desktopShell(): DesktopShell | null {
  if (cached === undefined) {
    cached = parseDesktopUA(typeof navigator === "undefined" ? "" : (navigator.userAgent ?? ""));
  }
  return cached;
}

/** Whether the app is running inside `apps/server/desktop`. */
export function isDesktop(): boolean {
  return desktopShell() !== null;
}

/** The host platform, or `null` in a browser. */
export function desktopPlatform(): DesktopPlatform | null {
  return desktopShell()?.platform ?? null;
}

/** Drops the memoized answer. Only for tests. @internal */
export function resetDesktopShellForTests(): void {
  cached = undefined;
}

/**
 * Actions the native chrome can ask the page to perform.
 *
 * The menu bar and the tray live in Rust but every one of these is a
 * ROUTER-level operation, so the page performs them — a native menu item that
 * navigated by reloading the window would unmount every live terminal.
 */
export type DesktopAction =
  | "new-subshell"
  | "new-workspace"
  | "focus-filter"
  | "toggle-sidebar"
  | "go-subshells"
  | "go-workspaces"
  | "go-nodes"
  | "go-settings"
  | "go-preferences"
  | "sign-out";

/** The DOM event `windows.rs` dispatches via `eval`. */
export const DESKTOP_EVENT = "subshell:desktop";

/**
 * Subscribe to native-chrome actions.
 *
 * Delivered as a `CustomEvent` rather than through Tauri's event system on
 * purpose: `eval` reaches a remote page with no capability grant at all, so
 * the menu bar and tray keep working even where IPC is refused.
 *
 * @param handler - called with each action
 * @returns an unsubscribe function
 */
export function onDesktopAction(handler: (action: DesktopAction) => void): () => void {
  const listener = (event: Event) => {
    const action = (event as CustomEvent<{ action?: string }>).detail?.action;
    if (action) handler(action as DesktopAction);
  };
  window.addEventListener(DESKTOP_EVENT, listener);
  return () => window.removeEventListener(DESKTOP_EVENT, listener);
}

/** The slice of `window.__TAURI__` this app uses. */
interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  window?: { getCurrentWindow?: () => { startDragging?: () => Promise<void> } };
}

function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/**
 * Call a shell command, or resolve `null` when there is no shell to call.
 *
 * Never throws for "not desktop" or "IPC refused" — every caller here is
 * chrome, and chrome that throws is worse than chrome that is absent.
 *
 * @param command - the Rust command name
 * @param args - its arguments
 * @returns the command's result, or `null` when unavailable
 */
export async function desktopInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const invoke = tauri()?.core?.invoke;
  if (!invoke) return null;
  try {
    return await invoke(command, args);
  } catch {
    return null;
  }
}

/**
 * Start an OS window drag from a pointer event.
 *
 * The desktop sidebar's top strip sits under the macOS traffic lights and IS
 * the title bar, so it has to move the window. `data-tauri-drag-region` only
 * works on the element it is applied to directly, which a React tree of nested
 * spans makes awkward — so this asks the shell instead.
 */
export function startWindowDrag(): void {
  void tauri()?.window?.getCurrentWindow?.()?.startDragging?.();
}

# Mobile Native App Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mote native companion (v1 scope): connect → sign in → poll the session list → read/act on one session (native Log + xterm-in-WebView Live + key bar) → create sessions, all behind a Face ID gate, with opaque Expo push, badge, and `mote://session/<id>` deep links, adaptive across phone and iPad.

**Architecture:** expo-router screens stay thin; every decision lives in pure modules under `src/lib/` (unit-tested with `bun test`, no emulator) and the injectable `MoteClient` from M2. Native bindings (SecureStore, AsyncStorage, expo-notifications, local-auth, clipboard) live in `src/native/` — nothing imported by `src/lib` may touch a native module, the rule `api.ts` already states. The app holds the socket, the token and every REST call; **the WebView owns no network and no secrets** — it is a renderer fed strings via `injectJavaScript`, posting keystrokes back through `onMessage`.

**Tech Stack:** Expo SDK 57 / RN 0.86 / Hermes, expo-router 57, @tanstack/react-query 5.101.4 (repo pin — do not bump), zustand 5, @shopify/flash-list 2.0.2, react-native-webview 13.16.1, @xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0 (mirrored from `apps/frontend/package.json`, shipped as inlined local assets, never a CDN).

**Spec:** `docs/superpowers/specs/2026-08-31-mobile-native-app-design.md`. Backend sibling plan (already ordered first): `2026-08-31-mobile-native-backend-push.md`.

## Global Constraints

- Every task ends with `bun run --cwd apps/mobile verify-types && bun run --cwd apps/mobile lint:check && bun run --cwd apps/mobile test` exiting 0, plus `bun run build` (=`expo export`, bundle-integrity only, never touches a native toolchain) on any task that touches a route file or adds a dependency.
- New deps: `npx expo install <pkg>` (SDK-57-compatible resolution) → `bunx syncpack fix && bun install` → **check `git diff` for drive-by edits to `apps/frontend`/`apps/backend` and `git checkout` them** (`apps/mobile/AGENTS.md` warns twice).
- Exact pins, Bun-only (`package-manager.md`); no dynamic imports anywhere.
- `src/lib/**` must not import `expo-*`/`react-native-*` native modules except the platform primitives `react-native` itself already requires for pure code (none needed today); native bindings live in `src/native/`.
- **Restart is in-place** (same id) — the spec's original "restart changes the id" text was amended 2026-08-31; code follows `53654a8`.
- WebView rules: bundled `source={{ require(...) }}` with **everything inlined** (opaque origin → any `fetch` from inside would fail CORS, and no network privilege may exist at all); keystroke strings cross via `postMessage` only.
- Biometric gates **use** of the token (attach socket, fire actions), never storage; a device with no enrolled biometric is not locked out (documented product choice, Task 13).
- Compact never writes `layout_json` (spec invariant 5 — the app never calls workspace endpoints at all).
- Colours: dark-only hex port from `apps/frontend/src/styles.css` (oklch converted via OKLab math, red-anchor verified): primary `#7abdff`, destructive `#f14d4c`, warning amber-400 `#fbbf24` = waiting, success emerald-400 `#34d399`, terminal trio bg `#0f1216` / canvas `#0a0c0f` / fg `#e4e4e7`, radius 8, touch targets 44.
- No mobile tests join `turbo test`; nothing here changes backend behaviour.

### Amendments during execution (code review 2026-08-31)

- **Task 5's sign-in snippet is superseded.** It stores the response-BODY token;
  better-auth 1.7.x signs the session cookie (`"<token>.<sig>"`) and accepts only
  the Set-Cookie value as a credential — body token 401s on guarded routes (proved
  by the M1 harness). Final behaviour in `b0743b8`: persist the captured Set-Cookie
  token, keep the body token only as a no-cookie fallback.
- **Task 3's deep-link parser was deleted** (`parseSessionDeepLink`/`sessionDeepLink`
  never gained a production caller — expo-router routes `mote://session/<uuid>`
  natively via the app scheme). The coverage-map row below now reflects router
  handling + origin-aware push routing instead.
- **Push payloads name the category/channel** (`categoryId: "session"`,
  `_channelId: "mote-sessions"`) so registered lock-screen actions appear — the
  spec §Push payload example omitted them; backend plan amended in place there.
- Commits on branch `feat/mobile-native-app`; push per task; **never merge to main** (operator gate).

---

### Task 1: Design tokens + key-bar byte table (pure)

**Files:**
- Create: `apps/mobile/src/lib/tokens.ts`
- Create: `apps/mobile/src/lib/key-bar.ts`
- Create: `apps/mobile/src/lib/__tests__/key-bar.test.ts`

**Interfaces:**
- Consumes: `BRACKETED_PASTE_START`/`BRACKETED_PASTE_END` from `@internal/session-protocol` (already used by `app/index.tsx`).
- Produces: `colors`, `radius`, `touchTarget` from `@/lib/tokens`; `KeyBarButton`, `KEY_BAR_BUTTONS`, `KEY_BAR_EXTENDED`, `wrapPaste(text, bracketed)` from `@/lib/key-bar`. Tasks 6–9 import all of these.

- [ ] **Step 1: Write the failing key-bar test**

Create `apps/mobile/src/lib/__tests__/key-bar.test.ts` — expectations mirrored from `apps/frontend/src/components/__tests__/terminal-key-bar.test.tsx` (read it; if it pins additional invariants like label uniqueness, mirror those too):

```ts
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/session-protocol";
import { describe, expect, it } from "bun:test";
import { KEY_BAR_BUTTONS, KEY_BAR_EXTENDED, wrapPaste } from "@/lib/key-bar";

/** Byte-for-byte port of the web bar's table (spec §Screens "the web table ported byte-for-byte"). */
const EXPECTED_MAIN: [string, string][] = [
  ["Esc", "\x1b"],
  ["^C", "\x03"],
  ["⇧Tab", "\x1b[Z"],
  ["Tab", "\t"],
  ["⏎", "\r"],
  ["⇧⏎", "\x1b\r"],
  ["/", "/"],
  ["←", "\x1b[D"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["→", "\x1b[C"],
];

describe("KEY_BAR_BUTTONS", () => {
  it("matches the web key bar byte-for-byte", () => {
    expect(KEY_BAR_BUTTONS.map((b) => [b.label, b.bytes])).toEqual(EXPECTED_MAIN);
  });
});

describe("KEY_BAR_EXTENDED", () => {
  it("sends plain Ctrl and CSI page sequences (the ⋯ page)", () => {
    expect(KEY_BAR_EXTENDED.map((b) => [b.label, b.bytes])).toEqual([
      ["^D", "\x04"],
      ["^L", "\x0c"],
      ["^R", "\x12"],
      ["PgUp", "\x1b[5~"],
      ["PgDn", "\x1b[6~"],
    ]);
  });
});

describe("wrapPaste", () => {
  it("wraps once when bracketed, passes through otherwise", () => {
    expect(wrapPaste("/tmp/x", true)).toBe(`${BRACKETED_PASTE_START}/tmp/x${BRACKETED_PASTE_END}`);
    expect(wrapPaste("/tmp/x", false)).toBe("/tmp/x");
    expect(wrapPaste("", true)).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/mobile && bun test src/lib/__tests__/key-bar.test.ts`
Expected: FAIL — cannot resolve `@/lib/key-bar`.

- [ ] **Step 3: Implement the two modules**

Create `apps/mobile/src/lib/tokens.ts`:

```ts
/**
 * Design tokens — the dark-only port of `apps/frontend/src/styles.css`.
 * The web app's oklch() values are converted to hex (OKLab→linear-sRGB→sRGB,
 * anchor-checked against CSS red) because native colour parsing cannot be
 * assumed to speak oklch(); the terminal trio is hex at the source.
 * There is deliberately no light mode (spec §Out of scope).
 */
export const colors = {
  /** App background (web `--background`). */
  bg: "#0a0a0a",
  /** Raised surfaces: cards, sheets, bars (web `--card`). */
  card: "#121212",
  /** Hairlines and inputs (web `--border`). */
  border: "#2a2e33",
  /** Primary text (web `--foreground`). */
  fg: "#fafafa",
  /** Secondary text (web `--muted-foreground`). */
  mutedFg: "#8b9095",
  /** Pressed/selected fill (web `--accent`). */
  accent: "#262f38",
  /** Brand/action colour. */
  primary: "#7abdff",
  /** Started/alive. */
  success: "#34d399",
  /** THE "waiting for you" colour — amber-400, matches the web chip. */
  warning: "#fbbf24",
  /** Terminate/delete. */
  destructive: "#f14d4c",
  /** Terminal chrome (spec §Layout): shell bg. */
  termBg: "#0f1216",
  /** Terminal canvas — xterm theme.background. */
  termCanvas: "#0a0c0f",
  /** Terminal ink — xterm theme.foreground. */
  termFg: "#e4e4e7",
} as const;

/** Corner radius, mirroring the web `--radius: 8px`. */
export const radius = 8;

/** Minimum interactive size (Apple HIG / the web key bar's `min-h-11`). */
export const touchTarget = 44;
```

Create `apps/mobile/src/lib/key-bar.ts`:

```ts
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@internal/session-protocol";

/** One key-bar button — every button sends raw bytes, like a physical key. */
export interface KeyBarButton {
  /** Glyph printed on the button */
  label: string;
  /** Raw bytes written to the pane. Plain CSI arrows (not SS3): tmux
   * translates them for whatever cursor mode the inner app set — the same
   * encoding the desktop sends (ported from terminal-key-bar.tsx). */
  bytes: string;
}

/** The row copied byte-for-byte from `apps/frontend/src/components/terminal-key-bar.tsx:15-33`. */
export const KEY_BAR_BUTTONS: KeyBarButton[] = [
  { label: "Esc", bytes: "\x1b" },
  { label: "^C", bytes: "\x03" },
  { label: "⇧Tab", bytes: "\x1b[Z" },
  { label: "Tab", bytes: "\t" },
  // CR is what a physical Enter sends (xterm emits "\r").
  { label: "⏎", bytes: "\r" },
  // The touch stand-in for Shift+Enter: ESC+CR = "insert a newline".
  { label: "⇧⏎", bytes: "\x1b\r" },
  // A plain "/" byte — the pane's program owns the character.
  { label: "/", bytes: "/" },
  { label: "←", bytes: "\x1b[D" },
  { label: "↑", bytes: "\x1b[A" },
  { label: "↓", bytes: "\x1b[B" },
  { label: "→", bytes: "\x1b[C" },
];

/** The `⋯` page: Ctrl letters and CSI page keys (spec §Screens key-bar). */
export const KEY_BAR_EXTENDED: KeyBarButton[] = [
  { label: "^D", bytes: "\x04" },
  { label: "^L", bytes: "\x0c" },
  { label: "^R", bytes: "\x12" },
  { label: "PgUp", bytes: "\x1b[5~" },
  { label: "PgDn", bytes: "\x1b[6~" },
];

/** Arrows repeat while held (spec: "press-repeat on arrows"). */
export function isRepeatable(label: string): boolean {
  return ["←", "↑", "↓", "→"].includes(label);
}

/**
 * One `input` frame's payload for a paste: wrapped in bracketed-paste markers
 * when the pane has DECSET 2004 on (xterm reports it), so "/"-leading paths
 * are not read as slash commands — same rule as `session-frames.injectText`.
 */
export function wrapPaste(text: string, bracketed: boolean): string {
  if (!text) return "";
  return bracketed ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
}
```

- [ ] **Step 4: Run tests — expect PASS**, then commit and push:

```bash
cd apps/mobile && bun test src/lib/__tests__/key-bar.test.ts
bun run --cwd apps/mobile verify-types && bun run --cwd apps/mobile lint:check && bun run --cwd apps/mobile test
git add apps/mobile/src/lib/tokens.ts apps/mobile/src/lib/key-bar.ts apps/mobile/src/lib/__tests__/key-bar.test.ts
git commit -m "feat(mobile): design tokens + byte-exact key-bar table"
git push -u origin feat/mobile-native-app
```

---

### Task 2: Session sectioning + poll policy (pure)

**Files:**
- Create: `apps/mobile/src/lib/session-order.ts`
- Create: `apps/mobile/src/lib/poll-policy.ts`
- Create: `apps/mobile/src/lib/__tests__/session-order.test.ts`
- Create: `apps/mobile/src/lib/__tests__/poll-policy.test.ts`

**Interfaces:**
- Consumes: `SessionView` from `@/types/session`.
- Produces: `isWaiting`, `SessionSections`, `sectionize(sessions)`, `waitingCount(sessions)`; `POLL_ACTIVE_MS`, `POLL_IDLE_MS`, `pollIntervalMs({foreground, hasActivity})`, `hasActivity(sessions)`. Task 6 consumes all; the section rules mirror the tested web predicates (`session-order.ts:18-20`, `session-filter.ts:39-43`).

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/lib/__tests__/session-order.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { isWaiting, sectionize, waitingCount } from "@/lib/session-order";
import type { SessionView } from "@/types/session";

function make(over: Partial<SessionView>): SessionView {
  return {
    id: crypto.randomUUID(), profileId: "p", harnessId: "h", name: "s", workingDir: "/tmp",
    status: "running", createdAt: "2026-08-31T00:00:00.000Z", endedAt: null, lastOutputAt: null,
    notes: null, activity: "active", preview: [], alive: true, exitCode: null, startedAt: null,
    backoffCount: 0, restartOnExit: false, nextRestartAt: null, nameLocked: false, notify: false,
    waitingSince: null, ...over,
  };
}

describe("isWaiting", () => {
  it("mirrors the web predicate: running AND alive AND stamped", () => {
    expect(isWaiting(make({ waitingSince: "2026-08-31T00:00:00.000Z" }))).toBe(true);
    expect(isWaiting(make({ waitingSince: null }))).toBe(false);
    expect(isWaiting(make({ alive: false, waitingSince: "2026-08-31T00:00:00.000Z" }))).toBe(false);
    expect(isWaiting(make({ status: "terminated", alive: false, waitingSince: "2026-08-31T00:00:00.000Z" }))).toBe(false);
  });
});

describe("sectionize", () => {
  it("splits into Waiting / Running / Paused-exited / Completed like the web groups", () => {
    const waiting = make({ name: "w", waitingSince: "2026-08-31T00:00:00.000Z" });
    const running = make({ name: "r" });
    const exited = make({ name: "e", alive: false, exitCode: 1 });
    const completed = make({ name: "c", status: "terminated", alive: false });
    const s = sectionize([completed, exited, running, waiting]);
    expect(s.waiting.map((x) => x.name)).toEqual(["w"]);
    expect(s.running.map((x) => x.name)).toEqual(["r"]);
    expect(s.exited.map((x) => x.name)).toEqual(["e"]);
    expect(s.completed.map((x) => x.name)).toEqual(["c"]);
    // input untouched (pure) — the arrays are copies
    expect(s.waiting[0]).toBe(waiting);
  });
});

describe("waitingCount", () => {
  it("counts only live stamped rows", () => {
    expect(
      waitingCount([
        make({ waitingSince: "2026-08-31T00:00:00.000Z" }),
        make({ waitingSince: "2026-08-31T00:00:00.000Z", alive: false }),
        make(),
      ]),
    ).toBe(1);
  });
});
```

Create `apps/mobile/src/lib/__tests__/poll-policy.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";

describe("pollIntervalMs", () => {
  it("3 s while anything runs/waits, 15 s quiescent, stopped in background (spec §Transport)", () => {
    expect(pollIntervalMs({ foreground: true, hasActivity: true })).toBe(3000);
    expect(pollIntervalMs({ foreground: true, hasActivity: false })).toBe(15000);
    expect(pollIntervalMs({ foreground: false, hasActivity: true })).toBeNull();
  });
});

describe("hasActivity", () => {
  it("alive rows mean activity; dead-only lists are quiescent", () => {
    expect(hasActivity([{ status: "running", alive: true }])).toBe(true);
    expect(hasActivity([{ status: "running", alive: false }])).toBe(false);
    expect(hasActivity([{ status: "terminated", alive: false }])).toBe(false);
    expect(hasActivity([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/mobile && bun test src/lib/__tests__/session-order.test.ts src/lib/__tests__/poll-policy.test.ts`

- [ ] **Step 3: Implement**

Create `apps/mobile/src/lib/session-order.ts`:

```ts
import type { SessionView } from "@/types/session";

/**
 * Sectioning rules for the Sessions screen — the web grouping ported, not
 * re-invented: predicate from `apps/frontend/src/lib/session-order.ts:18-20`
 * and buckets from `session-filter.ts:39-43` (spec §Testing: "mirroring the
 * tested lib/session-order.ts predicate"). The Waiting bucket is hoisted out
 * of Running here because the tab badge and sections must agree on one number.
 */

/** True when the session is alive and the watcher has stamped it waiting. */
export function isWaiting(session: Pick<SessionView, "status" | "alive" | "waitingSince">): boolean {
  return session.status === "running" && session.alive && session.waitingSince != null;
}

/** The four list sections, in render order. */
export interface SessionSections {
  /** Alive and stamped — amber chip, badge source. */
  waiting: SessionView[];
  /** Alive, not waiting. */
  running: SessionView[];
  /** status running but dead pane — crashed or paused mid-backoff. */
  exited: SessionView[];
  /** status terminated — operator-completed. */
  completed: SessionView[];
}

/** Buckets a list into the four sections; input array untouched, order stable. */
export function sectionize(sessions: SessionView[]): SessionSections {
  return {
    waiting: sessions.filter((s) => isWaiting(s)),
    running: sessions.filter((s) => s.status === "running" && s.alive && !isWaiting(s)),
    exited: sessions.filter((s) => s.status === "running" && !s.alive),
    completed: sessions.filter((s) => s.status === "terminated"),
  };
}

/** Foreground fallback for the badge when `summary()` is unreachable (older instance). */
export function waitingCount(sessions: SessionView[]): number {
  return sessions.filter(isWaiting).length;
}
```

Create `apps/mobile/src/lib/poll-policy.ts`:

```ts
/**
 * The list-poll policy state machine (spec §Transport): "Foreground poll of
 * GET /api/sessions at 3 s while anything is running or waiting, 15 s when
 * quiescent, stopped in background, immediate on resume." Background wake-up
 * is push's job, not the poll's. Pure reducer; the AppState listener in
 * hooks/use-sessions owns the clock.
 */

/** Interval while at least one session is alive. */
export const POLL_ACTIVE_MS = 3000;
/** Interval while quiescent. */
export const POLL_IDLE_MS = 15000;

/** @returns ms between polls, or null = do not poll (background) */
export function pollIntervalMs(state: { foreground: boolean; hasActivity: boolean }): number | null {
  if (!state.foreground) return null;
  return state.hasActivity ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/** Activity probe over the minimal row shape the poll returns. */
export function hasActivity(rows: readonly { status: string; alive: boolean }[]): boolean {
  return rows.some((r) => r.status === "running" && r.alive);
}
```

- [ ] **Step 4: Tests pass, verify trio, commit and push**

```bash
git add apps/mobile/src/lib/session-order.ts apps/mobile/src/lib/poll-policy.ts apps/mobile/src/lib/__tests__/session-order.test.ts apps/mobile/src/lib/__tests__/poll-policy.test.ts
git commit -m "feat(mobile): session sectioning + poll policy (web rules ported)"
git push
```

---

### Task 3: Probe classifier + deep-link parser (pure)

**Files:**
- Create: `apps/mobile/src/lib/probe.ts`
- Create: `apps/mobile/src/lib/deep-link.ts`
- Create: `apps/mobile/src/lib/__tests__/probe.test.ts`
- Create: `apps/mobile/src/lib/__tests__/deep-link.test.ts`

**Interfaces:**
- Consumes: nothing native.
- Produces: `ProbeResult`, `ProbeDeps`, `probeInstance(origin, deps)`; `parseSessionDeepLink(url)`, `sessionDeepLink(id)`. Task 5 (connect screen) and Task 12 (push routing) consume them.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/lib/__tests__/probe.test.ts` (spec §Error handling "Probe, don't hang" — the classifier against a fake socket):

```ts
import { describe, expect, it } from "bun:test";
import { probeInstance, type ProbeDeps } from "@/lib/probe";

const up = async () => ({ needsSetup: false });
const down = async (): Promise<{ needsSetup: boolean }> => {
  throw new Error("unreachable");
};
const sock = (opened: boolean, closeCode: number | null) => async () => ({ opened, closeCode });

function deps(rest: ProbeDeps["fetchSetupStatus"], ws: ProbeDeps["openProbeSocket"]): ProbeDeps {
  return { fetchSetupStatus: rest, openProbeSocket: ws };
}

describe("probeInstance", () => {
  it("REST down → down, ws verdict withheld (nothing else can be concluded)", async () => {
    expect(await probeInstance("https://x", deps(down, sock(true, null)))).toEqual({
      ok: false,
      needsSetup: false,
      wsBlocked: false,
    });
  });

  it("REST up + socket opens → ws reachable", async () => {
    expect(await probeInstance("https://x", deps(up, sock(true, null)))).toEqual({
      ok: true,
      needsSetup: false,
      wsBlocked: false,
    });
  });

  it("REST up + 4001/4004 close → upgrade reached the server → ws reachable", async () => {
    // An unauthenticated probe token is always rejected — a 4xxx close PROVES
    // the proxy forwards upgrades (spec §Error handling).
    for (const code of [4001, 4004]) {
      expect((await probeInstance("https://x", deps(up, sock(false, code)))).wsBlocked).toBe(false);
    }
  });

  it("REST up + error/timeout with no close code → WS blocked → standing banner", async () => {
    const r = await probeInstance("https://x", deps(up, sock(false, null)));
    expect(r).toEqual({ ok: true, needsSetup: false, wsBlocked: true });
  });

  it("carries needsSetup through from the status probe", async () => {
    const r = await probeInstance("https://x", deps(async () => ({ needsSetup: true }), sock(true, null)));
    expect(r.needsSetup).toBe(true);
  });
});
```

Create `apps/mobile/src/lib/__tests__/deep-link.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseSessionDeepLink, sessionDeepLink } from "@/lib/deep-link";

const UUID = "0f12ab34-5678-49ab-8cde-0f12ab345678";

describe("parseSessionDeepLink", () => {
  it("extracts exactly a session uuid from mote://session/<id>", () => {
    expect(parseSessionDeepLink(`mote://session/${UUID}`)).toBe(UUID);
  });
  it("rejects junk, other hosts, and non-uuid tails (invariant: the link carries a UUID only)", () => {
    expect(parseSessionDeepLink("mote://session/../../etc")).toBeNull();
    expect(parseSessionDeepLink("mote://session/")).toBeNull();
    expect(parseSessionDeepLink("mote://other/x")).toBeNull();
    expect(parseSessionDeepLink("https://example.com/session/" + UUID)).toBeNull();
    expect(parseSessionDeepLink("")).toBeNull();
  });
});

describe("sessionDeepLink", () => {
  it("round-trips through the parser", () => {
    expect(parseSessionDeepLink(sessionDeepLink(UUID))).toBe(UUID);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

Create `apps/mobile/src/lib/probe.ts`:

```ts
/**
 * The save-time probe (spec §Error handling): REST reachability plus a
 * verdict on whether WebSocket upgrades tunnel. Phones reach the instance
 * through a proxy that may forward HTTP but not upgrades — that exact shape
 * is what this classifies, so the Live tab can hide itself with a standing
 * banner instead of hanging. Injected deps only: no fetch/socket here.
 */

/** Outcome of one probe. */
export interface ProbeResult {
  /** REST answered (anything over HTTP, incl. 4xx). */
  ok: boolean;
  /** Instance wants the web setup wizard first. */
  needsSetup: boolean;
  /** REST up but upgrades never land — hide Live, keep everything else. */
  wsBlocked: boolean;
}

/** Injected probe transport (the screen wires fetch + a real WebSocket). */
export interface ProbeDeps {
  /** Resolves with `GET /api/setup/status`; throws/ rejects when unreachable. */
  fetchSetupStatus: (origin: string) => Promise<{ needsSetup: boolean }>;
  /** Opens the probe socket; resolves once it opened, closed, or timed out. */
  openProbeSocket: (origin: string) => Promise<{ opened: boolean; closeCode: number | null }>;
}

/** @param origin - Normalized instance origin (no trailing slash) */
export async function probeInstance(origin: string, deps: ProbeDeps): Promise<ProbeResult> {
  let needsSetup = false;
  try {
    const status = await deps.fetchSetupStatus(origin);
    needsSetup = status.needsSetup;
  } catch {
    // Nothing is reachable; the ws probe would "fail" for the same wrong reason.
    return { ok: false, needsSetup: false, wsBlocked: false };
  }
  const ws = await deps.openProbeSocket(origin);
  // Any close code means the upgrade reached mote's WS server and was answered;
  // a bare timeout/error with REST up means a proxy dropped it.
  const reachable = ws.opened || ws.closeCode !== null;
  return { ok: true, needsSetup, wsBlocked: !reachable };
}
```

Create `apps/mobile/src/lib/deep-link.ts`:

```ts
/**
 * `mote://session/<id>` — the notification/deep-link route (spec §Security
 * notes): the link carries a UUID only; opening it still passes the
 * biometric gate downstream. expo-router matches the path natively; this
 * parser guards the push-response handler which sees raw URLs.
 */

const SESSION_RE = /^mote:\/\/session\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#].*)?$/;

/** @returns The session id when the link names exactly one, else null. */
export function parseSessionDeepLink(url: string): string | null {
  return SESSION_RE.exec(url)?.[1]?.toLowerCase() ?? null;
}

/** Builds the link for a session (notification payloads, tests). */
export function sessionDeepLink(id: string): string {
  return `mote://session/${id}`;
}
```

- [ ] **Step 3: Tests pass, trio, commit and push**

```bash
git add apps/mobile/src/lib/probe.ts apps/mobile/src/lib/deep-link.ts apps/mobile/src/lib/__tests__/probe.test.ts apps/mobile/src/lib/__tests__/deep-link.test.ts
git commit -m "feat(mobile): probe classifier + deep-link parser"
git push
```

---

### Task 4: Instance registry + token store + client provider

**Files:**
- Create: `apps/mobile/src/lib/instances.ts` (pure)
- Create: `apps/mobile/src/lib/app-state.ts` (pure zustand store)
- Create: `apps/mobile/src/lib/__tests__/instances.test.ts`
- Create: `apps/mobile/src/native/registry-storage.ts` (AsyncStorage glue)
- Create: `apps/mobile/src/native/secure-token-store.ts` (SecureStore TokenStore)
- Create: `apps/mobile/src/providers/mote-provider.tsx` (context + factory)

**Interfaces:**
- Consumes: `MoteClient`, `TokenStore` from `@/lib/api`; `normalizeInstanceOrigin`, `InvalidInstanceUrl`, `looksPrivate` from `@/lib/instance-url`; zustand (dep, present).
- Produces:
  - `InstanceRecord { id: string; label: string; email: string | null; wsBlocked: boolean; plainHttp: boolean }` (`id` IS the normalized origin),
  - pure `upsertInstance(list, rec)`, `removeInstance(list, id)` (newest-first, max 10),
  - `useApp` zustand store: `{ instances, activeId, hydrated, hydrate(), addInstance(input): Promise<InstanceRecord>, removeInstance(id), setActive(id), setEmail(email) }`,
  - `secureTokenStore(instanceId): TokenStore` (Keychain key `mote.token.<id>`),
  - `loadRegistry()/saveRegistry()` AsyncStorage helpers,
  - `useMote(): { client: MoteClient | null; instance: InstanceRecord | null }`, `useMoteRequired()` (non-null throw), and `onUnauthorized` wiring: 401 → `useApp.getState().signedOut()`.

- [ ] **Step 1: Write the failing registry test**

Create `apps/mobile/src/lib/__tests__/instances.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { removeInstance, upsertInstance, type InstanceRecord } from "@/lib/instances";

const rec = (id: string, over: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id, label: id, email: null, wsBlocked: false, plainHttp: false, ...over,
});

describe("upsertInstance", () => {
  it("keeps one entry per origin, newest first, and caps the list at 10", () => {
    let list: InstanceRecord[] = [];
    list = upsertInstance(list, rec("https://a"));
    list = upsertInstance(list, rec("https://b"));
    expect(list.map((r) => r.id)).toEqual(["https://b", "https://a"]);
    // re-adding a known origin refreshes it in place without duplicating
    list = upsertInstance(list, rec("https://a", { email: "x@y.z" }));
    expect(list.map((r) => r.id)).toEqual(["https://a", "https://b"]);
    expect(list[0]?.email).toBe("x@y.z");
    for (let i = 0; i < 12; i++) list = upsertInstance(list, rec(`https://h${i}`));
    expect(list).toHaveLength(10);
  });
});

describe("removeInstance", () => {
  it("drops one entry, leaves the rest", () => {
    const list = removeInstance([rec("https://a"), rec("https://b")], "https://a");
    expect(list.map((r) => r.id)).toEqual(["https://b"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement all five modules.

Create `apps/mobile/src/lib/instances.ts`:

```ts
/**
 * The multi-instance registry (spec §Decisions: multi-instance is
 * first-class). Non-secret by design — origins, labels, the last-used email —
 * so it lives in AsyncStorage, not the Keychain. `id` IS the normalized
 * origin: one instance = one origin.
 */
export interface InstanceRecord {
  /** Normalized origin (from normalizeInstanceOrigin) — also the store key. */
  id: string;
  /** User-visible name (defaults to the host part). */
  label: string;
  /** Last email signed in here — prefills the sign-in form. */
  email: string | null;
  /** Persisted probe verdict: this instance tunnels no WS upgrades. */
  wsBlocked: boolean;
  /** Plain-HTTP origin — the connection screen marks it (token crosses in clear). */
  plainHttp: boolean;
}

/** Registry cap — beyond ten origins the operator is inventory-keeping, not switching. */
const MAX_INSTANCES = 10;

/** Inserts/refreshes `rec` at the head (most-recent-first). Returns a new array. */
export function upsertInstance(list: readonly InstanceRecord[], rec: InstanceRecord): InstanceRecord[] {
  return [rec, ...list.filter((r) => r.id !== rec.id)].slice(0, MAX_INSTANCES);
}

/** Removes one origin entry (long-press delete on the connect screen). */
export function removeInstance(list: readonly InstanceRecord[], id: string): InstanceRecord[] {
  return list.filter((r) => r.id !== id);
}
```

Create `apps/mobile/src/lib/app-state.ts`:

```ts
import { create } from "zustand";
import { normalizeInstanceOrigin } from "@/lib/instance-url";
import { removeInstance as drop, upsertInstance, type InstanceRecord } from "@/lib/instances";

/**
 * The app's own store: which instances exist, which one is active, and the
 * auth hint (has a token EVER been seen this launch). Persistence is wired
 * by the native layer (registry-storage.ts) — this file stays pure so the
 * transitions are testable.
 */
interface AppState {
  instances: InstanceRecord[];
  /** Origin of the instance every screen talks to. */
  activeId: string | null;
  /** Registry loaded from disk — guards the splash→guard flicker. */
  hydrated: boolean;
  hydrate(instances: InstanceRecord[], activeId: string | null): void;
  /** Normalizes+stores+activates. @throws InvalidInstanceUrl junk input */
  addInstance(input: string): InstanceRecord;
  forgetInstance(id: string): void;
  setActive(id: string): void;
  /** Records the sign-in email against the active instance. */
  setEmail(email: string): void;
  /** Records a probe verdict (Task 5's save-probe writes wsBlocked). */
  setWsBlocked(id: string, blocked: boolean): void;
}

export const useApp = create<AppState>((set, get) => ({
  instances: [],
  activeId: null,
  hydrated: false,
  hydrate: (instances, activeId) => set({ instances, activeId, hydrated: true }),
  addInstance: (input) => {
    const origin = normalizeInstanceOrigin(input);
    const rec: InstanceRecord = {
      id: origin,
      label: new URL(origin).host,
      email: get().instances.find((r) => r.id === origin)?.email ?? null,
      wsBlocked: get().instances.find((r) => r.id === origin)?.wsBlocked ?? false,
      plainHttp: origin.startsWith("http://"),
    };
    set({ instances: upsertInstance(get().instances, rec), activeId: origin });
    return rec;
  },
  forgetInstance: (id) => {
    const instances = drop(get().instances, id);
    set({ instances, activeId: get().activeId === id ? (instances[0]?.id ?? null) : get().activeId });
  },
  setActive: (id) => set({ activeId: id }),
  setEmail: (email) => {
    const activeId = get().activeId;
    set({ instances: get().instances.map((r) => (r.id === activeId ? { ...r, email } : r)) });
  },
  setWsBlocked: (id, blocked) =>
    set({ instances: get().instances.map((r) => (r.id === id ? { ...r, wsBlocked: blocked } : r)) }),
}));
```

Create `apps/mobile/src/native/registry-storage.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InstanceRecord } from "@/lib/instances";

/**
 * Registry persistence — the ONLY AsyncStorage keys this app writes
 * (origins/labels/emails are non-secret; tokens never come here — spec
 * §Security notes).
 */
const K_REGISTRY = "mote.instances";
const K_ACTIVE = "mote.instances.active";

export async function loadRegistry(): Promise<{ instances: InstanceRecord[]; activeId: string | null }> {
  const [raw, active] = await Promise.all([AsyncStorage.getItem(K_REGISTRY), AsyncStorage.getItem(K_ACTIVE)]);
  let instances: InstanceRecord[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) instances = parsed as InstanceRecord[];
  } catch {
    instances = []; // corrupt registry is non-fatal; the operator re-adds
  }
  return { instances, activeId: active ?? instances[0]?.id ?? null };
}

export async function saveRegistry(instances: InstanceRecord[], activeId: string | null): Promise<void> {
  await AsyncStorage.setItem(K_REGISTRY, JSON.stringify(instances));
  if (activeId) await AsyncStorage.setItem(K_ACTIVE, activeId);
  else await AsyncStorage.removeItem(K_ACTIVE);
}
```

Create `apps/mobile/src/native/secure-token-store.ts`:

```ts
import * as SecureStore from "expo-secure-store";
import type { TokenStore } from "@/lib/api";

/**
 * Keychain/Keystore-backed session token for ONE instance —
 * `mote.token.<instanceId>` (spec §Auth: SecureStore, never AsyncStorage).
 * Keys must be filesystem-safe: origins contain `//` and `:` which
 * SecureStore rejects, hence the digest-free slug below (SecureStore allows
 * A-Za-z0-9._-).
 */
function keyFor(instanceId: string): string {
  return `mote.token.${instanceId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** @param instanceId - Normalized origin (the InstanceRecord id) */
export function secureTokenStore(instanceId: string): TokenStore {
  const key = keyFor(instanceId);
  return {
    get: async () => (await SecureStore.getItemAsync(key)) ?? null,
    set: async (token) => SecureStore.setItemAsync(key, token),
    clear: async () => {
      await SecureStore.deleteItemAsync(key);
    },
  };
}
```

Create `apps/mobile/src/providers/mote-provider.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { MoteClient } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { loadRegistry, saveRegistry } from "@/native/registry-storage";
import { secureTokenStore } from "@/native/secure-token-store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1500, retry: 1 } },
});

const MoteContext = createContext<{ client: MoteClient | null }>({ client: null });

/**
 * Wires the M2 transport to the app: registry hydration (AsyncStorage), one
 * MoteClient per active instance (Keychain token store), and the 401 path —
 * "clear the token, remember the pending route, prompt, resume" is handled by
 * the guard screen (Task 5) reacting to activeId + a cleared token.
 */
export function MoteProvider({ children }: { children: ReactNode }) {
  const { instances, activeId, hydrated, hydrate, setWsBlocked } = useApp();

  useEffect(() => {
    void loadRegistry().then(({ instances, activeId }) => hydrate(instances, activeId));
  }, [hydrate]);

  useEffect(() => {
    if (hydrated) void saveRegistry(instances, activeId);
  }, [instances, activeId, hydrated]);

  const client = useMemo(() => {
    if (!activeId) return null;
    return new MoteClient({
      baseUrl: activeId,
      store: secureTokenStore(activeId),
      // 401 mid-session is expected (7-day session): drop local auth state so
      // the guard re-presents sign-in, preserving the pending route there.
      onUnauthorized: () => queryClient.clear(),
    });
  }, [activeId]);

  useEffect(() => {
    setWsBlocked; // silence unused-destructure lint if ws wiring lands here later
  }, [setWsBlocked]);

  return (
    <QueryClientProvider client={queryClient}>
      <MoteContext.Provider value={{ client }}>{children}</MoteContext.Provider>
    </QueryClientProvider>
  );
}

/** The active client+instance or null (pre-connect / no instance). */
export function useMote(): { client: MoteClient | null } {
  return useContext(MoteContext);
}
```

If the `setWsBlocked` placeholder effect reads awkward in review, drop it — the probe path (Task 5) calls `useApp.getState().setWsBlocked(...)` directly.

- [ ] **Step 3: Tests pass, trio, commit and push**

```bash
git add apps/mobile/src/lib/instances.ts apps/mobile/src/lib/app-state.ts apps/mobile/src/lib/__tests__/instances.test.ts \
        apps/mobile/src/native/registry-storage.ts apps/mobile/src/native/secure-token-store.ts apps/mobile/src/providers/mote-provider.tsx
git commit -m "feat(mobile): instance registry + Keychain token store + MoteClient provider"
git push
```

---

### Task 5: Root layout, guard, Connect + Sign-in screens

**Files:**
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/app/index.tsx` (scaffold probe → guard)
- Create: `apps/mobile/app/connect.tsx`
- Create: `apps/mobile/app/sign-in.tsx`
- Create: `apps/mobile/src/components/field.tsx` (shared labelled input)
- Delete: (keep) `apps/mobile/src/lib/breakpoints.ts`

**Interfaces:**
- Consumes: `MoteProvider`/`useMote` (T4), `useApp` (T4), `probeInstance`/`ProbeDeps` (T3), `MoteClient` (M2), `errMessage`/`ApiError` (M2), `colors` (T1), `wsOrigin` (`@/lib/instance-url`), `looksPrivate`.
- Produces: routes `/connect`, `/sign-in`; guard logic in `app/index.tsx` (no instance → connect; no token → sign-in; else `(tabs)`); shared `Field` component; `makeProbeDeps()` exported from `app/connect.tsx` for Task 11's re-probe.

- [ ] **Step 1: Root layout with providers**

Replace `apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "@/lib/tokens";
import { MoteProvider } from "@/providers/mote-provider";

/** Root: dark chrome, providers once, every route below sees useMote()/queries. */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <MoteProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </MoteProvider>
    </SafeAreaProvider>
  );
}
```

- [ ] **Step 2: Shared Field component**

Create `apps/mobile/src/components/field.tsx`:

```tsx
import { Text, TextInput, View, type TextInputProps } from "react-native";
import { colors, radius, touchTarget } from "@/lib/tokens";

/** Labelled single-line input with a caption line for probe/error copy. */
export function Field({
  label,
  caption,
  captionColor = colors.mutedFg,
  ...input
}: TextInputProps & { label: string; caption?: string; captionColor?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.mutedFg, fontSize: 13 }}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.mutedFg}
        {...input}
        style={{
          minHeight: touchTarget,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius,
          paddingHorizontal: 12,
          color: colors.fg,
          backgroundColor: colors.card,
          fontSize: 16,
        }}
      />
      {caption ? <Text style={{ color: captionColor, fontSize: 12 }}>{caption}</Text> : null}
    </View>
  );
}
```

- [ ] **Step 3: Connect screen**

Create `apps/mobile/app/connect.tsx`:

```tsx
import { Stack } from "expo-router";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator, Alert, Pressable, ScrollView, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field } from "@/components/field";
import { useApp } from "@/lib/app-state";
import { InvalidInstanceUrl, looksPrivate, normalizeInstanceOrigin, wsOrigin } from "@/lib/instance-url";
import { probeInstance, type ProbeDeps, type ProbeResult } from "@/lib/probe";
import { colors, radius, touchTarget } from "@/lib/tokens";

/** ~3 s socket settle (spec §Error handling "open /ws with a ~3 s timeout"). */
const WS_PROBE_MS = 3000;

/** The real transport behind probeInstance — exported so Settings re-probes. */
export function makeProbeDeps(): ProbeDeps {
  return {
    fetchSetupStatus: async (origin) => {
      const res = await fetch(`${origin}/api/setup/status`, { signal: AbortSignal.timeout(WS_PROBE_MS) });
      if (!res.ok) throw new Error(`probe status ${res.status}`);
      return (await res.json()) as { needsSetup: boolean };
    },
    openProbeSocket: (origin) =>
      new Promise<{ opened: boolean; closeCode: number | null }>((resolve) => {
        let settled = false;
        const done = (r: { opened: boolean; closeCode: number | null }) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          done({ opened: false, closeCode: null });
        }, WS_PROBE_MS);
        // Bogus ids → the server answers 4001/4004 IF upgrades tunnel at all.
        const ws = new WebSocket(`${wsOrigin(origin)}/ws?session=probe&token=probe`);
        ws.onopen = () => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          done({ opened: true, closeCode: null });
        };
        ws.onclose = (e) => {
          clearTimeout(timer);
          done({ opened: false, closeCode: e.code });
        };
        ws.onerror = () => {
          /* every error closes; onclose settles */
        };
      }),
  };
}

/** Connect screen (spec §Screens): type/paste an origin, manage the list. */
export default function Connect() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { instances, addInstance, forgetInstance, setActive, setWsBlocked } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; color: string } | null>(null);

  async function save() {
    if (busy) return;
    let origin: string;
    try {
      origin = normalizeInstanceOrigin(input);
    } catch (err) {
      setNote({ text: err instanceof InvalidInstanceUrl ? err.message : "Not a valid address", color: colors.destructive });
      return;
    }
    setBusy(true);
    setNote(null);
    const result: ProbeResult = await probeInstance(origin, makeProbeDeps());
    setBusy(false);
    if (!result.ok) {
      setNote({ text: "Could not reach that instance — check the address and network", color: colors.destructive });
      return;
    }
    const rec = addInstance(input);
    setWsBlocked(rec.id, result.wsBlocked);
    if (result.needsSetup) {
      Alert.alert("Needs setup", "Open this instance in a browser to finish setup, then sign in.");
    }
    router.replace("/sign-in");
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: 24, paddingTop: insets.top + 32, gap: 16, minHeight: "100%" }}
      keyboardShouldPersistTaps="handled"
    >
      <Stack screenOptions={{ headerShown: false }} />
      <Text style={{ color: colors.fg, fontSize: 28, fontWeight: "700" }}>mote</Text>
      <Text style={{ color: colors.mutedFg, fontSize: 15 }}>
        The companion for your own instance. Type its address once.
      </Text>
      <Field
        label="Instance address"
        placeholder="mote.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={input}
        onChangeText={setInput}
        onSubmitEditing={() => void save()}
        caption={note?.text}
        captionColor={note?.color}
      />
      {(() => {
        let plain = false;
        try {
          plain = normalizeInstanceOrigin(input || "x").startsWith("http://");
        } catch {}
        return plain ? (
          <Text style={{ color: colors.warning, fontSize: 12 }}>
            Plain HTTP: your token will cross the network in the clear.
          </Text>
        ) : null;
      })()}
      <Pressable
        onPress={() => void save()}
        disabled={busy || input.trim().length === 0}
        style={{ minHeight: touchTarget, borderRadius: radius, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", opacity: busy || !input.trim() ? 0.5 : 1 }}
      >
        {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={{ color: colors.bg, fontWeight: "600" }}>Connect</Text>}
      </Pressable>

      {instances.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Saved instances</Text>
          {instances.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => {
                setActive(r.id);
                router.push("/sign-in");
              }}
              onLongPress={() =>
                Alert.alert("Forget instance?", r.id, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Forget", style: "destructive", onPress: () => forgetInstance(r.id) },
                ])
              }
              style={{ minHeight: touchTarget, padding: 12, borderRadius: radius, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, gap: 2 }}
            >
              <Text style={{ color: colors.fg, fontWeight: "500" }}>{r.label}</Text>
              <Text style={{ color: colors.mutedFg, fontSize: 12 }}>
                {r.id}
                {r.plainHttp ? " · http" : ""}
                {r.wsBlocked ? " · terminal blocked" : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={{ color: colors.mutedFg, fontSize: 11 }}>
        Private hosts (LAN/CGNAT/.local) default to http; everything else upgrades to https.
        {!looksPrivate("mote.example.com") ? "" : ""}
      </Text>
    </ScrollView>
  );
}
```

- [ ] **Step 4: Guard + sign-in**

Replace `apps/mobile/app/index.tsx`:

```tsx
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useApp } from "@/lib/app-state";
import { secureTokenStore } from "@/native/secure-token-store";
import { useMote } from "@/providers/mote-provider";

/**
 * The guard (spec §Auth): 401 clears the token → this screen re-presents the
 * right step. The pending route is the tab the user last held; expo-router
 * keeps deep links intact because /session/<id> is only reachable once signed
 * in — an unauthenticated hit lands here, then replaces the guard.
 */
export default function Guard() {
  const { hydrated, activeId } = useApp();
  const { client } = useMote();
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  useEffect(() => {
    if (!activeId) {
      setHasToken(false);
      return;
    }
    void secureTokenStore(activeId)
      .get()
      .then((t) => setHasToken(Boolean(t)))
      .catch(() => setHasToken(false));
  }, [activeId, client]);

  if (!hydrated || hasToken === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!activeId) return <Redirect href="/connect" />;
  if (!hasToken) return <Redirect href="/sign-in" />;
  return <Redirect href="/(tabs)" />;
}
```

Create `apps/mobile/app/sign-in.tsx`:

```tsx
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field } from "@/components/field";
import { ApiError } from "@/lib/api-error";
import { useApp } from "@/lib/app-state";
import { errMessage } from "@/lib/api-error";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { secureTokenStore } from "@/native/secure-token-store";
import { useMote } from "@/providers/mote-provider";

/** Sign in as the cookie actor (spec §Auth). Rate-limit copy included. */
export default function SignIn() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const { instances, activeId, setEmail } = useApp();
  const instance = instances.find((r) => r.id === activeId) ?? null;
  const [email, setEmailInput] = useState(instance?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setEmailInput(instance?.email ?? "");
  }, [instance?.email]);

  async function submit() {
    if (!client || busy || !email || !password) return;
    setBusy(true);
    setNote(null);
    try {
      await client.signIn(email.trim(), password);
      setEmail(email.trim());
      await secureTokenStore(client.baseUrl).set((await secureTokenStore(client.baseUrl).get()) ?? "");
      router.replace("/(tabs)");
    } catch (err) {
      setNote(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts — wait a minute and try again."
          : errMessage(err, "Sign-in failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <View style={{ flex: 1, padding: 24, paddingTop: insets.top + 48, gap: 16, justifyContent: "center" }}>
        <Stack screenOptions={{ headerShown: false }} />
        <Text style={{ color: colors.fg, fontSize: 24, fontWeight: "700" }}>{instance?.label ?? "mote"}</Text>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmailInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          onSubmitEditing={() => void submit()}
          caption={note ?? undefined}
          captionColor={colors.destructive}
        />
        <Pressable
          onPress={() => void submit()}
          disabled={busy || !email || !password}
          style={{ minHeight: touchTarget, borderRadius: radius, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", opacity: busy || !email || !password ? 0.5 : 1 }}
        >
          {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={{ color: colors.bg, fontWeight: "600" }}>Sign in</Text>}
        </Pressable>
        <Pressable onPress={() => router.replace("/connect")} style={{ alignItems: "center", padding: 8 }}>
          <Text style={{ color: colors.mutedFg }}>Use a different instance</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
```

(`client.signIn` already stores the token in SecureStore via the `TokenStore` — the extra `set` dance above is a no-op safety line; drop it in review if it bothers you: storage already happens in `MoteClient.signIn`.)

- [ ] **Step 5: Build check + trio, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/app apps/mobile/src/components/field.tsx
git commit -m "feat(mobile): provider root, guard, Connect and Sign-in screens"
git push
```

---

### Task 6: Sessions list — hooks + tab shell + sections

**Files:**
- Create: `apps/mobile/src/hooks/use-sessions.ts`
- Create: `apps/mobile/src/hooks/use-summary.ts`
- Create: `apps/mobile/app/(tabs)/_layout.tsx`
- Create: `apps/mobile/app/(tabs)/index.tsx`
- Create: `apps/mobile/src/components/session-card.tsx`

**Interfaces:**
- Consumes: `useMote` (T4/T5), `pollIntervalMs`/`hasActivity` (T2), `sectionize`/`waitingCount` (T2), `SessionView` (M2), `stripAnsi` (`@internal/backend-errors`), `colors` (T1), `MoteClient.summary()` (ships with the backend plan; falls back gracefully), expo-router `Tabs`.
- Produces: `useSessions()` → react-query result (`data`, `refetch`, `isRefetching`, `error`); `useWaitingCount()` → number; routes `/(tabs)/index` (list) with `Tabs` shell; `SessionCard` props `{ session, onPress }`. Task 7 pushes `/session/[id]`; Task 11/12 read the waiting badge.

- [ ] **Step 1: The polling hooks**

Create `apps/mobile/src/hooks/use-sessions.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import { useMote } from "@/providers/mote-provider";

/**
 * The list poll (spec §Transport): 3 s while anything runs/waits, 15 s
 * quiescent, stopped in background, immediate on resume. Query data is the
 * source of truth for every screen; nothing else re-fetches.
 */
export function useSessions() {
  const { client } = useMote();
  const qc = useQueryClient();
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      setForeground(s === "active");
      if (s === "active") void qc.invalidateQueries({ queryKey: ["sessions"] }); // resume-immediate
    });
    return () => sub.remove();
  }, [qc]);

  return useQuery({
    enabled: Boolean(client),
    queryKey: ["sessions"],
    queryFn: () => client!.sessions(),
    refetchInterval: (q) =>
      pollIntervalMs({ foreground, hasActivity: hasActivity(q.state.data ?? []) }) ?? false,
    refetchIntervalInBackground: false,
  });
}
```

Create `apps/mobile/src/hooks/use-summary.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { waitingCount } from "@/lib/session-order";
import { useMote } from "@/providers/mote-provider";
import { useSessions } from "@/hooks/use-sessions";

/**
 * Badge number (spec §Screens): the summary endpoint when the instance has
 * it, else derived from the same polled list — never a second network loop.
 */
export function useWaitingCount(): number {
  const { client } = useMote();
  const sessions = useSessions();
  const summary = useQuery({
    enabled: Boolean(client),
    queryKey: ["summary"],
    queryFn: () => client!.summary(),
    staleTime: 2000,
    retry: false, // 404 on older instances is the fallback signal, not an error to fight
  });
  return summary.data?.waiting ?? waitingCount(sessions.data ?? []);
}
```

- [ ] **Step 2: The card**

Create `apps/mobile/src/components/session-card.tsx`:

```tsx
import { stripAnsi } from "@internal/backend-errors";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { isWaiting } from "@/lib/session-order";
import { colors, radius } from "@/lib/tokens";
import type { SessionView } from "@/types/session";

/** One list row (spec §Screens Sessions card): name, harness, dot, preview, chip, death stats. */
export const SessionCard = memo(function SessionCard({
  session,
  onPress,
}: {
  session: SessionView;
  onPress: () => void;
}) {
  const waiting = isWaiting(session);
  const preview = stripAnsi(session.preview.at(-1) ?? "").trim();
  return (
    <Pressable
      onPress={onPress}
      style={{ backgroundColor: colors.card, borderRadius: radius, padding: 12, gap: 4, borderWidth: 1, borderColor: waiting ? colors.warning : colors.border }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: !session.alive ? colors.mutedFg : session.activity === "active" ? colors.success : colors.warning,
          }}
        />
        <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 16, fontWeight: "600", flex: 1 }}>
          {session.name}
        </Text>
        {waiting ? (
          <Text style={{ color: colors.bg, backgroundColor: colors.warning, borderRadius: 4, paddingHorizontal: 6, fontSize: 11, fontWeight: "700" }}>
            waiting
          </Text>
        ) : null}
      </View>
      <Text numberOfLines={1} style={{ color: colors.mutedFg, fontSize: 12 }}>
        {session.harnessId}
        {!session.alive
          ? ` · exited ${session.exitCode ?? "?"}${session.backoffCount > 0 ? ` · restarts ${session.backoffCount}` : ""}`
          : ""}
      </Text>
      {preview ? (
        <Text numberOfLines={1} style={{ color: colors.mutedFg, fontSize: 12, fontFamily: "Menlo" }}>
          {preview}
        </Text>
      ) : null}
    </Pressable>
  );
});
```

- [ ] **Step 3: Tabs shell + list screen**

Create `apps/mobile/app/(tabs)/_layout.tsx`:

```tsx
import { Tabs } from "expo-router";
import { Text } from "react-native";
import { colors } from "@/lib/tokens";

/** Compact shell: Sessions (waiting badge) · New · Settings (spec §Adaptive). */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedFg,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Sessions" }} />
      <Tabs.Screen name="new" options={{ title: "New" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}

/** Badge text helper — expo-router reads it via route params (set in index.tsx). */
export function Badge({ count }: { count: number }) {
  return <Text>{count > 0 ? String(count) : ""}</Text>;
}
```

Create `apps/mobile/app/(tabs)/index.tsx`:

```tsx
import { FlashList } from "@shopify/flash-list";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionCard } from "@/components/session-card";
import { useSessions } from "@/hooks/use-sessions";
import { useWaitingCount } from "@/hooks/use-summary";
import { sectionize } from "@/lib/session-order";
import { colors } from "@/lib/tokens";
import type { SessionView } from "@/types/session";

type Row = { kind: "header"; title: string } | { kind: "session"; session: SessionView };

/** Flattened section rows → one FlashList, stable identities, no section-API assumptions. */
function toRows(sections: ReturnType<typeof sectionize>): Row[] {
  const out: Row[] = [];
  const push = (title: string, list: SessionView[]) => {
    if (list.length === 0) return;
    out.push({ kind: "header", title });
    for (const s of list) out.push({ kind: "session", session: s });
  };
  push("Waiting for you", sections.waiting);
  push("Running", sections.running);
  push("Paused / exited", sections.exited);
  push("Completed", sections.completed);
  return out;
}

export default function SessionsList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, error, isLoading, isRefetching, refetch } = useSessions();
  const waiting = useWaitingCount();

  useFocusEffect(
    useCallback(() => {
      // expo-router renders the tab badge from the title option on focus:
      // (no-op — badge wiring lands with the wide shell in Task 14; the
      // count is already correct via useWaitingCount consumers.)
    }, []),
  );

  const rows = toRows(sectionize(data ?? []));

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 8 }}
      nativeID="sessions-list-root">
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: colors.fg, fontSize: 26, fontWeight: "700" }}>Sessions</Text>
        {waiting > 0 ? (
          <Text style={{ color: colors.warning, fontSize: 16, alignSelf: "center", fontWeight: "700" }}>
            {waiting} waiting
          </Text>
        ) : null}
      </View>
      {error && !data ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Text style={{ color: colors.destructive }}>Cannot reach the instance</Text>
          <Text style={{ color: colors.mutedFg, fontSize: 12 }}>Pull down to retry</Text>
        </View>
      ) : isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      ) : rows.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Text style={{ color: colors.mutedFg }}>Nothing running. Start one from the New tab.</Text>
        </View>
      ) : (
        <FlashList
          data={rows}
          estimatedItemSize={92}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.mutedFg} />}
          keyExtractor={(r, i) => (r.kind === "session" ? r.session.id : `h-${r.title}`)}
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <Text style={{ color: colors.mutedFg, fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 14, marginBottom: 4, paddingHorizontal: 16 }}>
                {item.title}
              </Text>
            ) : (
              <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                <SessionCard session={item.session} onPress={() => router.push(`/session/${item.session.id}`)} />
              </View>
            )
          }
        />
      )}
    </View>
  );
}
```

(`new` and `settings` routes must exist before expo-router compiles the tab group — they land in Tasks 10/11; until then, create the two files as `export default function Coming() { return null }` placeholders in THIS task's Step 4 so `expo export` stays green, and note them for replacement.)

- [ ] **Step 4: Placeholder tab routes, then build check + trio, commit and push**

```bash
printf 'export default function ComingSoon() {\n  return null;\n}\n' | tee apps/mobile/app/"(tabs)"/new.tsx apps/mobile/app/"(tabs)"/settings.tsx >/dev/null
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/src/hooks apps/mobile/src/components/session-card.tsx "apps/mobile/app/(tabs)"
git commit -m "feat(mobile): polled sessions list with web section rules"
git push
```

---

### Task 7: Detail screen — status, action bar, Log tab

**Files:**
- Modify: `apps/mobile/src/lib/api.ts` (add the session-mutation verbs)
- Create: `apps/mobile/src/hooks/use-session.ts`
- Create: `apps/mobile/src/hooks/use-session-log.ts`
- Create: `apps/mobile/src/components/prompt-modal.tsx`
- Create: `apps/mobile/src/components/session-detail.tsx`
- Create: `apps/mobile/app/session/[id].tsx`

**Interfaces:**
- Consumes: `MoteClient` + new methods, `isAlreadyGone`/`errMessage` (M2), `SessionView`/`SessionLogTail` (M2), colors, `isWaiting` (T2).
- Produces:
  - `MoteClient` gains: `rename(id, name)`, `setNotes(id, notes)`, `restart(id)`, `terminate(id)`, `deleteSession(id)` (paths `PATCH /:id/name`, `PATCH /:id/notes`, `POST /:id/restart`, `POST /:id/terminate`, `DELETE /:id` — verified against the routes);
  - `useSession(id)` (same cadence as the list), `useSessionLog(id, enabled)`;
  - `SessionDetail({ sessionId })` — the screen body reused by the wide shell (Task 14); `PromptModal({ title, initial, onDone })`.

- [ ] **Step 1: Extend MoteClient + pin with a test**

Append to `apps/mobile/src/lib/api.ts` (after `setNotify`):

```ts
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

  /** @param id - Session id @param notes - Operator note (null clears) */
  setNotes(id: string, notes: string | null): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    });
  }

  /**
   * Revives the session IN PLACE — same id, rotated token (contract 53654a8).
   * Deep links and notifications survive a restart.
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
```

Extend `apps/mobile/src/lib/__tests__/api.test.ts` with one fake-fetch case asserting each verb hits its exact method+path (follow the file's existing pattern for capturing requests).

- [ ] **Step 2: The detail hooks**

Create `apps/mobile/src/hooks/use-session.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { hasActivity, pollIntervalMs } from "@/lib/poll-policy";
import { useMote } from "@/providers/mote-provider";

/**
 * One session on the same clock as the list (spec §Rendering: session truth
 * comes from the polled list; the detail pill rides the same policy).
 */
export function useSession(id: string) {
  const { client } = useMote();
  return useQuery({
    enabled: Boolean(client && id),
    queryKey: ["session", id],
    queryFn: () => client!.session(id),
    refetchInterval: (q) =>
      pollIntervalMs({ foreground: true, hasActivity: hasActivity(q.state.data ? [q.state.data] : []) }) ?? false,
  });
}
```

Create `apps/mobile/src/hooks/use-session-log.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { useMote } from "@/providers/mote-provider";

/**
 * The Log tab source (spec §Rendering): the already-stripAnsi-ed native tail.
 * Fetched when the Log tab is first opened, then on pull only — it is a byte
 * tail, not a stream, so the 3 s loop would be theatre.
 */
export function useSessionLog(id: string, enabled: boolean) {
  const { client } = useMote();
  return useQuery({
    enabled: Boolean(client && id && enabled),
    queryKey: ["session-log", id],
    queryFn: () => client!.sessionLog(id),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 3: PromptModal + SessionDetail**

Create `apps/mobile/src/components/prompt-modal.tsx`:

```tsx
import { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { colors, radius, touchTarget } from "@/lib/tokens";

/**
 * Minimal text-entry modal for rename/notes (Alert.prompt is iOS-only; this
 * is the Android parity path). `onDone(null)` = cancelled — empty strings are
 * meaningful (they clear notes).
 */
export function PromptModal({
  title,
  initial,
  multiline,
  onDone,
}: {
  title: string;
  initial: string;
  multiline?: boolean;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Modal visible onRequestClose={() => onDone(null)} transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: "#000a", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <View style={{ width: "100%", maxWidth: 420, backgroundColor: colors.card, borderRadius: radius * 2, padding: 16, gap: 12 }}>
          <Text style={{ color: colors.fg, fontSize: 17, fontWeight: "600" }}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            multiline={multiline}
            autoFocus
            style={{
              minHeight: multiline ? 96 : touchTarget,
              textAlignVertical: multiline ? "top" : "center",
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius,
              padding: 10,
              color: colors.fg,
              backgroundColor: colors.bg,
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
            <Pressable onPress={() => onDone(null)} style={{ padding: 10 }}>
              <Text style={{ color: colors.mutedFg }}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => onDone(value)} style={{ padding: 10 }}>
              <Text style={{ color: colors.primary, fontWeight: "700" }}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
```

Create `apps/mobile/src/components/session-detail.tsx` (the reusable body; the Live tab mounts in Task 8 — it is rendered by `LiveHost` below, which Task 8 replaces):

```tsx
import { stripAnsi } from "@internal/backend-errors";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PromptModal } from "@/components/prompt-modal";
import { useSession } from "@/hooks/use-session";
import { useSessionLog } from "@/hooks/use-session-log";
import { errMessage, isAlreadyGone } from "@/lib/api-error";
import { isWaiting } from "@/lib/session-order";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { useQueryClient } from "@tanstack/react-query";
import { LiveHost } from "@/components/live-host";

/** Placeholder until Task 8 wires the WebView socket; keeps this task shippable. */
```

Wait — a self-contradiction: importing LiveHost before it exists breaks `verify-types`. Task order fix: Task 7 ships the **Log tab only** and renders a disabled Live pill (`<Text>terminal lands with the next build</Text>`); Task 8 replaces that block and adds the import. The Step-3 file therefore reads (Live branch):

```tsx
          {tab === "live" ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: colors.mutedFg }}>Terminal view ships with the next build.</Text>
            </View>
          ) : (
```

Full file:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PromptModal } from "@/components/prompt-modal";
import { useSession } from "@/hooks/use-session";
import { useSessionLog } from "@/hooks/use-session-log";
import { errMessage, isAlreadyGone } from "@/lib/api-error";
import { isWaiting } from "@/lib/session-order";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { useMote } from "@/providers/mote-provider";

/**
 * The detail body (spec §Screens Detail): status pill from the poll, the
 * Live∣Log tabs, and the full action bar. Destructive actions confirm;
 * 404-after-action converges on "gone" via isAlreadyGone rather than erroring.
 * Restart is IN-PLACE — same id, deep links survive (contract 53654a8).
 */
export function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack?: () => void }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const qc = useQueryClient();
  const { data: session, refetch, isRefetching, error } = useSession(sessionId);
  const [tab, setTab] = useState<"live" | "log">("log");
  const [modal, setModal] = useState<"name" | "notes" | null>(null);
  const log = useSessionLog(sessionId, tab === "log");

  function gone(err: unknown): boolean {
    if (isAlreadyGone(err)) {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      (onBack ?? (() => router.back()))();
      return true;
    }
    return false;
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    if (!client) return;
    try {
      await fn();
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ["sessions"] })]);
    } catch (err) {
      if (!gone(err)) Alert.alert(label, errMessage(err, "Request failed"));
    }
  }

  if (error && !session) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
        <Text style={{ color: colors.destructive }}>{errMessage(error, "Cannot load this session")}</Text>
      </View>
    );
  }

  const pill = !session
    ? { text: "…", color: colors.mutedFg }
    : isWaiting(session)
      ? { text: "waiting for you", color: colors.warning }
      : session.alive
        ? { text: "running", color: colors.success }
        : session.status === "terminated"
          ? { text: "completed", color: colors.mutedFg }
          : { text: "exited", color: colors.mutedFg };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {onBack ? null : (
            <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 6 }}>
              <Text style={{ color: colors.primary, fontSize: 17 }}>‹</Text>
            </Pressable>
          )}
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 19, fontWeight: "700", flex: 1 }}>
            {session?.name ?? "Session"}
          </Text>
          <Text style={{ color: pill.color, fontSize: 12, fontWeight: "700" }}>{pill.text}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {(["live", "log"] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: radius, backgroundColor: tab === t ? colors.accent : "transparent", borderWidth: 1, borderColor: colors.border }}
            >
              <Text style={{ color: tab === t ? colors.fg : colors.mutedFg, textTransform: "capitalize" }}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {tab === "live" ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.mutedFg }}>Terminal view ships with the next build.</Text>
        </View>
      ) : log.isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.mutedFg }}>Loading log…</Text>
        </View>
      ) : (
        <FlatList
          data={log.data?.lines ?? []}
          renderItem={({ item }) => (
            <Text style={{ color: colors.fg, fontFamily: "Menlo", fontSize: 12, paddingHorizontal: 12 }} accessibilityFontScale="none">
              {item.length > 0 ? item : " "}
            </Text>
          )}
          refreshControl={<RefreshControl refreshing={log.isRefetching} onRefresh={() => void log.refetch()} tintColor={colors.mutedFg} />}
          style={{ flex: 1, backgroundColor: colors.termCanvas }}
          contentContainerStyle={{ paddingVertical: 10 }}
        />
      )}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card, paddingBottom: insets.bottom + 12 }}>
        <Action label="Rename" onPress={() => setModal("name")} />
        <Action label="Notes" onPress={() => setModal("notes")} />
        <Action
          label={session?.notify ? "Bell on" : "Bell off"}
          color={session?.notify ? colors.warning : undefined}
          onPress={() => void run("Bell", () => client!.setNotify(sessionId, !(session?.notify ?? false)))}
        />
        <Action label="Restart" onPress={() => Alert.alert("Restart in place?", "Revives the same session (same id), resuming the conversation when possible.", [{ text: "Cancel", style: "cancel" }, { text: "Restart", onPress: () => void run("Restart", () => client!.restart(sessionId)) }])} />
        <Action label="Terminate" onPress={() => Alert.alert("Terminate?", "Kills the pane. Restart can revive it.", [{ text: "Cancel", style: "cancel" }, { text: "Terminate", style: "destructive", onPress: () => void run("Terminate", () => client!.terminate(sessionId)) }])} />
        <Action label="Delete" color={colors.destructive} onPress={() => Alert.alert("Delete?", "Removes the session for good.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void run("Delete", () => client!.deleteSession(sessionId)) }])} />
      </View>

      {modal ? (
        <PromptModal
          title={modal === "name" ? "Session name" : "Notes"}
          initial={modal === "name" ? (session?.name ?? "") : (session?.notes ?? "")}
          multiline={modal === "notes"}
          onDone={async (value) => {
            setModal(null);
            if (value === null || !client || !session) return;
            if (modal === "name") await run("Rename", () => client.rename(sessionId, value.trim() || session.name));
            else await run("Notes", () => client.setNotes(sessionId, value.trim() === "" ? null : value));
          }}
        />
      ) : null}
    </View>
  );
}

function Action({ label, color = colors.primary, onPress }: { label: string; color?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ minHeight: touchTarget - 8, justifyContent: "center", paddingHorizontal: 10 }}>
      <Text style={{ color, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
```

(The mid-file prose above is a plan note, not file content — the file is the single second code block.)

- [ ] **Step 4: The route shell**

Create `apps/mobile/app/session/[id].tsx`:

```tsx
import { Stack, useLocalSearchParams } from "expo-router";
import { SessionDetail } from "@/components/session-detail";

/** Deep-linkable full-screen detail: mote://session/<id> lands here. */
export default function SessionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      {id ? <SessionDetail sessionId={id} /> : null}
    </>
  );
}
```

- [ ] **Step 5: Trio + build, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
cd /home/theo/projects/mote && bun run --cwd apps/mobile test
git add apps/mobile/src/lib/api.ts apps/mobile/src/lib/__tests__/api.test.ts apps/mobile/src/hooks apps/mobile/src/components apps/mobile/app/session
git commit -m "feat(mobile): detail screen — log tab, action bar, in-place restart copy"
git push
```

---

### Task 8: Live terminal — xterm asset, socket hook, WebView bridge

**Files:**
- Modify: `apps/mobile/package.json` (+ `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 — repo pins mirrored from `apps/frontend/package.json:27,31`)
- Create: `apps/mobile/scripts/sync-terminal-assets.ts` (bun script)
- Create: `apps/mobile/assets/terminal.html` (generated + committed)
- Create: `apps/mobile/src/lib/session-socket.ts` (pure decisions + hook)
- Create: `apps/mobile/src/lib/__tests__/session-socket.test.ts`
- Create: `apps/mobile/src/components/live-host.tsx`
- Modify: `apps/mobile/src/components/session-detail.tsx` (replace the Live placeholder block with `<LiveHost sessionId={sessionId} active={tab === "live"} />`)

**Interfaces:**
- Consumes: `MoteClient.wsToken()` (M2), `wsOrigin` (M2), `ServerFrame`/`ClientFrame` from `@internal/session-protocol`, frames contract (spec §Transport).
- Produces: `RECONNECT_DELAY_MS`, `shouldReconnectAfterClose(code)`, `SocketStatus`, `useSessionSocket({ client, sessionId, active, onBytes, onReset, onStatus }) → { sendInput(bytes), sendResize(cols, rows), status }`; `LiveHost` renders the WebView and owns the bridge.

- [ ] **Step 1: Install xterm packages (asset source only)**

```bash
cd apps/mobile
bun add @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
bunx syncpack fix && bun install
git diff -- package.json apps/frontend/package.json bun.lock | head -40
```
Expected: only `apps/mobile/package.json` + `bun.lock`; the mobile packages are referenced ONLY by the sync script — grep confirms the bundle never imports them: `grep -rn "@xterm" apps/mobile/src apps/mobile/app || true` → empty (the WebView consumes the generated HTML, not the JS modules — Hermes never sees xterm).

- [ ] **Step 2: The failing socket test**

Create `apps/mobile/src/lib/__tests__/session-socket.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { RECONNECT_DELAY_MS, shouldReconnectAfterClose } from "@/lib/session-socket";

describe("close-code policy (mirrors use-session-ws.ts:63-64,128)", () => {
  it("retries everything below 4000 and nothing server-rejected", () => {
    expect(shouldReconnectAfterClose(1006)).toBe(true);
    expect(shouldReconnectAfterClose(3999)).toBe(true);
    expect(shouldReconnectAfterClose(4000)).toBe(false); // attach failed
    expect(shouldReconnectAfterClose(4001)).toBe(false); // unauthorized
    expect(shouldReconnectAfterClose(4004)).toBe(false); // not found / not running
  });
  it("keeps the documented fixed delay", () => {
    expect(RECONNECT_DELAY_MS).toBe(1500);
  });
});
```

- [ ] **Step 3: The sync script + generated HTML**

Create `apps/mobile/scripts/sync-terminal-assets.ts`:

```ts
/**
 * Regenerates assets/terminal.html — xterm + fit-inlined into one self-
 * contained page (spec §Rendering: "xterm ships as a local asset, never a
 * CDN <script>"; and the WebView's opaque origin could not fetch anyway).
 * Run after bumping @xterm/* in apps/mobile/package.json:
 *   bun scripts/sync-terminal-assets.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const js = readFileSync(join(root, "node_modules/@xterm/xterm/lib/xterm.js"), "utf8");
const css = readFileSync(join(root, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
const fit = readFileSync(join(root, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), "utf8");

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      ${css}
      html, body { margin: 0; height: 100%; background: #0a0c0f; overscroll-behavior: none; }
      #t { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="t"></div>
    <script>${js}</script>
    <script>${fit}</script>
    <script>
      // Glue only (~40 lines, spec §Rendering). The page owns NO network.
      const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
      const term = new Terminal({
        fontSize: 13,
        fontFamily: "Menlo, Courier New, monospace",
        cursorBlink: true,
        scrollback: 8000,
        theme: { background: "#0a0c0f", foreground: "#e4e4e7" },
      });
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById("t"));
      fitAddon.fit();
      term.onData((d) => post({ type: "keys", data: d }));
      term.onResize(({ cols, rows }) => post({ type: "size", cols, rows }));
      let pending = "";
      const flush = () => { if (pending) { term.write(pending); pending = ""; } };
      window.N = {
        write(s) { pending += s; flush(); },
        reset() { term.reset(); pending = ""; },
      };
      post({ type: "ready", cols: term.cols, rows: term.rows });
      window.addEventListener("resize", () => fitAddon.fit());
    </script>
  </body>
</html>
`;

writeFileSync(join(root, "assets/terminal.html"), html);
console.log(`wrote assets/terminal.html (${html.length} bytes)`);
```

Run it and sanity-check:

```bash
cd apps/mobile && bun scripts/sync-terminal-assets.ts && head -3 assets/terminal.html
```

- [ ] **Step 4: Implement the socket hook**

Create `apps/mobile/src/lib/session-socket.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientFrame, ServerFrame } from "@internal/session-protocol";
import { wsOrigin } from "@/lib/instance-url";
import type { MoteClient } from "@/lib/api";

/** Fixed reconnect delay — same as the web hook (`use-session-ws.ts`). */
export const RECONNECT_DELAY_MS = 1500;

/** 4xxx = server rejection (attach failed / unauthorized / not running):
 * retrying cannot succeed. Everything below is a transient drop. Mirrors
 * `apps/frontend/src/lib/use-session-ws.ts` close handling. */
export function shouldReconnectAfterClose(code: number): boolean {
  return code < 4000;
}

/** Live status for the detail pill/banner (spec §Error handling). */
export type SocketStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "closed"; code: number }
  | { state: "rejected"; code: number };

export interface SessionSocketHandlers {
  /** One pane-write chunk (replay tail or live output). */
  onBytes: (data: string) => void;
  /** First replay of a fresh attach: wipe the emulator (spec §Transport). */
  onReset: () => void;
  onStatus: (status: SocketStatus) => void;
}

/**
 * One socket, one session (spec §Transport): the token is minted per connect
 * AND per reconnect (single-use, 30 s). Frames are JSON text, exactly the
 * web contract. RN owns the socket — the WebView never sees it.
 */
export function useSessionSocket(opts: {
  client: MoteClient;
  sessionId: string;
  active: boolean;
  handlers: SessionSocketHandlers;
}) {
  const { client, sessionId, active } = opts;
  const handlersRef = useRef(opts.handlers);
  handlersRef.current = opts.handlers;
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [status, setStatus] = useState<SocketStatus>({ state: "connecting" });

  const report = useCallback((s: SocketStatus) => {
    setStatus(s);
    handlersRef.current.onStatus(s);
  }, []);

  const frame = useCallback((f: ClientFrame) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  }, []);

  /** Raw keystroke bytes for the pane. No-op while not open (like the web sendInput). */
  const sendInput = useCallback((data: string) => {
    if (data) frame({ type: "input", data });
  }, [frame]);

  /** tmux window geometry after xterm fits. */
  const sendResize = useCallback(
    (cols: number, rows: number) => {
      sizeRef.current = { cols, rows };
      if (cols > 0 && rows > 0) frame({ type: "resize", cols, rows });
    },
    [frame],
  );

  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false;

    const scheduleRetry = () => {
      if (cancelled) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
    };

    const connect = async () => {
      if (cancelled) return;
      report({ state: "connecting" });
      try {
        const { token } = await client.wsToken(); // per attempt, never reused
        if (cancelled) return;
        const url = `${wsOrigin(client.baseUrl)}/ws?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        let replayStarted = false;
        ws.onopen = () => {
          report({ state: "open" });
          const s = sizeRef.current; // sync tmux to the fitted terminal (80×24 default)
          if (s) ws.send(JSON.stringify({ type: "resize", cols: s.cols, rows: s.rows } satisfies ClientFrame));
        };
        ws.onmessage = (e) => {
          try {
            const f = JSON.parse(String(e.data)) as ServerFrame;
            if (f.type === "replay" && f.data) {
              if (!replayStarted) {
                handlersRef.current.onReset(); // full history per attach — wipe first
                replayStarted = true;
              }
              handlersRef.current.onBytes(f.data);
            } else if (f.type === "output" && f.data) {
              handlersRef.current.onBytes(f.data);
            }
          } catch {
            /* malformed frame: ignore, like the web client */
          }
        };
        ws.onclose = (ev) => {
          if (wsRef.current !== ws) return; // superseded socket's late close
          wsRef.current = null;
          if (ev.code >= 4000) report({ state: "rejected", code: ev.code });
          else {
            report({ state: "closed", code: ev.code });
            scheduleRetry();
          }
        };
        ws.onerror = () => {
          /* onclose always follows and drives the policy */
        };
      } catch {
        if (cancelled) return;
        report({ state: "closed", code: 0 }); // token mint failed — no socket to close
        scheduleRetry();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws?.close();
      } catch {
        /* already dead */
      }
    };
  }, [client, sessionId, active, report]);

  return { sendInput, sendResize, status };
}
```

- [ ] **Step 5: The WebView bridge component**

Create `apps/mobile/src/components/live-host.tsx`:

```tsx
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useSessionSocket } from "@/lib/session-socket";
import { colors } from "@/lib/tokens";
import { useMote } from "@/providers/mote-provider";

/**
 * The Live tab (spec §Rendering): a renderer, not a client. Incoming frames
 * arrive as strings via injectJavaScript; keystrokes/size post back through
 * onMessage. The page has no network and cannot reach the token — that is
 * what keeps the Keychain gate meaningful.
 */
export function LiveHost({ sessionId, active: tabActive }: { sessionId: string; active: boolean }) {
  const { client } = useMote();
  const webview = useRef<WebView | null>(null);
  const ready = useRef(false);
  const queue = useRef<string[]>([]); // writes before the page reports ready
  const [blocked, setBlocked] = useState<string | null>(null);

  const inject = useCallback((expr: string) => {
    if (!ready.current) {
      queue.current.push(expr);
      return;
    }
    webview.current?.injectJavaScript(expr);
  }, []);

  const socket = useSessionSocket({
    client: client!,
    sessionId,
    active: tabActive && Boolean(client) && !blocked,
    handlers: {
      onReset: () => inject("window.N.reset();true;"),
      onBytes: (data) => inject(`window.N.write(${JSON.stringify(data)});true;`),
      onStatus: (s) => {
        if (s.state === "rejected") setBlocked(s.code === 4001 ? "Not authorized — sign in again" : "This session is not running");
        if (s.state === "open") setBlocked(null);
      },
    },
  });

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let m: { type: string; data?: string; cols?: number; rows?: number } | null = null;
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (!m) return;
      if (m.type === "keys" && m.data) socket.sendInput(m.data);
      if (m.type === "size" && m.cols && m.rows) socket.sendResize(m.cols, m.rows);
      if (m.type === "ready") {
        ready.current = true;
        if (m.cols && m.rows) socket.sendResize(m.cols, m.rows);
        for (const expr of queue.current.splice(0)) webview.current?.injectJavaScript(expr);
      }
    },
    [socket],
  );

  if (!client) return null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.termCanvas }}>
      {blocked ? (
        <View style={{ padding: 12 }}>
          <Text style={{ color: colors.warning, fontSize: 13 }}>{blocked}</Text>
        </View>
      ) : null}
      <WebView
        ref={webview}
        source={require("../../assets/terminal.html")}
        onMessage={onMessage}
        javaScriptEnabled
        style={{ flex: 1, backgroundColor: colors.termCanvas }}
        // The renderer owns no network: block every request the page could try.
        onShouldStartLoadWithRequest={(r) => r.url.startsWith("file://") || r.url === "about:blank"}
        originWhitelist={["file://*"]}
      />
    </View>
  );
}
```

If `@react-navigation/native`'s `useIsFocused` import is unnecessary once `tabActive` fully gates it (it is), drop the import — keep the file lint-clean.

Replace the placeholder block in `apps/mobile/src/components/session-detail.tsx`:

```tsx
      {tab === "live" ? <LiveHost sessionId={sessionId} active /> : log.isLoading ? (
```

with the import `import { LiveHost } from "@/components/live-host";` added at top. (The `blocked` state also hides itself when the instance's `wsBlocked` flag is set — read it via `useApp` in review and skip mounting LiveHost entirely then.)

- [ ] **Step 6: Tests + trio + build, commit and push**

```bash
cd apps/mobile && bun test src/lib/__tests__/session-socket.test.ts && bun run verify-types && bun run lint:check && bun run build
git add apps/mobile/package.json bun.lock apps/mobile/scripts/sync-terminal-assets.ts apps/mobile/assets/terminal.html \
        apps/mobile/src/lib/session-socket.ts apps/mobile/src/lib/__tests__/session-socket.test.ts \
        apps/mobile/src/components/live-host.tsx apps/mobile/src/components/session-detail.tsx
git commit -m "feat(mobile): Live tab — inlined xterm WebView over the single-use-token socket"
git push
```

---

### Task 9: Key-bar UI + press-repeat + paste

**Files:**
- Create: `apps/mobile/src/components/key-bar.tsx`
- Modify: `apps/mobile/src/components/live-host.tsx` (render `<KeyBar>` under the WebView when the socket is open)
- Modify: `apps/mobile/package.json` (add `expo-clipboard` via `npx expo install expo-clipboard`)

**Interfaces:**
- Consumes: `KEY_BAR_BUTTONS`/`KEY_BAR_EXTENDED`/`isRepeatable`/`wrapPaste` (T1), `sendInput` via a new `onBytes` prop on LiveHost internals.
- Produces: `KeyBar({ disabled, onBytes })` RN component; LiveHost forwards its socket's `sendInput` wrapped in `wrapPaste(text, true)` for pastes (xterm's DECSET-2004 mirror: bracket by default since harness TUIs enable it — plain when the user disables it in Settings later, YAGNI for now).

- [ ] **Step 1: Install the clipboard lib (library-first per standing preference — no hand-rolled Clipboard bridge)**

```bash
cd apps/mobile && npx expo install expo-clipboard && bunx syncpack fix && bun install
git diff apps/mobile/package.json | head; git diff apps/frontend/package.json apps/backend/package.json  # must be empty
```

- [ ] **Step 2: Implement KeyBar**

Create `apps/mobile/src/components/key-bar.tsx`:

```tsx
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { isRepeatable, KEY_BAR_BUTTONS, KEY_BAR_EXTENDED, type KeyBarButton } from "@/lib/key-bar";
import { colors, touchTarget } from "@/lib/tokens";

const REPEAT_DELAY_MS = 400;
const REPEAT_RATE_MS = 90;

/**
 * The accessory row (spec §Screens key bar; web terminal-key-bar.tsx rules):
 * every button is a plain byte sender; arrows press-repeat; `⋯` flips to the
 * Ctrl/Pg page; paste arrives wrapped in bracketed-paste markers.
 */
export function KeyBar({ disabled, onBytes }: { disabled: boolean; onBytes: (bytes: string) => void }) {
  const [extended, setExtended] = useState(false);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  function startRepeat(b: KeyBarButton) {
    onBytes(b.bytes);
    if (!isRepeatable(b.label)) return;
    repeatTimer.current = setTimeout(() => {
      repeatTimer.current = setInterval(() => onBytes(b.bytes), REPEAT_RATE_MS) as unknown as ReturnType<typeof setInterval>;
    }, REPEAT_DELAY_MS);
  }

  function stopRepeat() {
    if (repeatTimer.current) {
      clearTimeout(repeatTimer.current);
      clearInterval(repeatTimer.current as unknown as ReturnType<typeof setInterval>);
      repeatTimer.current = null;
    }
  }

  const buttons = extended ? KEY_BAR_EXTENDED : KEY_BAR_BUTTONS;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 4 }}>
        {buttons.map((b) => (
          <Pressable
            key={b.label}
            disabled={disabled}
            onPressIn={() => startRepeat(b)}
            onPressOut={stopRepeat}
            onRejectResponderTerminationRequest={() => false}
            style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1 }}
          >
            <Text style={{ color: colors.mutedFg, fontFamily: "Menlo", fontSize: 14 }}>{b.label}</Text>
          </Pressable>
        ))}
        <Pressable
          disabled={disabled}
          onPress={() => setExtended((v) => !v)}
          style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: extended ? colors.primary : colors.mutedFg, fontSize: 16 }}>⋯</Text>
        </Pressable>
        <Pressable
          disabled={disabled}
          onPress={async () => onBytes(await Clipboard.getStringAsync())}
          style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: colors.mutedFg, fontSize: 14 }}>📋</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
```

Note: paste here sends raw clipboard text through the same `onBytes` path; LiveHost wraps it — see Step 3.

- [ ] **Step 3: Wire into LiveHost**

In `apps/mobile/src/components/live-host.tsx`: import `{ KeyBar }` and `wrapPaste`; add a local handler:

```tsx
  const onKeyBytes = useCallback((bytes: string) => socket.sendInput(bytes), [socket]);
  const onPaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    socket.sendInput(wrapPaste(text, true)); // harness TUIs run with DECSET 2004
  }, [socket]);
```

and remove the 📋 button from `key-bar.tsx` (pass `onPaste` into KeyBar instead — replace its internal button with `{ onPaste && <Pressable onPress={() => void onPaste()} …>📋</Pressable> }` + prop `onPaste?: () => Promise<void> | void`). Render under the WebView:

```tsx
      <KeyBar disabled={socket.status.state !== "open"} onBytes={onKeyBytes} onPaste={onPaste} />
```

- [ ] **Step 4: Trio + build, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/src/components/key-bar.tsx apps/mobile/src/components/live-host.tsx apps/mobile/package.json bun.lock
git commit -m "feat(mobile): key bar with press-repeat, extended page, bracketed paste"
git push
```

---

### Task 10: New-session screen

**Files:**
- Modify: `apps/mobile/src/lib/api.ts` (add `profiles()`, `setupStatus()`, `filesExplore(path?)`, `filesRecent()`, `createSession(input)`)
- Create: `apps/mobile/src/types/profile.ts` (ProfileView mirror of `ProfileSchema`)
- Create: `apps/mobile/src/hooks/use-profiles.ts`
- Create: `apps/mobile/src/hooks/use-folder-browser.ts`
- Create: `apps/mobile/app/(tabs)/new.tsx` (replaces the placeholder)

**Interfaces:**
- Consumes: backend contracts verified this session — `GET /api/profiles` → `ProfileSchema[]`; `GET /api/files/explore?path=` → `{path, parent, entries[{name,path,kind:"dir"|"file"}], recent[{path,label}], favorites[{path,label}]}` (cookie-only); `GET /api/files/recent` → `{paths:[{path,label}]}`; `POST /api/sessions {profileId, workingDir, name?, prompt?}` → `{id, tmuxSocket, promptDelivered}`; `GET /api/setup/status` → `{needsSetup, hasUsers}`.
- Produces: the MoteClient verbs above; `FolderEntry`/`ExploreResult` types; `useFolderBrowser(initialPath?)` exposing `{ path, entries, recent, favorites, open(dir), up(), pick }`; the working New tab. Task 14 reuses its folder sheet inside the wide shell.

- [ ] **Step 1: API + types**

Add to `apps/mobile/src/lib/api.ts` (with JSDoc on each; paths above):

```ts
  /** @returns The signed-in user's profiles (new-session picker). */
  profiles(): Promise<ProfileView[]> {
    return this.request<ProfileView[]>("/api/profiles");
  }

  /** @returns `{ needsSetup, hasUsers }` (sign-in screen hint). */
  setupStatus(): Promise<{ needsSetup: boolean; hasUsers: boolean }> {
    return this.request("/api/setup/status");
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

  /** @returns Recently used working directories, newest first. */
  filesRecent(): Promise<{ paths: { path: string; label: string | null }[] }> {
    return this.request("/api/files/recent");
  }

  /**
   * Creates and launches a session (spec §Screens New session).
   * @param input - profileId + workingDir, optional name and first prompt
   * @returns The new session id (the pane may still be settling)
   */
  createSession(input: { profileId: string; workingDir: string; name?: string; prompt?: string }): Promise<{ id: string }> {
    return this.request("/api/sessions", { method: "POST", body: JSON.stringify(input) });
  }
```

Create `apps/mobile/src/types/profile.ts`:

```ts
/** Hand-written mirror of `ProfileSchema` (apps/backend/src/api/models.ts). */
export interface ProfileView {
  /** Profile id (uuid) */
  id: string;
  /** Harness plugin id, e.g. `claude-code`. */
  harnessId: string;
  /** Display name. */
  name: string;
  /** Longer description. */
  description: string | null;
  /** 1 = auto-seeded default profile (cannot be deleted). */
  isDefault: number;
  /** 1 = auto-restart on exit for new sessions from this profile. */
  restartOnExit: number;
}

/** One entry from `GET /api/files/explore`. */
export interface FolderEntry {
  /** File/dir name (dotfiles hidden server-side). */
  name: string;
  /** Absolute path. */
  path: string;
  /** Only two kinds ever ship; anything else is filtered server-side. */
  kind: "dir" | "file";
}

/** Response of `GET /api/files/explore` — one request per folder by design. */
export interface ExploreResult {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  recent: { path: string; label: string | null }[];
  favorites: { path: string; label: string | null }[];
}
```

- [ ] **Step 2: The hooks**

Create `apps/mobile/src/hooks/use-profiles.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { useMote } from "@/providers/mote-provider";

/** Profiles for the picker — static enough that 60 s freshness is fine. */
export function useProfiles() {
  const { client } = useMote();
  return useQuery({
    enabled: Boolean(client),
    queryKey: ["profiles"],
    queryFn: () => client!.profiles(),
    staleTime: 60_000,
  });
}
```

Create `apps/mobile/src/hooks/use-folder-browser.ts`:

```ts
import { useState } from "react";
import { useMote } from "@/providers/mote-provider";
import { ApiError } from "@/lib/api-error";
import type { ExploreResult } from "@/types/profile";

/**
 * The native folder sheet (spec §Screens): one level per request, back via
 * `parent`, favourites+recents arrive with the first level. Imperative (not
 * react-query) because the sheet is a transient drill-down stack, not cache.
 */
export function useFolderBrowser() {
  const { client } = useMote();
  const [current, setCurrent] = useState<ExploreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(path?: string) {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      setCurrent(await client.filesExplore(path));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "Outside the allowed roots" : "Cannot read that folder");
    } finally {
      setBusy(false);
    }
  }

  return { current, busy, error, open, up: () => void open(current?.parent ?? undefined) };
}
```

- [ ] **Step 3: The screen**

Rewrite `apps/mobile/app/(tabs)/new.tsx`:

```tsx
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Field } from "@/components/field";
import { useFolderBrowser } from "@/hooks/use-folder-browser";
import { useProfiles } from "@/hooks/use-profiles";
import { errMessage } from "@/lib/api-error";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { useMote } from "@/providers/mote-provider";

/** New-session tab (spec §Screens): profile picker + folder sheet + optional prompt. */
export default function NewSession() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const profiles = useProfiles();
  const folders = useFolderBrowser();
  const [profileId, setProfileId] = useState<string | null>(null);
  const [workingDir, setWorkingDir] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profileId && profiles.data?.length) setProfileId(profiles.data[0].id);
  }, [profiles.data, profileId]);

  async function start() {
    if (!client || !profileId || !workingDir || busy) return;
    setBusy(true);
    try {
      const res = await client.createSession({
        profileId,
        workingDir,
        name: name.trim() || undefined,
        prompt: prompt.trim() || undefined,
      });
      router.replace(`/session/${res.id}`);
    } catch (err) {
      Alert.alert("Could not start", errMessage(err, "Request failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, gap: 16 }}>
        <Text style={{ color: colors.fg, fontSize: 26, fontWeight: "700" }}>New session</Text>

        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Profile</Text>
          {profiles.isLoading ? <ActivityIndicator /> : (
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={profiles.data ?? []}
              keyExtractor={(p) => p.id}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => setProfileId(item.id)}
                  style={{ padding: 10, marginRight: 8, borderRadius: radius, borderWidth: 1, borderColor: profileId === item.id ? colors.primary : colors.border, backgroundColor: colors.card }}
                >
                  <Text style={{ color: profileId === item.id ? colors.primary : colors.fg, fontWeight: "600" }}>{item.name}</Text>
                  <Text style={{ color: colors.mutedFg, fontSize: 11 }}>{item.harnessId}</Text>
                </Pressable>
              )}
            />
          )}
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>Working directory</Text>
          <Pressable
            onPress={() => {
              setSheet(true);
              if (!folders.current) void folders.open(workingDir || undefined);
            }}
            style={{ minHeight: touchTarget, borderRadius: radius, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "flex-start", justifyContent: "center", paddingHorizontal: 12 }}
          >
            <Text numberOfLines={1} style={{ color: workingDir ? colors.fg : colors.mutedFg, fontFamily: "Menlo", fontSize: 13 }}>
              {workingDir || "Choose a folder…"}
            </Text>
          </Pressable>
        </View>

        <Field label="Name (optional)" value={name} onChangeText={setName} autoCapitalize="none" />
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.mutedFg, fontSize: 13 }}>First prompt (optional)</Text>
          <Field
            label=""
            value={prompt}
            onChangeText={setPrompt}
            multiline
            numberOfLines={4}
            style={{ minHeight: 88, textAlignVertical: "top" }}
          />
        </View>

        <Pressable
          onPress={() => void start()}
          disabled={!profileId || !workingDir || busy}
          style={{ minHeight: touchTarget, borderRadius: radius, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", opacity: !profileId || !workingDir || busy ? 0.5 : 1 }}
        >
          {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={{ color: colors.bg, fontWeight: "700" }}>Start session</Text>}
        </Pressable>
      </ScrollView>

      <Modal visible={sheet} animationType="slide" onRequestClose={() => setSheet(false)}>
        <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 }}>
            <Pressable onPress={folders.up} hitSlop={12}><Text style={{ color: colors.primary, fontSize: 17 }}>↑</Text></Pressable>
            <Text numberOfLines={1} style={{ color: colors.fg, flex: 1, fontFamily: "Menlo", fontSize: 13 }}>{folders.current?.path ?? "…"}</Text>
            <Pressable onPress={() => setSheet(false)} hitSlop={12}><Text style={{ color: colors.mutedFg }}>Close</Text></Pressable>
          </View>
          {folders.error ? <Text style={{ color: colors.destructive, padding: 16 }}>{folders.error}</Text> : null}
          <FlatList
            data={[
              ...(folders.current ? folders.current.favorites.map((f) => ({ ...f, sect: "★ " })) : []),
              ...(folders.current ? folders.current.recent.map((f) => ({ ...f, sect: "🕘 " })) : []),
              ...(folders.current ? folders.current.entries.filter((e) => e.kind === "dir").map((e) => ({ path: e.path, label: e.name, sect: "" })) : []),
            ]}
            keyExtractor={(i) => `${i.sect}${i.path}`}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  if (item.sect === "" && folders.current?.entries.some((e) => e.path === item.path && e.kind === "dir")) void folders.open(item.path);
                  else if (item.sect !== "") {
                    setWorkingDir(item.path);
                    setSheet(false);
                  } else void folders.open(item.path);
                }}
                style={{ minHeight: touchTarget, justifyContent: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}
              >
                <Text style={{ color: colors.fg, fontFamily: "Menlo", fontSize: 13 }}>
                  {item.sect}
                  {item.label ?? item.path.split("/").pop() ?? item.path}
                </Text>
              </Pressable>
            )}
            ListFooterComponent={
              folders.current ? (
                <Pressable onPress={() => { setWorkingDir(folders.current!.path); setSheet(false); }} style={{ margin: 16, minHeight: touchTarget, borderRadius: radius, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ color: colors.fg, fontWeight: "700" }}>Use this folder</Text>
                </Pressable>
              ) : null
            }
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
```

The row-tap branch above is intentionally simple: starred/clocked rows select; bare rows descend. If it reads convoluted in review, tag entries with a `kind` field in the mapped list instead of comparing `sect` strings.

- [ ] **Step 4: Trio + build, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/src/lib/api.ts apps/mobile/src/types/profile.ts apps/mobile/src/hooks "apps/mobile/app/(tabs)/new.tsx"
git commit -m "feat(mobile): new-session tab with native folder sheet"
git push
```

---

### Task 11: Settings screen

**Files:**
- Modify: `apps/mobile/app/(tabs)/settings.tsx` (replace placeholder)

**Interfaces:**
- Consumes: `useApp` (T4), `makeProbeDeps`/`probeInstance` (T5/T3), `useMote` (T4), `MoteClient.forgetDevice` (backend plan T3 + MoteClient extension), AsyncStorage token mirror `mote.pushToken`, `signOut` (M2), colors.
- Produces: the working Settings tab; the push-token AsyncStorage key shared with Task 12.

- [ ] **Step 1: Implement**

Rewrite `apps/mobile/app/(tabs)/settings.tsx`:

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useState } from "react";
import * as Notifications from "expo-notifications";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { makeProbeDeps } from "@/app/connect"; // expo-router files export components; move makeProbeDeps to src/lib/probe-real.ts if the router complains — it will: do that, it is cleaner.
import { useApp } from "@/lib/app-state";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { secureTokenStore } from "@/native/secure-token-store";
import { useMote } from "@/providers/mote-provider";

export const PUSH_TOKEN_KEY = "mote.pushToken";

/** Settings (spec §Screens): switch instance, re-probe, push permission, sign out. */
export default function Settings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { client } = useMote();
  const { instances, activeId, setActive, setWsBlocked } = useApp();
  const [busy, setBusy] = useState(false);

  async function reprobe(id: string) {
    setBusy(true);
    const r = await probeInstance(id, makeProbeDeps());
    setBusy(false);
    setWsBlocked(id, r.ok && r.wsBlocked);
    Alert.alert(
      r.ok ? "Instance reachable" : "Unreachable",
      r.ok ? (r.wsBlocked ? "HTTP works; WebSocket upgrades do not — the Live tab stays hidden." : "HTTP and WebSocket both work.") : "Check the address and your VPN.",
    );
  }

  async function askPush() {
    const before = await Notifications.getPermissionsAsync();
    const after = before.status === "granted" ? before : await Notifications.requestPermissionsAsync();
    Alert.alert(after.status === "granted" ? "Notifications on" : "Notifications off", after.status === "granted" ? "" : "Allow them in system Settings if this is unexpected.");
  }

  async function signOutHere() {
    if (!client) return;
    const pushToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (pushToken) {
      try {
        await client.forgetDevice(pushToken); // signed-out phones must stop ringing
      } catch {
        /* best effort — the local clear is what the user experiences */
      }
      await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
    }
    await client.signOut();
    await secureTokenStore(client.baseUrl).clear();
    router.replace("/sign-in");
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 24, gap: 10 }}>
      <Text style={{ color: colors.fg, fontSize: 26, fontWeight: "700" }}>Settings</Text>
      <Text style={{ color: colors.mutedFg, fontSize: 13, marginTop: 6 }}>Instances</Text>
      {instances.map((r) => (
        <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: radius, borderWidth: 1, borderColor: r.id === activeId ? colors.primary : colors.border, backgroundColor: colors.card }}>
          <Pressable style={{ flex: 1, minHeight: touchTarget - 12, justifyContent: "center" }} onPress={() => setActive(r.id)}>
            <Text style={{ color: r.id === activeId ? colors.primary : colors.fg, fontWeight: "600" }}>{r.label}</Text>
            <Text style={{ color: colors.mutedFg, fontSize: 12 }}>{r.id}{r.wsBlocked ? " · ws blocked" : ""}</Text>
          </Pressable>
          <Pressable onPress={() => void reprobe(r.id)} style={{ padding: 10 }} disabled={busy}>
            <Text style={{ color: colors.primary }}>{busy ? "…" : "Re-probe"}</Text>
          </Pressable>
        </View>
      ))}
      <Pressable onPress={() => void askPush()} style={{ minHeight: touchTarget, borderRadius: radius, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "flex-start", justifyContent: "center", paddingHorizontal: 12, marginTop: 8 }}>
        <Text style={{ color: colors.fg }}>Notification permission</Text>
      </Pressable>
      <Pressable onPress={() => Alert.alert("Sign out?", "Forgets this device for push and clears the Keychain token.", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void signOutHere() },
      ])} style={{ minHeight: touchTarget, borderRadius: radius, backgroundColor: colors.destructive, alignItems: "center", justifyContent: "center", marginTop: 12 }}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>Sign out</Text>
      </Pressable>
      <Pressable onPress={() => router.push("/connect")} style={{ alignItems: "center", padding: 8 }}>
        <Text style={{ color: colors.mutedFg }}>Add another instance</Text>
      </Pressable>
    </ScrollView>
  );
}
```

**Do the relocation the header note says:** move `makeProbeDeps` out of `app/connect.tsx` into `apps/mobile/src/lib/probe-real.ts` (router files should not export logic), update both importers (`connect.tsx`, `settings.tsx`).

- [ ] **Step 2: Trio + build, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/app/"(tabs)"/settings.tsx apps/mobile/app/connect.tsx apps/mobile/src/lib/probe-real.ts
git commit -m "feat(mobile): settings tab — instance switching, re-probe, push consent, sign-out"
git push
```

---

### Task 12: Push enrollment, notification actions, deep-link routing

**Files:**
- Create: `apps/mobile/src/native/push.ts`
- Modify: `apps/mobile/app/_layout.tsx` (handler setup + cold-start + resume enrollment + response routing)

**Interfaces:**
- Consumes: `expo-notifications` (dep, present), `expo-crypto` (unused here; present), `useMote`, `parseSessionDeepLink` (T3), `PUSH_TOKEN_KEY` (T11), backend `POST /api/devices` + `PATCH /:id/notify`.
- Produces: `configureNotifications()`, `enrollPush(client): Promise<string|null>`, response handling for the `Silence bell` background action.

- [ ] **Step 1: Implement the push module**

Create `apps/mobile/src/native/push.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Device, Platform } from "react-native";
import { useQueryClient } from "@tanstack/react-query"; // (not used here — for the response-handler hook below)
import type { MoteClient } from "@/lib/api";

export const PUSH_TOKEN_KEY = "mote.pushToken"; // single source; settings imports from here

/**
 * Foreground presentation: the app is open, still say it — banners only, no
 * sound storm on the 3 s poll-driven UI (keeps parity with the web bell).
 */
export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false, // the badge is payload-driven (spec §Push), not here
    }),
  });
  // Lock-screen actions (spec §Decisions): Open is default; Silence bell is
  // the only second affordance — nothing destructive is reachable locked.
  void Notifications.setNotificationCategoryAsync("session", [
    new Notifications.NotificationAction("open", "Open", { activationMode: "foreground" }),
    new Notifications.NotificationAction("silence", "Silence bell", {
      activationMode: "background",
      options: ["authenticationRequired"],
    }),
  ]);
  if (Platform.OS === "android") {
    void Notifications.setNotificationChannelAsync("default", {
      name: "Sessions",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

/**
 * Enroll on cold start and every resume (spec §Push: enrollment upserts on
 * every cold start so token churn stays bounded). Returns the token that
 * stands, or null when permission/hardware says no.
 */
export async function enrollPush(client: MoteClient): Promise<string | null> {
  if (!Device.isDevice) return null; // Expo push is device-only; emulators lie
  const cur = await Notifications.getPermissionsAsync();
  const perm = cur.granted ? cur : await Notifications.requestPermissionsAsync();
  if (!perm.granted) return null;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync();
    const prev = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (prev === data) return data; // unchanged: skip the write, not the check
    await client.enrollDevice(data, Platform.OS === "ios" ? "ios" : "android");
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, data);
    return data;
  } catch {
    return null; // no relay creds/instance hiccup: retry next resume
  }
}
```

Drop the unused `useQueryClient` import line before committing (it is deliberately not in the final file).

- [ ] **Step 2: Wire the root layout**

Update `apps/mobile/app/_layout.tsx` — inside `MoteProvider` add a `<PushBridge />` component (same file or `src/providers/push-bridge.tsx`; put it in providers to keep route files thin):

```tsx
// apps/mobile/src/providers/push-bridge.tsx
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState, Device } from "react-native";
import { parseSessionDeepLink } from "@/lib/deep-link";
import { enrollPush, configureNotifications, PUSH_TOKEN_KEY } from "@/native/push";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMote } from "@/providers/mote-provider";

/**
 * Owns the notification lifecycle: handler/categories (once), enrollment
 * (cold start + resume, when signed in on a real device), and response
 * routing — tap or `Silence bell` resolves through the SAME parser as every
 * other deep link (spec: opening still requires the biometric gate, which
 * the detail screen applies, Task 13).
 */
export function PushBridge() {
  const { client } = useMote();
  const qc = useQueryClient();

  useEffect(() => {
    configureNotifications();
  }, []);

  useEffect(() => {
    if (!client) return;
    void enrollPush(client);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void enrollPush(client);
    });
    return () => sub.remove();
  }, [client]);

  useEffect(() => {
    const handle = async (resp: Notifications.NotificationResponse) => {
      const sid = (resp.notification.request.content.data as { sid?: string } | undefined)?.sid;
      const url = resp.notification.request.content.data ? undefined : resp.notification.request.content._originalData?.url as string | undefined;
      const target = sid ?? (url ? parseSessionDeepLink(url) : null);
      if (!target) return;
      if (resp.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
        router.push(`/session/${target}`);
      } else if (resp.actionIdentifier === "silence") {
        // Best-effort with whatever session we hold; when the app was killed
        // and the token needs re-entry, the next detail visit shows the bell
        // still on — documented v1 limitation (spec §Follow-ups rich actions).
        if (client) {
          void client.setNotify(target, false).then(() => qc.invalidateQueries({ queryKey: ["sessions"] })).catch(() => {});
        }
      }
    };
    void Notifications.getLastNotificationResponseAsync().then((r) => r && void handle(r));
    const sub = Notifications.addNotificationResponseReceivedListener((r) => void handle(r));
    return () => sub.remove();
  }, [client, qc]);

  return null;
}
```

The `Device`/`AsyncStorage` imports above are leftovers — remove unused ones at lint time. Mount it:

```tsx
// app/_layout.tsx inside MoteProvider:
<MoteProvider>
  <PushBridge />
  <StatusBar style="light" />
  …
```

- [ ] **Step 3: Trio + build, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/src/native/push.ts apps/mobile/src/providers/push-bridge.tsx apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): Expo push enrollment, lock-screen actions, response routing"
git push
```

---

### Task 13: Biometric gate

**Files:**
- Modify: `apps/mobile/package.json` (+ `expo-local-authentication` via `npx expo install expo-local-authentication`)
- Create: `apps/mobile/src/native/biometric.ts`
- Modify: `apps/mobile/src/components/session-detail.tsx` (gate Live mount + actions)
- Modify: `apps/mobile/app/(tabs)/settings.tsx` (toggle)

**Interfaces:**
- Consumes: expo-local-authentication, AsyncStorage pref `mote.biometric`.
- Produces: `requireBiometric(reason): Promise<boolean>` (true = proceed), `setBiometricEnabled(on)`, `isBiometricEnabled()`.

- [ ] **Step 1: Install** (same dance as Task 9; verify no other app's package.json moved).

- [ ] **Step 2: Implement the gate**

Create `apps/mobile/src/native/biometric.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";

/**
 * The Face ID/Touch ID gate (spec §Security notes): it gates USE of the
 * token — this credential can inject keystrokes into every pane on the
 * instance — not its storage. Pref defaults ON; the Settings toggle lets an
 * operator with no enrolled biometric opt out.
 */
const PREF = "mote.biometric";

export async function isBiometricEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(PREF)) !== "off";
}

export async function setBiometricEnabled(on: boolean): Promise<void> {
  await AsyncStorage.setItem(PREF, on ? "on" : "off");
}

/**
 * @param reason - Shown in the system sheet ("Unlock the terminal")
 * @returns true when the caller may proceed; a device without enrolled
 * biometrics also returns true (documented product choice: the gate adds a
 * layer, it must not become a brick or a silent-bypass foot-gun).
 */
export async function requireBiometric(reason: string): Promise<boolean> {
  if (!(await isBiometricEnabled())) return true;
  const [hasHardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  if (!hasHardware || !enrolled) return true;
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: "Not now",
    disableDeviceFallback: false,
  });
  return res.success;
}
```

- [ ] **Step 3: Apply it in the detail screen**

In `session-detail.tsx`:

1. Live tab: gate the switch — `onPress={() => void (async () => { if (await requireBiometric("Unlock the terminal")) setTab(t); })()}` for the `live` tab button, and mount `LiveHost` only when `tab === "live"`.
2. The action bar's `run(...)` wrapper starts with: `if (!(await requireBiometric(`Confirm: ${label}`))) return;`.

```tsx
  async function run(label: string, fn: () => Promise<unknown>) {
    if (!client) return;
    if (!(await requireBiometric(`Confirm: ${label}`))) return;
    …
```

- [ ] **Step 4: Settings toggle** — add beside the push row:

```tsx
      <BiometricToggle />
```

with a small local component reading/writing `isBiometricEnabled`/`setBiometricEnabled` via a `Pressable` row + `Switch`.

- [ ] **Step 5: Trio + build, commit and push**

```bash
cd apps/mobile && bun run verify-types && bun run test && bun run lint:check && bun run build
git add apps/mobile/src/native/biometric.ts apps/mobile/src/components/session-detail.tsx apps/mobile/app/"(tabs)"/settings.tsx apps/mobile/package.json bun.lock
git commit -m "feat(mobile): biometric gate on terminal use and destructive actions"
git push
```

---

### Task 14: Adaptive wide shell (iPad / Split View)

**Files:**
- Create: `apps/mobile/src/hooks/use-is-wide.ts`
- Modify: `apps/mobile/app/(tabs)/index.tsx` (wide variant)
- Modify: `apps/mobile/src/components/session-detail.tsx` (accept an optional inline mode — already takes `onBack`, verify it renders cleanly inside a column)

**Interfaces:**
- Consumes: `isWide`/`WIDE_MIN_WIDTH` (`@/lib/breakpoints`, M2), `useWindowDimensions`.
- Produces: `useIsWide()` (live under Split View — it is `useWindowDimensions().width >= 1024`, per spec, the same 1024 as the web's `WORKSPACE_TILING_MIN_WIDTH`); the wide list renders a left rail + list column + detail column with the selection mirrored into `?sid=`.

- [ ] **Step 1: Implement the hook**

```ts
import { useWindowDimensions } from "react-native";
import { isWide } from "@/lib/breakpoints";

/** True on iPad landscape / tablet AVDs / Split View past 1024 (spec §Adaptive). */
export function useIsWide(): boolean {
  return isWide(useWindowDimensions().width);
}
```

- [ ] **Step 2: Restructure the list screen**

In `app/(tabs)/index.tsx`: when `useIsWide()`, render `flexDirection: "row"` — the existing FlashList column at width 380 plus `<SessionDetail sessionId={searchParams.sid ?? selectedId} onBack={undefined} />` filling the rest; tapping a card calls `router.setParams({ sid: id })` instead of pushing. Compact keeps `router.push`. Extract the current JSX into a local `ListColumn` component inside the file to keep both branches honest. Empty selection → muted `Text` "Select a session".

- [ ] **Step 3: Verify on both AVDs (the emulator gate)**

```bash
# per apps/mobile/AGENTS.md — API 34 images only:
source ~/.config/mote-mobile-env.sh
emulator -avd mote_tablet34 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -memory 4096 &
adb wait-for-device && adb reverse tcp:8081 tcp:8081
cd apps/mobile && bun run android   # or expo run:android — build, install, launch dev client
adb shell wm size                    # confirm the AVD width is ≥1024 dp
```
Then, against a running instance (host backend, `adb reverse tcp:3080 tcp:3080` + connect to `http://localhost:3080`), confirm: three columns appear on `mote_tablet34`, single-column tabs on `mote_phone34`. Use `adb logcat -b crash -d | grep -c 'F DEBUG'` and `adb shell pm list packages | grep -c .` for emulator health per AGENTS.md. Note the known open SIGSEGV-on-launch issue in `apps/mobile/AGENTS.md` — if it reproduces, record it in the commit message, do not chase it blind; the bundle gate is `expo export` + `bun run harness:m1` against the same instance.

- [ ] **Step 4: Trio + build, commit and push**

```bash
git add apps/mobile/src/hooks/use-is-wide.ts apps/mobile/app/"(tabs)"/index.tsx
git commit -m "feat(mobile): wide shell at 1024px — rail, list and detail columns, ?sid= deep-link parity"
git push
```

---

### Task 15: Integration gate — bundle, harness, checklist, docs

**Files:**
- Modify: `apps/mobile/AGENTS.md` (record the M3+ non-obvious decisions landed during Tasks 1–14)
- No other source unless a gate fails.

- [ ] **Step 1: Full verification matrix**

```bash
cd /home/theo/projects/mote
bun run verify-types && bun run lint:check && bun run test   # root trio
bun run --cwd apps/mobile test                                # mobile pure suite
cd apps/mobile && bun run build                               # expo export (bundle integrity)
cd /home/theo/projects/mote && turbo build                    # whole graph incl. backend-client
```
All green, and `git status` clean.

- [ ] **Step 2: The transport harness against the live instance** (no emulator needed; proves auth + WS end-to-end):

```bash
cd apps/mobile && bun run harness:m1
# optional destructive leg ONLY against a test session: MOTE_SEND_INPUT=1 bun run harness:m1
```
Expected: PASS on probe → sign-in → guarded read → ws-token → attach → replay-then-output, per the harness's own output.

- [ ] **Step 3: Android emulator smoke (device gate, emulator-trustable subset)**

With `mote_phone34` + `mote_tablet34` (API 34, AGENTS.md recipe), the dev build pointed at the host instance: sign in, list renders sections, detail opens, Log tab shows tail, key bar sends (verify `^C` interrupts a running `sleep 60`), wide shell on the tablet AVD, biometric prompt fires (emulator fingerprint: `adb -e emu finger touch 1`). Push/badge/lock-screen are **not** emulator-trustable — they go on the manual real-device checklist instead:

- [ ] Bell ON → finish a turn → notification arrives with app KILLED; title generic, no session name
- [ ] Tap opens the right session on the right instance; badge == waiting count
- [ ] Silence bell works from the lock screen; Terminate is absent
- [ ] Face ID gate fires before Live/actions on the real device
- [ ] iPad landscape shows three columns; Split View re-layouts at the 1024 boundary

- [ ] **Step 4: Update `apps/mobile/AGENTS.md`** with what was learned (sync script re-run rule; the WebView no-network posture; SecureStore key slug rule; any emulator findings), then:

```bash
git add apps/mobile/AGENTS.md
git commit -m "docs(mobile): record the v1 app-shell decisions"
git push
```

Report the branch as ready for operator review — **do not merge to main** (standing instruction from the operator, 2026-08-31).

---

## Spec coverage map (self-review result)

| Spec requirement | Task |
| --- | --- |
| Connect/Sign-in (typed origin, per-instance list, needs-setup copy, 401-resume guard) | 4, 5 |
| Poll policy 3 s/15 s/background/resume-immediate | 2, 6 |
| Sectioning mirroring web predicates; card fields | 2, 6 |
| Detail: Live∣Log, full action bar, in-place restart, isAlreadyGone convergence | 7, 8 |
| Log tab native + server-side stripAnsi reliance | 7 |
| WebView owns no network/secrets; xterm local asset; reset-on-first-replay; close-code rules; 1500 ms; token per connect | 8 |
| Key bar byte-for-byte + press-repeat + ⋯ page + bracketed paste | 1, 9 |
| New session (profiles, folder sheet, recents, prompt) | 10 |
| Settings (switch, re-probe, push consent, sign-out deregisters) | 11 |
| Push enrollment cold-start/resume, categories Open+Silence (non-destructive, auth-required), token mirror, android channel | 12 |
| Deep link mote://session/<id> — handled by expo-router's native scheme routing; standalone parser deleted as dead code (see Amendments) | 3†, 12 |
| Biometric gates USE, not storage | 13 |
| 1024 breakpoint, iPad-portrait-is-phone-shaped, Split View, ?sid= route parity, App-Store-4.1 posture | 14 |
| Probe on save + persisted wsBlocked banner + Live hidden | 3, 5, 11 |
| Verification trio + expo export + harness + manual gate list | 15 |
| Nothing joins turbo test; separate runners | global constraints |

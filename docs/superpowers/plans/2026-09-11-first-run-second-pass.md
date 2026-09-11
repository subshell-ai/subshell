# First Run, Second Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Subshell Server's first run into one Setup-Assistant-style flow: three native screens (Welcome, a conditional Install tmux, Set Up → Setting Up) that hand off in place to the SPA's `/setup` (Create Your Account, Add an Agent, Start Your First Subshell), rendered in one shared visual frame with continuous progress dots; and (phase 3) move agent-CLI installation into the control plane.

**Architecture:** The Tauri `wizard` window keeps its lifecycle (boot branching, `onboarded`, reset's return path) but is fixed at 1024×720 and its page becomes an assistant frame driven by `screensFor`/`dots`/`setupRows`/`canSetup` in `wizard-state.ts` over the unchanged `desktop_setup` chain; `open_main` inherits the wizard's geometry so the dashboard appears where the assistant was. The SPA's `/setup` drops its card for a `SetupAssistant` layout with `StepDots` (offset by three in the desktop shell) and a detection-first `AgentRow` list over the existing `GET /api/setup/harnesses`. Phase 3 adds `POST /api/setup/agents/:id/install` and deletes the desktop's `desktop_install_agent` path.

**Tech Stack:** Tauri v2 (Rust), plain-DOM TypeScript + Vite + Tailwind v4 (desktop `ui/`), React 19 + TanStack Router/Query + Base-UI/shadcn-style primitives + lucide-react (`apps/server/web`), ElysiaJS + `t` schemas (`apps/server/api`), `bun test`, Playwright (`e2e/`).

**Spec:** `docs/superpowers/specs/2026-09-11-first-run-second-pass-design.md` — read it first; § 3 (the frame) is the visual contract every UI task implements.

## Global Constraints

- Bun only (`bun`, `bunx`); never npm/pnpm/yarn. Pinned dependency versions.
- No `await import()` anywhere (the one sanctioned exception is `pane-runtime/plugin-runtime.ts`).
- Every Elysia `t` schema property carries a `description`.
- No em dashes in user-facing copy (desktop console house rule, `504b927`). Titles in Title Case, subtitles in sentence case (spec § 3.2). "this Mac" on darwin, "this machine" elsewhere.
- Vocabulary: **server** = control plane, **node** = a machine that runs agents, **client** = a human interface.
- `apps/server/**` is AGPL-3.0-only; everything else Apache-2.0. Nothing here crosses the line.
- Changesets: `@internal/desktop-server` and `@internal/server` only. **Never** `@internal/server-web`.
- Verification after every task: `bun run verify-types && bun run lint:check && bun run test` from the repo root. Rust tasks additionally `bun run rust:check`.
- Desktop UI tests: `cd apps/server/desktop && bun run test`. Web: `cd apps/server/web && bun test`. API: `cd apps/server/api && bun test <file>`.
- Frame constants (spec § 3.1), used by both implementations: window 1024×720; column max-width 560px; illustration 96px; title 30px/600/-0.01em; subtitle 15px muted; content 36px below subtitle; forms 360px; bottom bar 72px with a hairline top; dots 8px (current 10px) at 10px gap; motion 220ms ease-out crossfade + 12px slide, 160ms tick draw, honoured only under `prefers-reduced-motion: no-preference`.
- Commit after each task with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Do not push. Work on a branch (`feat/first-run-second-pass`).

---

## Phase 0 — Verify the detection claim

### Task 0: Confirm whether server-side detection sees `~/.local/bin/claude` under launchd

**Files:** none modified unless the check fails.

- [ ] **Step 1: Ask the running local server what it detects**

On the operator's Mac, with the service-run server up and a signed-in browser session, copy the session cookie from DevTools and run:

```bash
curl -s -H "Cookie: <paste the better-auth.session_token cookie>" http://127.0.0.1:3080/api/setup/harnesses \
  | bun -e 'const rows = await Bun.stdin.json(); for (const r of rows) console.log(r.id, r.installed, r.version ?? "", r.reason ?? "")'
```

Expected on a machine with Claude Code installed: `claude-code true <version>`.

- [ ] **Step 2: If `claude-code false not-on-path`, find which rung missed**

```bash
which claude; ls -l ~/.local/bin/claude ~/.local/share/claude/versions/claude 2>/dev/null
launchctl print gui/$(id -u)/dev.subshell.server | grep -A3 'environment'
```

`knownPaths` in `packages/plugins/claude-code/package.json` covers `.local/bin/claude`; `detectBinaryWithOptions` (`packages/pane-runtime/src/binary-lookup.ts`) walks PATH, then `knownPaths` against `HOME`. Write the failing case as a test in `packages/pane-runtime/src/__tests__/binary-lookup.test.ts` (inject `env` + `pathEntries` and a temp `HOME` with the layout you found), fix the rung, commit `fix(pane-runtime): detect <layout> for claude`.

- [ ] **Step 3: Record the outcome** as one line under "## 5" of the spec.

---

## Phase 1 — The native assistant

### Task 1: `wizard-state.ts` — screens, dots, rows, gate, failure line

**Files:**
- Modify: `apps/server/desktop/ui/src/lib/wizard-state.ts` (rewrite)
- Modify: `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts` (rewrite)

**Interfaces:**
- Consumes: `Probe`, `ActionResult` from `./ipc` (unchanged).
- Produces: `ScreenId`, `screensFor`, `dots`, `SetupRowId`, `SetupRow`, `setupRows`, `canSetup`, `failureLine`, `PrereqState`, `prereqState`. Deletes `WizardStepId`, `STEP_ORDER`, `STEP_LABELS`, `firstOpenStep`, `runRows`, `canContinue`, `RunRow`.

- [ ] **Step 1: Write the failing tests**

Replace the test file with:

```ts
import { describe, expect, it } from "bun:test";
import type { ActionResult, Probe } from "../lib/ipc";
import { canSetup, dots, failureLine, prereqState, screensFor, setupRows } from "../lib/wizard-state";

function virgin(over: Partial<Probe> = {}): Probe {
  return {
    bundledVersion: "1.0.0",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "setup",
    error: null,
    tmux: null,
    platform: "darwin",
    hasBrew: true,
    onboarded: false,
    hostname: "mac",
    ...over,
  } as Probe;
}
const NO_EDITS = { port: "", host: "" };
const WITH_TMUX = { tmux: "/opt/homebrew/bin/tmux" };

describe("screensFor", () => {
  it("shows the tmux screen only while tmux is missing", () => {
    expect(screensFor(virgin())).toEqual(["welcome", "tmux", "setup"]);
    expect(screensFor(virgin(WITH_TMUX))).toEqual(["welcome", "setup"]);
  });
});

describe("dots", () => {
  it("always has six positions", () => expect(dots(virgin(), "welcome").total).toBe(6));
  it("counts a skipped tmux screen as done", () => {
    expect(dots(virgin(WITH_TMUX), "setup")).toEqual({ total: 6, done: 2, current: 2 });
    expect(dots(virgin(WITH_TMUX), "welcome")).toEqual({ total: 6, done: 0, current: 0 });
  });
  it("walks the three when tmux is missing", () => {
    expect(dots(virgin(), "tmux")).toEqual({ total: 6, done: 1, current: 1 });
    expect(dots(virgin(), "setup")).toEqual({ total: 6, done: 2, current: 2 });
  });
});

describe("setupRows", () => {
  it("is five rows, tmux first, all pending on a virgin machine", () => {
    const rows = setupRows(virgin(), NO_EDITS);
    expect(rows.map((r) => r.id)).toEqual(["tmux", "server", "config", "service", "running"]);
    expect(rows.every((r) => !r.done)).toBe(true);
  });
  it("ticks from facts, never optimism", () => {
    const p = virgin({
      ...WITH_TMUX,
      server: { argv: ["/x/subshell-server"], source: "local-bin", version: "1.0.0" },
      status: { configEnv: { exists: true } } as never,
      service: { installed: true } as never,
      next: "start",
    });
    const done = Object.fromEntries(setupRows(p, NO_EDITS).map((r) => [r.id, r.done]));
    expect(done).toEqual({ tmux: true, server: true, config: true, service: true, running: false });
  });
  it("details name the defaults until Customize edits them", () => {
    expect(setupRows(virgin(), NO_EDITS).find((r) => r.id === "config")?.detail).toBe("port 3080, all interfaces");
    expect(setupRows(virgin(), { port: "4000", host: "127.0.0.1" }).find((r) => r.id === "config")?.detail).toBe(
      "port 4000, 127.0.0.1",
    );
  });
});

describe("canSetup", () => {
  it("refuses with a reason while no probe has answered", () =>
    expect(canSetup(null, false)).toEqual({ ok: false, reason: "Checking this machine…" }));
  it("refuses silently while busy", () => expect(canSetup(virgin(WITH_TMUX), true)).toEqual({ ok: false, reason: "" }));
  it("waits for tmux, the chain's one hard stop", () =>
    expect(canSetup(virgin(), false)).toEqual({ ok: false, reason: "Waiting for tmux" }));
  it("is ok once tmux answers, even with no server yet", () =>
    expect(canSetup(virgin(WITH_TMUX), false)).toEqual({ ok: true }));
});

describe("failureLine", () => {
  const r = (stdout: string, stderr: string): ActionResult => ({ ok: false, stdout, stderr });
  it("takes the last non-empty stderr line", () =>
    expect(failureLine(r("installing…\n", "warning: x\nrefused: no tmux on PATH\n\n"))).toBe("refused: no tmux on PATH"));
  it("falls back to stdout's last line", () => expect(failureLine(r("step one\nstep two failed", ""))).toBe("step two failed"));
  it("has a fixed sentence when both are empty", () => expect(failureLine(r("", "  \n"))).toBe("Setup stopped."));
});

describe("prereqState", () => {
  it("found when tmux answers", () => expect(prereqState(virgin(WITH_TMUX))).toBe("found"));
  it("install where a plan exists", () => expect(prereqState(virgin({ hasBrew: true }))).toBe("install"));
  it("manual on a Mac without Homebrew", () => expect(prereqState(virgin({ hasBrew: false }))).toBe("manual"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server/desktop && bun test ui/src/__tests__/wizard-state.test.ts` — FAIL (missing exports).

- [ ] **Step 3: Rewrite `wizard-state.ts`**

```ts
/**
 * The setup assistant's decisions, pure (spec 2026-09-11 § 5, § 8.1).
 *
 * Which screens exist for THIS machine, where the dots stand, which
 * checklist rows are ticked, whether Set Up may be pressed and why not, and
 * which of the CLI's words go under a failed row. Page state (the current
 * screen, running, the last result) stays in wizard.ts; only facts a probe
 * licenses live here, so a reopen after a quit or a CLI-driven half-setup
 * renders honestly.
 */
import type { ActionResult, Probe } from "./ipc";

/** The assistant's screens, in order. `tmux` exists only while tmux is missing. */
export type ScreenId = "welcome" | "tmux" | "setup";

/** Every position a dot can take, whether or not the screen is shown. */
const ALL_SCREENS: readonly ScreenId[] = ["welcome", "tmux", "setup"];

/** How the tmux screen presents itself when missing. */
export type PrereqState = "found" | "install" | "manual";

/** Where the press installs the server; rendered as a constant, resolved for real in Rust. */
const INSTALL_PATH = "~/.local/bin/subshell-server";

export function prereqState(probe: Probe): PrereqState {
  if (probe.tmux) return "found";
  if (probe.platform === "darwin") return probe.hasBrew ? "install" : "manual";
  return "install";
}

/** The screens this machine will actually see: a screen with nothing to ask does not appear. */
export function screensFor(probe: Probe): ScreenId[] {
  return ALL_SCREENS.filter((s) => s !== "tmux" || probe.tmux === null);
}

/**
 * Dot semantics: six positions always, not three. The SPA's three `/setup`
 * screens always follow the native ones on a desktop first run, so a
 * three-dot row would grow to six the moment the SPA takes over — the row's
 * width never changes at the handoff. A machine that skips the tmux screen
 * sees its dot already filled rather than a shorter row.
 */
export function dots(_probe: Probe, current: ScreenId): { total: 6; done: number; current: number } {
  const index = ALL_SCREENS.indexOf(current);
  return { total: 6, done: index, current: index };
}

export type SetupRowId = "tmux" | "server" | "config" | "service" | "running";

export interface SetupRow {
  id: SetupRowId;
  label: string;
  /** Muted right-hand text: a path, the addresses, or what "done" will mean. */
  detail: string;
  done: boolean;
}

/**
 * The Setting Up checklist, ticked from probe facts and never from the
 * chain's progress (optimism ticks a row the CLI then refuses). `addresses`
 * are the Customize form's current values, empty when untouched.
 */
export function setupRows(probe: Probe, addresses: { port: string; host: string }): SetupRow[] {
  const port = addresses.port || "3080";
  const host = addresses.host === "" || addresses.host === "0.0.0.0" ? "all interfaces" : addresses.host;
  return [
    { id: "tmux", label: "tmux", detail: probe.tmux ?? "", done: probe.tmux !== null },
    { id: "server", label: "Server", detail: probe.server?.argv[0] ?? INSTALL_PATH, done: probe.server !== null },
    { id: "config", label: "Configuration", detail: `port ${port}, ${host}`, done: probe.status?.configEnv?.exists === true },
    { id: "service", label: "Background service", detail: "starts at login", done: probe.service?.installed === true },
    { id: "running", label: "Running", detail: "", done: probe.next === "ready" },
  ];
}

/**
 * Whether Set Up is live, and the reason beside it when not. An empty reason
 * means busy: a spinner is already on screen. The only machine gate is tmux
 * (`init` and `service install` both refuse without it); a missing server is
 * the chain's own first act.
 */
export function canSetup(probe: Probe | null, busy: boolean): { ok: true } | { ok: false; reason: string } {
  if (probe === null) return { ok: false, reason: "Checking this machine…" };
  if (busy) return { ok: false, reason: "" };
  if (probe.tmux === null) return { ok: false, reason: "Waiting for tmux" };
  return { ok: true };
}

/** The one line under a failed row: the CLI's last word on stderr, else stdout's, else a fixed sentence. */
export function failureLine(result: ActionResult): string {
  const last = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last(result.stderr) ?? last(result.stdout) ?? "Setup stopped.";
}
```

- [ ] **Step 4: Run tests** — PASS. (`verify-types` fails in `wizard.ts` until Task 3.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop/ui/src/lib/wizard-state.ts apps/server/desktop/ui/src/__tests__/wizard-state.test.ts
git commit -m "refactor(desktop-server): the setup assistant's decisions, pure"
```

### Task 2: Window geometry — a fixed assistant, a dashboard that appears in its place

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/windows.rs` (`open_wizard`, `open_main`)

**Interfaces:** none new. Behaviour: wizard 1024×720, centered, not resizable, titled "Set Up Subshell Server"; `open_main` inherits the wizard's outer position and inner size when a wizard window exists.

- [ ] **Step 1: `open_wizard`**

Replace the builder chain in `open_wizard` with:

```rust
    // A setup assistant is a fixed frame (spec 2026-09-11 § 4): 1024 wide
    // because that is MIN_WIDTH, the dashboard's own floor, which is what
    // lets `open_main` take this window's geometry and appear in its place.
    WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html".into()))
        .title("Set Up Subshell Server")
        .inner_size(MIN_WIDTH, 720.0)
        .resizable(false)
        .center()
        .build()
        .map_err(|e| format!("could not open the setup window: {e}"))
```

- [ ] **Step 2: `open_main` inherits the geometry**

Before `let builder = WebviewWindowBuilder::new(app, "main", ...)`, add:

```rust
    // When the assistant is on screen, the dashboard appears exactly where it
    // was, at the same size, and the assistant closes underneath: one window
    // changing screen, not two windows trading places (spec § 4). Logical
    // units, because the builder takes logical and the window reports physical.
    let inherited = app.get_webview_window("wizard").and_then(|w| {
        let scale = w.scale_factor().ok()?;
        let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
        let size = w.inner_size().ok()?.to_logical::<f64>(scale);
        Some((pos, size))
    });
```

Remove `.inner_size(1280.0, 860.0)` from the chain, bind the chain to `let builder = ...;`, then before `builder.build()`:

```rust
    let builder = match inherited {
        Some((pos, size)) => builder.position(pos.x, pos.y).inner_size(size.width, size.height),
        None => builder.inner_size(1280.0, 860.0),
    };
```

Keep `.min_inner_size(MIN_WIDTH, MIN_HEIGHT)` in the chain.

- [ ] **Step 3: Verify**

```bash
bun run rust:check
```

Expected: fmt, clippy `-D warnings` and tests pass in all three crates. Then run the app (`bun run dev:app` with a staged sidecar; force the wizard by setting `"onboarded": false` in `~/Library/Application Support/dev.subshell.server/settings.json` while the app is closed) and confirm the window is 1024×720, centered, cannot be resized, and — after Task 3 — the dashboard opens in the same place.

- [ ] **Step 4: Commit**

```bash
git add apps/server/desktop/src-tauri/src/windows.rs
git commit -m "feat(desktop-server): a fixed setup window, and a dashboard that appears in its place"
```

### Task 3: The native assistant frame and its three screens

**Files:**
- Modify: `apps/server/desktop/ui/wizard.html` (rewrite)
- Modify: `apps/server/desktop/ui/src/wizard.ts` (rewrite)
- Modify: `apps/server/desktop/ui/src/styles.css` (delete `.rail*`, `.row-done`, `.row-pending`; add the `.assistant*` classes; keep `.wizard-copy` for the console's reset view and retitle its comment)
- Create: `apps/server/desktop/ui/public/app-icon.png` (copy of `src-tauri/icons/128x128@2x.png`)
- Modify: `apps/server/desktop/src-tauri/capabilities/wizard.json` (drop `allow-desktop-install-agent`; new description)
- Test: `apps/server/desktop/ui/src/__tests__/ipc-acl.test.ts` (existing, must pass)

**Interfaces:**
- Consumes: Task 1's module; `ipc.probe/setup/installTmux/setServerBin/openTmuxDocs/openMain/openConsole`; `config-form.ts` unchanged; `tmuxInstallPlan` from `installers.ts`.

- [ ] **Step 1: The asset**

```bash
mkdir -p apps/server/desktop/ui/public && cp apps/server/desktop/src-tauri/icons/128x128@2x.png apps/server/desktop/ui/public/app-icon.png
```

Vite serves `public/` at the bundle root; the CSP's `img-src 'self'` allows it.

- [ ] **Step 2: `wizard.html`**

```html
<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Set Up Subshell Server</title>
  </head>
  <body class="assistant">
    <!-- The setup assistant (spec 2026-09-11 § 3, § 5): one frame, three
         screens, the same CSP rules as index.html (module script with a src,
         nothing inline). wizard.ts fills #art, #title, #subtitle, #content and
         the bar; the frame itself never changes shape. -->
    <main class="assistant-screen" id="screen">
      <div class="assistant-art" id="art" aria-hidden="true"></div>
      <h1 class="assistant-title" id="title"></h1>
      <p class="assistant-subtitle" id="subtitle"></p>
      <p class="assistant-problem" id="problem"></p>
      <section class="assistant-content" id="content"></section>
    </main>
    <footer class="assistant-bar">
      <div class="assistant-bar-left" id="bar-left"></div>
      <div class="assistant-dots" id="dots"></div>
      <div class="assistant-bar-right" id="bar-right"></div>
    </footer>
    <script type="module" src="/src/wizard.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Styles**

Add inside `@layer components` (after the existing `.pane-pre` block), and delete `.rail`, `.rail-step*`, `.row-done`, `.row-pending`:

```css
  /* The setup assistant's frame (spec 2026-09-11 § 3.1). One fixed 1024x720
     window: a centered 560px column, and a 72px bar pinned to the bottom. */
  body.assistant { padding: 0; height: 100vh; display: grid; grid-template-rows: 1fr 72px; overflow: hidden; }
  .assistant-screen { display: flex; flex-direction: column; align-items: center; padding: 96px 32px 24px; overflow: auto; }
  .assistant-art { width: 96px; height: 96px; margin-bottom: 28px; display: grid; place-items: center; color: color-mix(in oklch, var(--color-primary) 55%, transparent); }
  .assistant-art img { width: 96px; height: 96px; }
  .assistant-art svg { width: 72px; height: 72px; }
  .assistant-title { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; text-align: center; }
  .assistant-subtitle { margin: 8px 0 0; max-width: 560px; text-align: center; color: var(--color-muted); font-size: 15px; line-height: 1.55; }
  .assistant-subtitle:empty { display: none; }
  .assistant-problem { margin: 12px 0 0; color: var(--color-warn); font-size: 14px; }
  .assistant-problem:empty { display: none; }
  .assistant-content { width: 100%; max-width: 560px; margin-top: 36px; }
  .assistant-content:empty { display: none; }
  .assistant-form { width: 360px; margin: 0 auto; display: grid; gap: 12px; }
  .assistant-bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 32px; border-top: 1px solid var(--color-line); }
  .assistant-bar-left { display: flex; gap: 8px; }
  .assistant-bar-right { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
  .assistant-bar-right .reason { color: var(--color-muted); font-size: 13px; }
  .assistant-bar button.primary { min-width: 120px; }
  .ghost { border-color: transparent; color: var(--color-muted); }
  .ghost:hover:not(:disabled) { color: var(--color-fg); border-color: var(--color-line); }
  .linkish { border: none; background: none; color: var(--color-muted); padding: 4px 0; font-size: 14px; }
  .linkish:hover:not(:disabled) { color: var(--color-fg); border: none; }
  /* Dots: not interactive (aria-hidden; an sr-only "Step N of M" sits beside them). */
  .assistant-dots { display: flex; gap: 10px; align-items: center; }
  .assistant-dots i { display: block; width: 8px; height: 8px; border-radius: 999px; background: var(--color-line); }
  .assistant-dots i.done { background: var(--color-primary); }
  .assistant-dots i.current { background: var(--color-primary); width: 10px; height: 10px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  /* What-will-happen rows (Set Up) and the checklist (Setting Up). */
  .plan-rows, .checklist { list-style: none; margin: 0; padding: 0; }
  .plan-rows li, .checklist li { display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 0 14px; min-height: 48px; }
  .plan-rows li + li, .checklist li + li { border-top: 1px solid color-mix(in oklch, var(--color-line) 60%, transparent); }
  .plan-rows .label, .checklist .label { font-size: 15px; }
  .plan-rows .detail, .checklist .detail { color: var(--color-muted); font-size: 13px; text-align: right; overflow-wrap: anywhere; }
  .checklist .glyph { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; font-size: 13px; }
  .checklist li[data-state="pending"] .glyph { border: 1.5px solid var(--color-line); }
  .checklist li[data-state="done"] .glyph { background: var(--color-ok); color: var(--color-primary-fg); }
  .checklist li[data-state="active"] .glyph { border: 2px solid var(--color-primary); border-right-color: transparent; }
  .checklist li[data-state="failed"] .glyph { border: 1.5px solid var(--color-bad); color: var(--color-bad); }
  .checklist .sub { grid-column: 2 / -1; padding-bottom: 10px; font-size: 13px; color: var(--color-bad); }
  .assistant details { margin-top: 16px; }
  .assistant details > summary { cursor: pointer; color: var(--color-muted); font-size: 14px; }
  .big { width: 100%; padding: 12px 16px; font-size: 15px; }
  .code-line { display: inline-block; background: var(--color-bg); border: 1px solid var(--color-line); border-radius: 6px; padding: 4px 9px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  @media (prefers-reduced-motion: no-preference) {
    .assistant-screen.enter { animation: screen-in 220ms ease-out; }
    .checklist li[data-state="active"] .glyph { animation: spin 0.9s linear infinite; }
    .checklist li[data-state="done"] .glyph { animation: tick 160ms ease-out; }
  }
  @keyframes screen-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes tick { from { transform: scale(0.6); } to { transform: scale(1); } }
```

- [ ] **Step 4: `wizard.ts`**

```ts
/**
 * The setup assistant (spec 2026-09-11 § 5): three screens in one fixed
 * frame, machine work as progress, the dashboard opened by the page itself.
 * DOM only; every judgment is imported from wizard-state and tested without
 * a webview. Shares lib/ with the console on purpose: prefill, the tmux plan
 * and the IPC edge are one contract, not two.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CONFIG_FIELDS,
  configPayload,
  derivedBaseUrl,
  type ExplicitMap,
  effectiveForm,
  explicitFields,
  type FormValues,
  fieldProblems,
} from "./lib/config-form";
import { tmuxInstallPlan } from "./lib/installers";
import type { ActionResult, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { canSetup, dots, failureLine, prereqState, type ScreenId, screensFor, setupRows } from "./lib/wizard-state";
import "./styles.css";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the setup page is missing #${id}`);
  return node;
};
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const POLL_MS = 1500;

// ---------------------------------------------------------------------------
// State. The current screen is the one piece of page memory; everything else
// is a probe fact or an in-flight action.
// ---------------------------------------------------------------------------
let probe: Probe | null = null;
let screen: ScreenId = "welcome";
/** A one-off act (tmux install, pick a binary) is in flight. */
let busy = false;
/** The setup chain is running. The poll must not stop for that. */
let running = false;
/** The chain's last answer when it stopped short; cleared by Try Again. */
let failure: ActionResult | null = null;
/** True once this page has asked for the dashboard. Never twice. */
let opened = false;
let problem = "";
let customizeOpen = false;
const form: FormValues = effectiveForm(undefined);
const explicit: ExplicitMap = {};
let seeded = false;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------
/** Inline SVGs (lucide outlines, 24-grid). Fixed strings, this file's own; the ONLY innerHTML on the page. */
const ART = {
  icon: `<img src="./app-icon.png" alt="" />`,
  terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 17 6-6-6-6M12 19h8"/></svg>`,
  server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg>`,
  fail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
};
function setFrame(art: keyof typeof ART, title: string, subtitle: string): void {
  el("art").innerHTML = ART[art];
  el("title").textContent = title;
  el("subtitle").textContent = subtitle;
}
function clear(...ids: string[]): void {
  for (const id of ids) el(id).textContent = "";
}
function button(label: string, handler: () => unknown, cls = "", disabled = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = cls;
  b.disabled = disabled || busy || running;
  b.addEventListener("click", handler);
  return b;
}
function text(tag: "p" | "span" | "div", s: string, cls = ""): HTMLElement {
  const n = document.createElement(tag);
  n.textContent = s;
  n.className = cls;
  return n;
}
function renderDots(): void {
  const d = el("dots");
  d.textContent = "";
  if (probe === null) return;
  const { total, done, current } = dots(probe, screen);
  const row = document.createElement("span");
  row.setAttribute("aria-hidden", "true");
  row.style.display = "contents";
  for (let i = 0; i < total; i += 1) {
    const dot = document.createElement("i");
    dot.className = i === current ? "current" : i < done ? "done" : "";
    row.append(dot);
  }
  d.append(row, text("span", `Step ${current + 1} of ${total}`, "sr-only"));
}
const here = (): string => (probe?.platform === "darwin" ? "this Mac" : "this machine");

// ---------------------------------------------------------------------------
// Screens. Each fills #content and the bar; ordering comes from screensFor.
// ---------------------------------------------------------------------------
function renderWelcome(): void {
  setFrame(
    "icon",
    "Welcome to Subshell",
    `Subshell runs agent sessions in terminal panes you can watch from any device. Let's set up the server on ${here()}.`,
  );
  el("bar-right").append(button("Continue", () => go(next()), "primary"));
}

function renderTmux(p: Probe): void {
  setFrame("terminal", "Install tmux", "Every subshell runs in a tmux pane, so the server needs it before it can start.");
  const content = el("content");
  const plan = tmuxInstallPlan(p.platform, p.hasBrew);
  if (prereqState(p) === "install" && plan.kind === "run") {
    if (busy) {
      content.append(text("p", "Installing tmux…", "assistant-subtitle"));
    } else {
      content.append(button(plan.label, () => void act(() => ipc.installTmux()), "primary big"));
      content.append(text("p", "Your package manager may ask for your password.", "hint"));
    }
  } else {
    const subject = here() === "this Mac" ? "This Mac" : "This machine";
    content.append(text("p", `${subject} has no package manager this app can drive. In a terminal:`, "hint"));
    if (plan.command.length > 0) content.append(text("span", plan.command.join(" "), "code-line"));
    if (plan.docsUrl !== "") content.append(button("Read the tmux docs", () => void ipc.openTmuxDocs().catch(setProblem), "ghost"));
  }
  el("bar-left").append(button("Back", () => go("welcome"), "ghost"));
  el("bar-right").append(text("span", "Waiting for tmux", "reason"), button("Continue", () => {}, "primary", true));
}

function renderSetup(p: Probe): void {
  if (running || p.next === "ready") return renderProgress(p);
  if (failure) return renderFailure(p);
  setFrame("server", "Set Up Your Server", `Here's what will happen on ${here()}.`);
  const content = el("content");
  content.append(planRows(p));
  const links = document.createElement("div");
  links.className = "mt-4 flex gap-4";
  links.append(
    button(
      customizeOpen ? "Use defaults" : "Customize port and addresses…",
      () => {
        customizeOpen = !customizeOpen;
        if (!customizeOpen) resetForm();
        render();
      },
      "linkish",
    ),
  );
  if (p.serverChoice === "no-bundled") links.append(button("Choose an existing server…", () => void pickBinary(), "linkish"));
  content.append(links);
  if (customizeOpen) content.append(addressForm(p));
  const gate = canSetup(p, busy);
  const list = screensFor(p);
  const prev = list[Math.max(0, list.indexOf("setup") - 1)] ?? "welcome";
  el("bar-left").append(button("Back", () => go(prev), "ghost"));
  if (!gate.ok && gate.reason) el("bar-right").append(text("span", gate.reason, "reason"));
  el("bar-right").append(button("Set Up", () => void startSetup(), "primary", !gate.ok));
}

/** The three what-will-happen rows. Re-rendered by the address form's input handler, never the inputs. */
function planRows(p: Probe): HTMLUListElement {
  const rows = setupRows(p, { port: form.port, host: form.host });
  const base = form.baseUrl || derivedBaseUrl(form.port || "3080");
  const ul = document.createElement("ul");
  ul.className = "plan-rows";
  ul.id = "plan-rows";
  for (const [label, detail] of [
    ["Install the server", rows.find((r) => r.id === "server")?.detail ?? ""],
    ["Start it in the background, and at every login", ""],
    ["Open your dashboard", base],
  ]) {
    const li = document.createElement("li");
    li.append(document.createElement("span"), text("span", label, "label"), text("span", detail, "detail"));
    ul.append(li);
  }
  return ul;
}

function renderProgress(p: Probe): void {
  if (p.next === "ready") {
    setFrame("server", "Setting Up Subshell…", "Opening your dashboard…");
    openWhenReady();
    return;
  }
  setFrame("server", "Setting Up Subshell…", "This takes a moment.");
  el("content").append(checklist(p, "active"));
}

function renderFailure(p: Probe): void {
  setFrame("fail", "Setup Couldn't Finish", "Nothing else was changed.");
  const content = el("content");
  content.append(checklist(p, "failed"));
  if (failure) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Show Details";
    const pre = document.createElement("pre");
    pre.className = "pane-pre output-bad";
    pre.textContent = [failure.stdout.trim(), failure.stderr.trim()].filter(Boolean).join("\n\n");
    details.append(summary, pre);
    content.append(details);
  }
  el("bar-left").append(button("Open Status Page", () => void ipc.openConsole().catch(setProblem), "ghost"));
  el("bar-right").append(button("Try Again", () => void startSetup(), "primary"));
}

/** The five-row checklist; the first not-done row takes `undoneState`. */
function checklist(p: Probe, undoneState: "active" | "failed"): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "checklist";
  const rows = setupRows(p, { port: form.port, host: form.host });
  const first = rows.find((r) => !r.done);
  for (const row of rows) {
    const li = document.createElement("li");
    li.dataset.state = row.done ? "done" : row === first ? undoneState : "pending";
    const glyph = text("span", row.done ? "✓" : row === first && undoneState === "failed" ? "✕" : "", "glyph");
    li.append(glyph, text("span", row.label, "label"), text("span", row.detail, "detail"));
    if (row === first && undoneState === "failed" && failure) li.append(text("div", failureLine(failure), "sub"));
    ul.append(li);
  }
  return ul;
}

function addressForm(p: Probe): HTMLElement {
  if (!seeded) {
    const s = effectiveForm(p.status?.settings);
    for (const { name } of CONFIG_FIELDS) form[name] = form[name] || s[name];
    for (const [name, on] of Object.entries(explicitFields(p.status?.settings)) as [keyof ExplicitMap, boolean][]) {
      if (on) explicit[name] = true;
    }
    seeded = true;
  }
  const grid = document.createElement("div");
  grid.className = "mt-4 grid w-full grid-cols-2 gap-2.5";
  for (const field of CONFIG_FIELDS) {
    const cell = document.createElement("div");
    if (field.wide) cell.className = "col-span-2";
    const label = document.createElement("label");
    label.htmlFor = `field-${field.name}`;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = `field-${field.name}`;
    input.value = form[field.name];
    input.placeholder = field.placeholder;
    input.spellcheck = false;
    input.autocapitalize = "off";
    if (field.numeric) input.inputMode = "numeric";
    input.addEventListener("input", () => {
      form[field.name] = input.value;
      explicit[field.name] = true;
      if (field.name === "port" && explicit.baseUrl !== true) {
        form.baseUrl = derivedBaseUrl(input.value);
        const mirror = document.getElementById("field-baseUrl") as HTMLInputElement | null;
        if (mirror) mirror.value = form.baseUrl;
      }
      // The plan rows follow the form; the inputs are left alone so typing is never interrupted.
      document.getElementById("plan-rows")?.replaceWith(planRows(p));
    });
    cell.append(label, input);
    if (field.hint) cell.append(text("p", field.hint, "hint"));
    for (const pe of fieldProblems(p.status?.settings, field.name)) cell.append(text("p", pe.reason, "hint warn-text"));
    grid.append(cell);
  }
  return grid;
}
function resetForm(): void {
  for (const { name } of CONFIG_FIELDS) {
    form[name] = "";
    delete explicit[name];
  }
  seeded = false;
}

// ---------------------------------------------------------------------------
// Navigation, actions, render, poll
// ---------------------------------------------------------------------------
function next(): ScreenId {
  if (probe === null) return screen;
  const list = screensFor(probe);
  return list[Math.min(list.length - 1, list.indexOf(screen) + 1)] ?? screen;
}
function go(to: ScreenId): void {
  screen = to;
  const s = el("screen");
  s.classList.remove("enter");
  void s.offsetWidth; // restart the animation
  s.classList.add("enter");
  render();
}

async function act(fn: () => Promise<ActionResult | null>): Promise<void> {
  if (busy || running) return;
  busy = true;
  problem = "";
  render();
  try {
    const r = await fn();
    if (r && !r.ok) problem = failureLine(r);
  } catch (err) {
    problem = errText(err);
  }
  await refresh().catch(setProblem);
  busy = false;
  render();
}

async function startSetup(): Promise<void> {
  if (busy || running || probe === null) return;
  running = true;
  failure = null;
  problem = "";
  render();
  let result: ActionResult | null = null;
  try {
    result = await ipc.setup(configPayload(form, explicit));
  } catch (err) {
    problem = errText(err);
  } finally {
    running = false;
  }
  if (result && !result.ok) failure = result;
  await refresh().catch(() => {});
  if (result?.ok) {
    // `service start` returns when the manager has spawned the process, not
    // when the port is bound: two more looks before deciding.
    for (let i = 0; i < 2 && probe?.next !== "ready"; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      await refresh().catch(() => {});
    }
  }
  render();
}

async function pickBinary(): Promise<void> {
  const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
  if (!chosen) return; // a cancel must not clear the stored choice
  await act(async () => {
    await ipc.setServerBin(chosen);
    return null;
  });
}

function openWhenReady(): void {
  if (opened || probe?.next !== "ready") return;
  opened = true;
  void ipc.openMain().catch((e: unknown) => {
    opened = false;
    setProblem(e);
  });
}
function setProblem(err: unknown): void {
  problem = errText(err);
  render();
}

function render(): void {
  el("problem").textContent = problem;
  clear("content", "bar-left", "bar-right");
  renderDots();
  if (probe === null) {
    setFrame("icon", "Welcome to Subshell", "Checking this machine…");
    return;
  }
  // A machine that became ready while any screen was up goes to the dashboard;
  // the tmux screen advances the moment the fact lands.
  if (probe.next === "ready" || (screen === "tmux" && probe.tmux !== null)) screen = "setup";
  const p = probe;
  const views: Record<ScreenId, () => void> = {
    welcome: renderWelcome,
    tmux: () => renderTmux(p),
    setup: () => renderSetup(p),
  };
  views[screen]();
}

async function refresh(): Promise<void> {
  probe = await ipc.probe();
  problem = probe.error ?? problem;
}
async function tick(): Promise<void> {
  if ((busy || document.hidden) && !running) return;
  // Never redraw under a hand typing in the address form.
  if (document.activeElement instanceof HTMLInputElement) return;
  try {
    await refresh();
  } catch {
    return;
  }
  render();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
  const primary = el("bar-right").querySelector<HTMLButtonElement>("button.primary");
  if (primary && !primary.disabled) primary.click();
});

void (async () => {
  try {
    await refresh();
    if (probe) screen = screensFor(probe)[0] ?? "welcome";
  } catch (err) {
    problem = errText(err);
  }
  render();
  setInterval(() => void tick(), POLL_MS);
})();
```

Note for the executor: `ART` is the page's only `innerHTML` and holds fixed strings from this file, never data from outside it. Keep it that way, and say so in the comment (the CSP forbids inline scripts; a reviewer will ask).

- [ ] **Step 5: `wizard.json`**

Remove `"allow-desktop-install-agent",` and set the description to `"The setup assistant window. It may probe the machine, run the setup chain, install tmux, pick a server binary, read the tmux docs, and open the dashboard or the console - and nothing else. Pinned equal to what wizard.ts actually invokes by ui/src/__tests__/ipc-acl.test.ts."`

- [ ] **Step 6: Verify**

```bash
cd apps/server/desktop && bun run build && bun run test && bun run verify-types
cd ../../.. && bun run lint:check
```

`ipc-acl.test.ts` must pass: the wizard's invoked set equals its grants. Then run the app as in Task 2 and walk: Welcome → (tmux) → Set Up → Setting Up → dashboard in the same place. Check Enter advances, Back works, Customize expands without the poll eating keystrokes, and a forced failure (rename tmux away mid-chain) shows the failure screen with Show Details and Try Again.

- [ ] **Step 7: Commit**

```bash
git add apps/server/desktop/ui apps/server/desktop/src-tauri/capabilities/wizard.json
git commit -m "feat(desktop-server): first run is a setup assistant"
```

### Task 4: Docs and changeset for phase 1

**Files:**
- Modify: `apps/server/desktop/AGENTS.md` ("The first-run wizard" → "The setup assistant"; the wizard row of the IPC table)
- Modify: `README.md:71-80`
- Modify: `docs/superpowers/specs/2026-09-10-desktop-first-run-wizard-and-reset-design.md` (status line)
- Create: `.changeset/setup-assistant.md`

- [ ] **Step 1: AGENTS.md section**

```markdown
## The setup assistant

Three screens in one fixed frame (spec 2026-09-11, which superseded the
six-step wizard of 2026-09-10 § 5): Welcome, Install tmux (shown only while
tmux is missing, and it advances itself the moment the poll sees one), and
Set Up Your Server, whose press replaces the screen with a progress
checklist and then opens the dashboard by itself. `screensFor(probe)` decides
which screens exist, `dots(probe, screen)` where the three dots stand,
`setupRows`/`canSetup`/`failureLine` the checklist, the gate and the failure
line, all in `ui/src/lib/wizard-state.ts`, pure and tested without a
webview. There is no rail, no Done screen and no log pane: a failed chain
shows the CLI's last stderr line under the failed row and the verbatim
output behind a collapsed Show Details. Agents are not asked about here; the
SPA's `/setup` owns that question, because detection lives in the server.
The window is 1024×720 and not resizable, and `open_main` takes its position
and size when the dashboard is created, so the swap reads as one window
changing screen; the SPA continues the dot row (six dots, three filled) when
it sees the desktop UA marker.
```

Update the IPC table's wizard row to: `probe, setup, install tmux, set the binary, open tmux docs, open main, open the console, and the dialog plugin's open`.

- [ ] **Step 2: README** — replace the "On a machine with nothing installed…" sentence through "…stopping at the first failure and saying so." with:

```markdown
On a machine with nothing installed, Subshell Server opens a setup
assistant: Welcome, Install tmux if it is missing (one button where your
package manager allows it), and Set Up Your Server, one press that installs
the bundled `subshell-server` to `~/.local/bin`, writes a `config.env`,
registers the service (systemd user unit or launchd agent) and starts it,
with port and addresses behind "Customize". The dashboard then opens in the
same window and carries on: your account, agents, and your first subshell.
```

- [ ] **Step 3: Status line** on the 2026-09-10 spec after `Status:`: `Superseded in part: § 5 (the six-step wizard) by 2026-09-11-first-run-second-pass-design.md. § 3, § 4, § 6, § 7 stand.`

- [ ] **Step 4: Changeset**

```markdown
---
"@internal/desktop-server": minor
---

First run is a setup assistant: Welcome, Install tmux (only when missing), and one "Set Up" press with a progress checklist, in a fixed window the dashboard then takes over in place. The six-step wizard, its Agents step (which could not detect anything) and its log pane are gone; the dashboard's own setup wizard asks about agents.
```

- [ ] **Step 5: Commit** — `git add apps/server/desktop/AGENTS.md README.md docs/superpowers/specs/2026-09-10-desktop-first-run-wizard-and-reset-design.md .changeset/setup-assistant.md && git commit -m "docs(desktop-server): the setup assistant"`

---

## Phase 2 — The SPA assistant

### Task 5: `type` rides the harness wire shape

**Files:**
- Modify: `packages/pane-runtime/src/types.ts` (`HarnessPlugin` gains `type: PluginType`)
- Modify: `packages/pane-runtime/src/plugin-adapter.ts` (`type: manifest.type,` after `name`)
- Modify: `apps/server/api/src/api/models.ts` (`HarnessInfoSchema`)
- Modify: `apps/server/api/src/api/harness-utils.ts` (`harnessInfo` adds `type: h.type`)
- Modify: `apps/server/web/src/types/harness.ts`
- Test: `apps/server/api/src/api/__tests__/setup-route.test.ts`

- [ ] **Step 1: Failing test** — add to the existing describe:

```ts
  it("reports each harness's plugin type, so a wizard can list agents apart from the terminal", async () => {
    setHasUsersProbeForTests(async () => false);
    const res = await anonymousGet("/api/setup/harnesses");
    const rows = (await res.json()) as { id: string; type: string }[];
    expect(rows.find((r) => r.id === "terminal")?.type).toBe("terminal");
    expect(rows.find((r) => r.id === "claude-code")?.type).toBe("agent-harness");
    setHasUsersProbeForTests(null);
  });
```

Run: `cd apps/server/api && bun test src/api/__tests__/setup-route.test.ts` — FAIL.

- [ ] **Step 2: Implement**

`types.ts`: import `PluginType` from `@subshell-ai/plugin-api` beside the other type imports; after `name` add `/** The manifest's plugin type: what kind of thing this drives. Groups and labels; the launch pipeline never branches on it. */ type: PluginType;`.
`plugin-adapter.ts`: `type: manifest.type,`.
`models.ts`, in `HarnessInfoSchema` after `name`: `type: t.Union([t.Literal("agent-harness"), t.Literal("terminal")], { description: "Plugin type from the manifest: an agent CLI, or a plain shell" }),`.
`harness-utils.ts`: `type: h.type,`.
`types/harness.ts`: `/** Manifest plugin type: an agent CLI or a plain shell */ type: "agent-harness" | "terminal";`.
Fix every `HarnessInfo`/`HarnessPlugin` literal in tests (`grep -rln 'binaryName:\|envOverride: "' apps packages --include='*.test.ts' --include='*.test.tsx'`) by adding `type: "agent-harness"`.

- [ ] **Step 3: Verify, commit**

```bash
turbo build --filter=@internal/pane-runtime --filter=@internal/server --filter=@internal/backend-client
bun run verify-types && bun run lint:check && bun run test
git add -A packages/pane-runtime apps/server/api apps/server/web/src
git commit -m "feat(server): harness rows carry their plugin type"
```

### Task 6: `SetupAssistant` and `StepDots`

**Files:**
- Create: `apps/server/web/src/components/setup/step-dots.tsx`
- Create: `apps/server/web/src/components/setup/setup-assistant.tsx`
- Create: `apps/server/web/src/components/__tests__/step-dots.test.tsx`
- Create: `apps/server/web/src/components/__tests__/setup-assistant.test.tsx`
- Modify (if needed): `apps/server/web/src/components/ui/button.tsx` (a `ghost` variant)

**Interfaces:**
- `StepDots({ total, done, current }: { total: number; done: number; current: number })`
- `SetupAssistant(props: SetupAssistantProps)`:

```ts
export interface SetupAssistantProps {
  /** 96px art: a lucide icon element or an <img>. */
  illustration: ReactNode;
  title: string;
  subtitle?: string;
  dots: { total: number; done: number; current: number };
  /** Ghost button, left. Absent = hidden. */
  back?: { label?: string; onClick: () => void };
  /** Ghost button left of the primary. */
  skip?: { label: string; onClick: () => void; disabled?: boolean };
  primary: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean; pendingLabel?: string };
  /** Muted text left of the primary (a disabled reason). */
  reason?: string;
  children?: ReactNode;
}
```

- [ ] **Step 1: Failing tests**

`step-dots.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { StepDots } from "@/components/setup/step-dots";

afterEach(cleanup);

describe("StepDots", () => {
  it("draws total dots, marks the current, and names the step for screen readers", () => {
    render(<StepDots total={6} done={3} current={3} />);
    const dots = document.querySelectorAll("[data-dot]");
    expect(dots).toHaveLength(6);
    expect(dots[3]?.getAttribute("data-dot")).toBe("current");
    expect(dots[0]?.getAttribute("data-dot")).toBe("done");
    expect(dots[5]?.getAttribute("data-dot")).toBe("upcoming");
    expect(screen.getByText("Step 4 of 6")).toBeTruthy();
  });
  it("is not navigation", () => {
    render(<StepDots total={3} done={0} current={0} />);
    expect(document.querySelectorAll("button, a")).toHaveLength(0);
  });
});
```

`setup-assistant.test.tsx`:

```tsx
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetupAssistant } from "@/components/setup/setup-assistant";

afterEach(cleanup);
const dots = { total: 3, done: 0, current: 0 };

describe("SetupAssistant", () => {
  it("renders title, subtitle, and the primary with its label", () => {
    render(
      <SetupAssistant illustration={<span />} title="Create Your Account" subtitle="Admin." dots={dots} primary={{ label: "Create Account", onClick: () => {} }} />,
    );
    expect(screen.getByRole("heading", { name: "Create Your Account" })).toBeTruthy();
    expect(screen.getByText("Admin.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
  it("shows Back and Skip when given, and a pending label while pending", () => {
    render(
      <SetupAssistant illustration={<span />} title="T" dots={dots} back={{ onClick: () => {} }} skip={{ label: "Skip", onClick: () => {} }}
        primary={{ label: "Start", onClick: () => {}, pending: true, pendingLabel: "Starting…" }} />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });
  it("Enter activates an enabled primary, not a disabled one", () => {
    const onClick = mock(() => {});
    const { rerender } = render(<SetupAssistant illustration={<span />} title="T" dots={dots} primary={{ label: "Continue", onClick }} />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<SetupAssistant illustration={<span />} title="T" dots={dots} primary={{ label: "Continue", onClick, disabled: true }} />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("shows the reason beside a disabled primary", () => {
    render(<SetupAssistant illustration={<span />} title="T" dots={dots} reason="Waiting for tmux" primary={{ label: "Set Up", onClick: () => {}, disabled: true }} />);
    expect(screen.getByText("Waiting for tmux")).toBeTruthy();
  });
});
```

Run both: FAIL (modules missing).

- [ ] **Step 2: Implement `StepDots`**

```tsx
import { cn } from "@/lib/utils";

/**
 * The assistant's progress: dots, not steps. Not interactive on purpose (the
 * old text rail read as breadcrumbs people tried to click); the step is
 * named for screen readers beside them.
 */
export function StepDots({ total, done, current }: { total: number; done: number; current: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="flex items-center gap-2.5">
        {Array.from({ length: total }, (_, i) => {
          const state = i === current ? "current" : i < done ? "done" : "upcoming";
          return (
            <i
              key={i}
              data-dot={state}
              className={cn(
                "block rounded-full",
                state === "current" ? "size-2.5 bg-primary" : "size-2",
                state === "done" && "bg-primary",
                state === "upcoming" && "bg-border",
              )}
            />
          );
        })}
      </span>
      <span className="sr-only">
        Step {current + 1} of {total}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Implement `SetupAssistant`**

```tsx
import { type ReactNode, useEffect } from "react";
import { StepDots } from "@/components/setup/step-dots";
import { Button } from "@/components/ui/button";

export interface SetupAssistantProps {
  illustration: ReactNode;
  title: string;
  subtitle?: string;
  dots: { total: number; done: number; current: number };
  back?: { label?: string; onClick: () => void };
  skip?: { label: string; onClick: () => void; disabled?: boolean };
  primary: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean; pendingLabel?: string };
  reason?: string;
  children?: ReactNode;
}

/**
 * The setup assistant's frame (spec 2026-09-11 § 3): a centered 560px column
 * under 96px of art, and a 72px bar with Back left, dots center, Continue
 * right. Every /setup screen renders inside it; the native app renders the
 * same frame in its own page, so the two read as one program.
 */
export function SetupAssistant({ illustration, title, subtitle, dots, back, skip, primary, reason, children }: SetupAssistantProps) {
  const primaryDisabled = primary.disabled || primary.pending;
  useEffect(() => {
    // Enter is Continue, unless the person is in a textarea, on a button, or the primary is disabled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || primaryDisabled) return;
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      primary.onClick();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [primary, primaryDisabled]);

  return (
    <div className="grid h-dvh grid-rows-[1fr_72px] bg-background text-foreground">
      <main className="assistant-enter flex flex-col items-center overflow-auto px-8 pt-24 pb-6">
        <div aria-hidden className="mb-7 flex size-24 items-center justify-center text-primary/55 [&_img]:size-24 [&_svg]:size-[72px]">
          {illustration}
        </div>
        <h1 className="text-center text-[30px] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-2 max-w-[560px] text-center text-[15px] leading-relaxed text-muted-foreground">{subtitle}</p>}
        {children && <section className="mt-9 w-full max-w-[560px]">{children}</section>}
      </main>
      <footer className="grid grid-cols-[1fr_auto_1fr] items-center border-t px-8">
        <div className="flex gap-2">
          {back && (
            <Button variant="ghost" onClick={back.onClick}>
              {back.label ?? "Back"}
            </Button>
          )}
        </div>
        <StepDots {...dots} />
        <div className="flex items-center justify-end gap-3">
          {reason && primaryDisabled && <span className="text-[13px] text-muted-foreground">{reason}</span>}
          {skip && (
            <Button variant="ghost" onClick={skip.onClick} disabled={skip.disabled}>
              {skip.label}
            </Button>
          )}
          <Button className="min-w-[120px]" onClick={primary.onClick} disabled={primaryDisabled}>
            {primary.pending ? (primary.pendingLabel ?? primary.label) : primary.label}
          </Button>
        </div>
      </footer>
    </div>
  );
}
```

Add to `apps/server/web/src/styles.css`:

```css
@media (prefers-reduced-motion: no-preference) {
  .assistant-enter { animation: assistant-in 220ms ease-out; }
}
@keyframes assistant-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
```

If `Button` has no `ghost` variant, add one to its `cva` map: `ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground"`.

- [ ] **Step 4: Run, commit**

```bash
cd apps/server/web && bun test src/components/__tests__/step-dots.test.tsx src/components/__tests__/setup-assistant.test.tsx
git add apps/server/web/src/components/setup apps/server/web/src/components/__tests__/step-dots.test.tsx apps/server/web/src/components/__tests__/setup-assistant.test.tsx apps/server/web/src/components/ui/button.tsx apps/server/web/src/styles.css
git commit -m "feat(server): the setup assistant frame and its dots"
```

### Task 7: `AgentRow`, and `/setup` rebuilt on the frame

**Files:**
- Create: `apps/server/web/src/components/setup/agent-row.tsx`
- Create: `apps/server/web/src/components/__tests__/agent-row.test.tsx`
- Modify: `apps/server/web/src/components/harness-install-help.tsx` (drop `onRecheck`/`rechecking` props and both Re-check buttons)
- Modify: `apps/server/web/src/components/__tests__/harness-install-help.test.tsx` (drop `onRecheck` from renders)
- Modify: `apps/server/web/src/hooks/use-harnesses.ts` (`useHarnesses(options?)`)
- Modify: `apps/server/web/src/routes/setup.tsx` (rewrite the JSX on `SetupAssistant`; keep the data flow)
- Modify: `apps/server/web/src/routes/__tests__/setup.test.tsx`
- Delete: `apps/server/web/src/components/harness-row.tsx`, `apps/server/web/src/components/__tests__/harness-row.test.tsx`, `apps/server/web/src/hooks/use-harness-toggles.ts` (re-grep for callers first)
- Modify: `e2e/tests/01-setup-wizard.spec.ts`, `e2e/tests/15-onboarding-clean-machine.spec.ts`

**Interfaces:** `AgentRow({ harness: HarnessInfo; onInstall?: (id: string) => void; installing?: boolean })`; `useHarnesses(options?: { refetchInterval?: number })`.

- [ ] **Step 1: Failing `AgentRow` tests**

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentRow } from "@/components/setup/agent-row";
import type { HarnessInfo } from "@/types/harness";

afterEach(cleanup);
const base: HarnessInfo = {
  id: "claude-code", type: "agent-harness", name: "Claude Code", binary: "claude", envOverride: "CLAUDE_PATH",
  description: "Anthropic's coding agent", icon: "🤖", installed: false, reason: "not-on-path", installedHere: true,
  install: { command: "curl -fsSL https://claude.ai/install.sh | bash", docsUrl: "https://code.claude.com/docs/en/setup" },
};

describe("AgentRow", () => {
  it("is a list item named by the agent, with Detected and the version when found", () => {
    render(<ul><AgentRow harness={{ ...base, installed: true, version: "1.2.3", reason: undefined }} /></ul>);
    const row = screen.getByRole("listitem", { name: "Claude Code" });
    expect(row.textContent).toContain("Detected");
    expect(row.textContent).toContain("v1.2.3");
    expect(row.querySelector("[role=switch], input[type=checkbox]")).toBeNull();
  });
  it("collapses install help until asked for", () => {
    render(<ul><AgentRow harness={base} /></ul>);
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.queryByText(base.install.command)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /How to install/ }));
    expect(screen.getByText(base.install.command)).toBeTruthy();
  });
  it("names the override variable when it is the problem", () => {
    render(<ul><AgentRow harness={{ ...base, reason: "override-invalid" }} /></ul>);
    expect(screen.getByText("Check CLAUDE_PATH")).toBeTruthy();
  });
  it("offers Install only with a handler, and says Installing while it runs", () => {
    const { rerender } = render(<ul><AgentRow harness={base} /></ul>);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    rerender(<ul><AgentRow harness={base} onInstall={() => {}} installing /></ul>);
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Implement `AgentRow`**

```tsx
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { HarnessInstallHelp } from "@/components/harness-install-help";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HarnessInfo } from "@/types/harness";

/**
 * One agent on the Add an Agent screen (spec 2026-09-11 § 6.2): name, a
 * detection chip, and when not found an Install button (where installing
 * from here exists) plus a collapsed How to install. No switch, no
 * description, no timestamp: first run asks what is here, not plugin
 * management, which lives in Settings → Plugins.
 */
export function AgentRow({
  harness,
  onInstall,
  installing = false,
}: {
  harness: HarnessInfo;
  onInstall?: (id: string) => void;
  installing?: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const chip = chipFor(harness);
  return (
    <li aria-label={harness.name} className="border-border/60 border-b last:border-b-0">
      <div className="flex min-h-11 items-center gap-3 py-2">
        <span aria-hidden className="text-lg">{harness.icon ?? "🤖"}</span>
        <span className="flex-1 font-medium">{harness.name}</span>
        <span className={cn("text-xs", chip.className)}>{chip.text}</span>
        {!harness.installed && onInstall && (
          <Button size="sm" disabled={installing} onClick={() => onInstall(harness.id)}>
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
        {!harness.installed && (
          <Button variant="ghost" size="sm" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)}>
            How to install
            <ChevronDown aria-hidden className={cn("ml-1 size-3.5 transition-transform", helpOpen && "rotate-180")} />
          </Button>
        )}
      </div>
      {helpOpen && !harness.installed && (
        <div className="pb-3 pl-9">
          <HarnessInstallHelp harness={harness} />
        </div>
      )}
    </li>
  );
}

function chipFor(h: HarnessInfo): { text: string; className: string } {
  if (h.installed) return { text: h.version ? `Detected · v${h.version}` : "Detected", className: "text-success" };
  if (h.reason === "override-invalid" && h.envOverride) return { text: `Check ${h.envOverride}`, className: "text-warning" };
  return { text: "Not found", className: "text-muted-foreground" };
}
```

- [ ] **Step 3: Trim `HarnessInstallHelp`** — remove `onRecheck`, `rechecking`, both Re-check buttons; fix its test's renders. Its two assertions still hold.

- [ ] **Step 4: `useHarnesses` gains `refetchInterval`**

```ts
export function useHarnesses(options: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: HARNESS_QUERY_KEY,
    queryFn: () => apiFetch<HarnessInfo[]>("/api/setup/harnesses"),
    // The Add an Agent screen passes ~4 s so an install made in a terminal
    // shows up without a control; every other caller omits it.
    refetchInterval: options.refetchInterval,
  });
}
```

- [ ] **Step 5: Rebuild `setup.tsx`'s JSX**

Keep every hook and handler (`register`, `launch`, `finish`, `completeSetup`, `launchedRef`, the `needsSetup` effect, `if (!status) return null;`). Replace the imports of `Card*`, `HarnessRow`, `useHarnessToggles`, `useRecheckHarnesses` with `SetupAssistant`, `AgentRow`, `desktopPlatform`, `isDesktop` (from `@/lib/desktop`) and `Bot, KeyRound, Rocket` from `lucide-react`. Add near the top of the component:

```tsx
// In the desktop shell the native assistant already showed three screens; the
// dot row continues from there so the two programs read as one (spec § 4).
const NATIVE_STEPS = isDesktop() ? 3 : 0;
const dotsFor = (step: number) => ({ total: STEPS.length + NATIVE_STEPS, done: NATIVE_STEPS + step, current: NATIVE_STEPS + step });
const here = desktopPlatform() === "macos" ? "this Mac" : "this machine";
const { data: harnesses, isLoading: harnessesLoading, isError: harnessesError, refetch: refetchHarnesses } =
  useHarnesses({ refetchInterval: step === 1 ? 4000 : undefined });
const agents = (harnesses ?? []).filter((h) => h.type === "agent-harness");
```

Then the three screens replace everything from `<main …>` down:

```tsx
if (step === 0) {
  return (
    <SetupAssistant
      illustration={<KeyRound />}
      title="Create Your Account"
      subtitle={isDesktop() ? `Subshell Server is running on ${here}. This is its admin account.` : "This is the admin account for your Subshell server."}
      dots={dotsFor(0)}
      primary={{
        label: "Create Account",
        onClick: () => void register(),
        disabled: busy || !name || !email || password.length < 8 || confirmPassword !== password,
        pending: busy,
        pendingLabel: "Creating account…",
      }}
    >
      <form className="mx-auto grid w-[360px] gap-3" onSubmit={(e) => { e.preventDefault(); void register(); }}>
        {/* The existing Name / Email / Password / Confirm fields, unchanged, with autoFocus on Name. */}
        {confirmTouched && confirmPassword !== password && <p className="text-destructive text-sm">Passwords do not match</p>}
        {regError && <p className="text-destructive text-sm">{regError}</p>}
      </form>
    </SetupAssistant>
  );
}
if (step === 1) {
  return (
    <SetupAssistant
      illustration={<Bot />}
      title="Add an Agent"
      subtitle="A plain terminal is always available with nothing to install. Add an agent CLI now, or later in Settings."
      dots={dotsFor(1)}
      primary={{ label: "Continue", onClick: () => setStep(2), disabled: busy }}
    >
      {harnessesLoading && <p className="text-muted-foreground text-sm">Checking {here}…</p>}
      {harnessesError && (
        <ErrorBanner
          message="Couldn't check for agents."
          className="rounded-md border"
          action={
            <Button variant="link" size="sm" className="h-auto p-0 text-inherit text-xs underline" onClick={() => void refetchHarnesses()}>
              Retry
            </Button>
          }
        />
      )}
      <ul>{agents.map((h) => <AgentRow key={h.id} harness={h} />)}</ul>
      {harnesses !== undefined && !agents.some((h) => h.installed) && (
        <p className="mt-4 text-muted-foreground text-sm">
          Nothing on {here}? <Link to="/nodes" className="underline">…or register a Node →</Link>
        </p>
      )}
    </SetupAssistant>
  );
}
return (
  <SetupAssistant
    illustration={<Rocket />}
    title="Start Your First Subshell"
    subtitle="Everything below is already filled in. Change anything you like."
    dots={dotsFor(2)}
    skip={{ label: "Skip", onClick: finish, disabled: create.isPending }}
    primary={{ label: "Start", onClick: () => void launch(), disabled: create.isPending || !canSubmit(launchForm), pending: create.isPending, pendingLabel: "Starting…" }}
  >
    <NewSubshellForm value={launchForm} onChange={setLaunchForm} ids={{ profile: "setup-profile", workingDir: "setup-working-dir", name: "setup-subshell-name", node: "setup-node" }} />
    {create.error && <p className="mt-3 text-destructive text-sm">{createSubshellErrorMessage(create.error, "Failed to start the subshell")}</p>}
  </SetupAssistant>
);
```

The `<main className="flex min-h-dvh …">` wrapper, the `<Card>` and the `Step {step + 1} of {STEPS.length}` caption go (the dots carry it).

- [ ] **Step 6: Delete `HarnessRow` and its hook**

```bash
cd apps/server/web && grep -rn 'HarnessRow\|useHarnessToggles\|useRecheckHarnesses\|useSetHarnessInstalled' src --include='*.ts' --include='*.tsx'
```

Delete `harness-row.tsx`, its test, `use-harness-toggles.ts`. Delete `useRecheckHarnesses`/`useSetHarnessInstalled` from `use-harnesses.ts` only if the grep shows no other callers (Settings → Plugins uses `use-instance-plugins.ts`).

- [ ] **Step 7: Update `setup.test.tsx`**

Labels: "Create admin account" → "Create Account"; "Start my first subshell" → "Start"; "Skip for now" → "Skip". Step 2: assert the subtitle text `A plain terminal is always available`; a detected fixture renders `Detected · v1.0.0`; a `type: "terminal"` fixture is NOT a `listitem`; the Node escape hatch renders when nothing is detected. Add one test that under a desktop UA (`Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 SubshellDesktop/1.0.0 (macos; p=1)", configurable: true })`, with `resetDesktopShellForTests()` before and after) the sr-only text on step 1 reads `Step 5 of 6`, and under the default UA `Step 2 of 3`.

- [ ] **Step 8: e2e**

`01-setup-wizard.spec.ts`: `"Create admin account"` → `"Create Account"` (both occurrences); the step-2 block →

```ts
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add an Agent" })).toBeVisible();
  const piRow = page.getByRole("listitem", { name: "pi", exact: true });
  await expect(piRow).toBeVisible();
  await expect(piRow.getByText(/Detected/)).toBeVisible();
```

`"Start my first subshell"` → `"Start"`; `"Skip for now"` → `"Skip"`. If Playwright does not treat the `sr-only` span as visible, assert `page.locator('[data-dot="current"]')` instead and drop the text check.

`15-onboarding-clean-machine.spec.ts`, the step-2 block →

```ts
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Add an Agent" })).toBeVisible();
  await expect(page.getByText(/A plain terminal is always available/)).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Terminal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("listitem", { name: "pi", exact: true }).getByText(/Detected/)).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();
```

and further down `"Start my first subshell"` → `"Start"`, `"Skip for now"` → `"Skip"`.

- [ ] **Step 9: Verify**

```bash
cd apps/server/web && bun test && bun run verify-types
cd ../../.. && bun run lint:check && bun run test:e2e -- tests/01-setup-wizard.spec.ts tests/15-onboarding-clean-machine.spec.ts
```

Then `bun run dev` in `apps/server/web` against a fresh test DB (never the live `:3080`) and walk the three screens against spec § 3.1: art, title, subtitle, bar positions, dots, Enter.

- [ ] **Step 10: Commit**

```bash
git add -A apps/server/web e2e/tests
git commit -m "feat(server): the setup wizard becomes a setup assistant"
```

### Task 8: Changeset for phase 2

- [ ] Create `.changeset/setup-assistant-web.md`:

```markdown
---
"@internal/server": minor
---

The setup wizard is a setup assistant: full-window screens with one decision each, dots instead of a step rail (continuing the desktop app's three when opened from it), and an Add an Agent screen that leads with what is detected, with install help collapsed until asked for and no plugin switches. Harness rows carry their plugin `type`.
```

- [ ] `git add .changeset && git commit -m "chore: changeset for the setup assistant"`

---

## Phase 3 — The control plane installs agent CLIs (approve separately; spec § 7)

### Task 9: `agent-install.service.ts`

**Files:**
- Create: `apps/server/api/src/services/agent-install.service.ts`
- Create: `apps/server/api/src/services/__tests__/agent-install.service.test.ts`
- Modify (if needed): `packages/pane-runtime/src/index.ts` (export `loginPathEntries`)

**Interfaces:** `installBuiltInAgent(id: string, deps?: AgentInstallDeps): Promise<AgentInstallResult>`; `AgentInstallRefused` (`status` 400 | 409); `AgentInstallResult = { ok; exitCode; output; durationMs }`; `AgentInstallDeps = { commandFor(id): Promise<string | undefined>; timeoutMs; extraPath(): Promise<string[]> }`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "bun:test";
import { AgentInstallRefused, installBuiltInAgent } from "@/services/agent-install.service.js";

function deps(command: string | undefined, timeoutMs = 5_000) {
  return { commandFor: async (_id: string) => command, timeoutMs, extraPath: async () => [] };
}

describe("installBuiltInAgent", () => {
  it("runs the command and returns its words", async () => {
    const r = await installBuiltInAgent("claude-code", deps("echo installed; echo warn >&2"));
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("installed");
    expect(r.output).toContain("warn");
  });
  it("reports a failing installer as ok:false with its exit code", async () => {
    const r = await installBuiltInAgent("claude-code", deps("echo nope >&2; exit 3"));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("nope");
  });
  it("kills an installer that outlives the timeout", async () => {
    const r = await installBuiltInAgent("claude-code", deps("sleep 30", 300));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
  });
  it("refuses an id with no install command as 400", async () => {
    await expect(installBuiltInAgent("terminal", deps(""))).rejects.toBeInstanceOf(AgentInstallRefused);
    await expect(installBuiltInAgent("terminal", deps(""))).rejects.toMatchObject({ status: 400 });
  });
  it("refuses an unknown id as 400", async () => {
    await expect(installBuiltInAgent("nope", deps(undefined))).rejects.toMatchObject({ status: 400 });
  });
  it("refuses a second install of the same id while one runs, as 409", async () => {
    const first = installBuiltInAgent("codex", deps("sleep 0.5"));
    await expect(installBuiltInAgent("codex", deps("echo x"))).rejects.toMatchObject({ status: 409 });
    await first;
  });
  it("caps runaway output", async () => {
    const r = await installBuiltInAgent("pi", deps("head -c 200000 /dev/zero | tr '\\0' a"));
    expect(r.output.length).toBeLessThan(70_000);
    expect(r.output).toContain("[truncated]");
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { builtInIds, getHarness, loginPathEntries } from "@internal/pane-runtime";

/** What one install run produced. `ok:false` is a result, not an error: the installer ran and said no. */
export interface AgentInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** stdout then stderr, each capped at OUTPUT_CAP bytes. */
  output: string;
  durationMs: number;
}

/** A refusal BEFORE anything ran: unknown id, no command, or one already running. */
export class AgentInstallRefused extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409) {
    super(message);
    this.name = "AgentInstallRefused";
    this.status = status;
  }
}

/** Test seams. Production callers pass nothing. */
export interface AgentInstallDeps {
  /** The install command for a BUILT-IN id, or undefined for an id this build does not carry. */
  commandFor: (id: string) => Promise<string | undefined>;
  timeoutMs: number;
  /** Directories to append to PATH: a service-run server carries only its baked PATH. */
  extraPath: () => Promise<string[]>;
}

const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const defaultDeps: AgentInstallDeps = {
  commandFor: async (id) => ((await builtInIds()).includes(id) ? getHarness(id)?.installHint.command : undefined),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  extraPath: loginPathEntries,
};

/** One install per id at a time, instance-wide: the target is one filesystem. */
const inFlight = new Set<string>();

/**
 * Run a built-in agent CLI's official installer on this host, as this
 * process's user (spec 2026-09-11 § 7). The command comes from the manifest
 * compiled into this binary; the id is the only input. No TTY: an installer
 * that prompts hangs to the timeout, the same exposure the desktop button
 * had. Output is captured, capped and returned; never logged.
 */
export async function installBuiltInAgent(id: string, deps: AgentInstallDeps = defaultDeps): Promise<AgentInstallResult> {
  const command = await deps.commandFor(id);
  if (command === undefined) throw new AgentInstallRefused(`"${id}" is not a plugin this build carries`, 400);
  if (command.trim() === "") throw new AgentInstallRefused(`"${id}" has nothing to install`, 400);
  if (inFlight.has(id)) throw new AgentInstallRefused(`"${id}" is already being installed`, 409);
  inFlight.add(id);
  const started = Date.now();
  try {
    const path = [...(process.env.PATH ?? "").split(":"), ...(await deps.extraPath())].filter(Boolean);
    const proc = Bun.spawn(["sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: [...new Set(path)].join(":") },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, deps.timeoutMs);
    const [stdout, stderr] = await Promise.all([cap(proc.stdout), cap(proc.stderr)]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const output = [stdout, stderr, timedOut ? `[installer timed out after ${deps.timeoutMs} ms]` : ""]
      .filter(Boolean)
      .join("\n");
    return { ok: exitCode === 0 && !timedOut, exitCode, output, durationMs: Date.now() - started };
  } finally {
    inFlight.delete(id);
  }
}

/** Read a stream to a string, stopping at the cap with a marker. */
async function cap(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size >= OUTPUT_CAP) continue; // keep draining so the child never blocks on a full pipe
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, OUTPUT_CAP);
  return size > OUTPUT_CAP ? `${text}\n[truncated]` : text;
}
```

If `loginPathEntries` is not exported from `@internal/pane-runtime`'s index, export it there — it is a pure, cached function already used by `binary-lookup.ts`.

- [ ] **Step 3: Run (PASS), commit**

```bash
git add apps/server/api/src/services/agent-install.service.ts apps/server/api/src/services/__tests__/agent-install.service.test.ts packages/pane-runtime/src/index.ts
git commit -m "feat(server): a service that runs a built-in agent CLI's installer"
```

### Task 10: The route

**Files:**
- Create: `apps/server/api/src/api/setup-agent-install.route.ts`
- Modify: `apps/server/api/src/api/setup.route.ts` (`export async function resolveSetupActor`)
- Modify: `apps/server/api/src/api/routes.ts` (register beside `setupRoutes`)
- Modify: `apps/server/api/src/api/models.ts` (`AgentInstallResultSchema`)
- Create: `apps/server/api/src/api/__tests__/setup-agent-install.route.test.ts`

- [ ] **Step 1: Failing route tests** — model on `setup-route.test.ts` (copy its `beforeAll` fixtures: admin cookie, plain-user cookie, a subshell bearer key). Cases, each written in full: 401 with no credential even while `setHasUsersProbeForTests(async () => false)`; 403 for the plain-user cookie; 403 for the bearer key; 400 for id `nope`; 400 for `terminal`; 200 for the admin with `setAgentInstallDepsForTests({ commandFor: async () => "echo ok", timeoutMs: 5000, extraPath: async () => [] })` asserting `body.ok === true`, `body.output` contains `ok`, `body.harness.id === "claude-code"`.

- [ ] **Step 2: Implement**

`models.ts`:

```ts
export const AgentInstallResultSchema = t.Object({
  ok: t.Boolean({ description: "Whether the installer exited 0 within the time limit" }),
  exitCode: t.Nullable(t.Number({ description: "The installer's exit code; null when it was killed" })),
  output: t.String({ description: "The installer's stdout then stderr, each capped at 64 KiB" }),
  harness: HarnessInfoSchema,
});
```

`setup-agent-install.route.ts`:

```ts
import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { ForbiddenError } from "@/api/auth-guard.js";
import { harnessInfo } from "@/api/harness-utils.js";
import { AgentInstallResultSchema } from "@/api/models.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { IS_TEST } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import { type AgentInstallDeps, AgentInstallRefused, installBuiltInAgent } from "@/services/agent-install.service.js";
import { audit } from "@/services/audit.js";
import { localPluginReports } from "@/services/nodes/local-plugins.js";

let depsOverride: AgentInstallDeps | undefined;
/** Test seam: swap the installer's command lookup and clock. Refuses outside the suite. @internal */
export function setAgentInstallDepsForTests(deps: AgentInstallDeps | null): void {
  if (!IS_TEST) throw new Error("setAgentInstallDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

/**
 * `POST /api/setup/agents/:pluginId/install` (spec 2026-09-11 § 7). Its own
 * module for the reason `settings-public.route.ts` is: the GATE differs from
 * the rest of `/api/setup`. Every other setup write is public while no user
 * exists; this one never is, because it makes the host fetch and run a
 * remote script. Admin cookie only; bearer keys are refused like every admin
 * surface. The Add an Agent screen runs after Create Your Account, so the
 * first person through already holds the cookie this needs.
 */
export const setupAgentInstallRoute = new Elysia({ prefix: "/api/setup/agents" })
  .use(apiModels)
  .post(
    "/:pluginId/install",
    async ({ request, params, status }) => {
      if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
      try {
        const result = await installBuiltInAgent(params.pluginId, depsOverride);
        const actor = await resolveCookieSession(request.headers.get("cookie") ?? "");
        await audit({
          actorUserId: actor?.user.id ?? null,
          action: "agent.install",
          targetType: "plugin",
          targetId: params.pluginId,
          metadataJson: JSON.stringify({ ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs }),
        });
        const installedHere = (await localPluginReports()).some((r) => r.id === params.pluginId && !r.broken);
        return { ...result, harness: await harnessInfo(params.pluginId, installedHere) };
      } catch (err) {
        if (err instanceof AgentInstallRefused) {
          return status(err.status, apiErrorBody({ code: BackendErrorCodes.INPUT_VALIDATION_ERROR, message: err.message }));
        }
        throw err;
      }
    },
    {
      params: t.Object({ pluginId: t.String({ description: "Built-in plugin id whose agent CLI to install" }) }),
      response: {
        200: AgentInstallResultSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "installSetupAgent",
        tags: ["setup"],
        description:
          "Runs the official installer of one BUILT-IN agent CLI on the control-plane host, as the server's user (admin cookie only, never public, audited). ok:false is a run that failed; 4xx is a refusal before anything ran.",
      },
    },
  );
```

Check `plugins.route.ts` for the error code it uses on 409 and match it. Register in `routes.ts`.

- [ ] **Step 3: Run, rebuild client types, commit**

```bash
cd apps/server/api && bun test src/api/__tests__/setup-agent-install.route.test.ts
cd ../../.. && turbo build --filter=@internal/server --filter=@internal/backend-client && bun run verify-types && bun run lint:check
git add -A apps/server/api && git commit -m "feat(server): POST /api/setup/agents/:id/install, admin-only"
```

### Task 11: The Install button

**Files:**
- Create: `apps/server/web/src/hooks/use-install-agent.ts`
- Modify: `apps/server/web/src/routes/setup.tsx`
- Modify: `apps/server/web/src/routes/__tests__/setup.test.tsx`

- [ ] **Step 1: Hook**

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HARNESS_QUERY_KEY } from "@/hooks/use-harnesses";
import { apiFetch } from "@/lib/api";
import type { HarnessInfo } from "@/types/harness";

export interface AgentInstallResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  harness: HarnessInfo;
}

/** Runs a built-in agent's installer on the control-plane host (admin only); refetches detection afterwards. */
export function useInstallAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<AgentInstallResult>(`/api/setup/agents/${id}/install`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY }),
  });
}
```

- [ ] **Step 2: Wire the screen** — `const install = useInstallAgent();` and `const installingId = install.isPending ? install.variables : undefined;`; pass `refetchInterval: step === 1 && !install.isPending ? 4000 : undefined` (a re-probe mid-install is a false "Not found"); render `<AgentRow key={h.id} harness={h} onInstall={(id) => install.mutate(id)} installing={installingId === h.id} />`; under the list, when `install.data && !install.data.ok` a `<details>` "Installer output" with `<pre className="max-h-48 overflow-auto text-xs">{install.data.output}</pre>`, and when `install.error` a `text-destructive` line via `errMessage`. Add a `setup.test.tsx` case routing the POST to `{ ok: true, exitCode: 0, output: "done", harness: {...CLAUDE_ABSENT, installed: true, version: "1.0.0"} }` and the list to the installed row afterwards; clicking Install renders `Detected · v1.0.0`.

- [ ] **Step 3: Verify, commit** — `cd apps/server/web && bun test && bun run verify-types && cd ../../.. && bun run lint:check && git add -A apps/server/web && git commit -m "feat(server): install an agent CLI from the setup assistant"`

### Task 12: Retire the desktop's agent installer

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/control.rs` (delete `AGENT_INSTALLS`, `desktop_install_agent`, test `an_unknown_agent_id_is_refused_rather_than_run`; in `the_console_install_table_and_the_rust_one_agree` delete the agent loop, keep tmux)
- Modify: `apps/server/desktop/src-tauri/src/lib.rs` (remove the command from `generate_handler!`)
- Modify: `apps/server/desktop/src-tauri/permissions/desktop.toml` (delete the `allow-desktop-install-agent` block)
- Modify: `apps/server/desktop/src-tauri/capabilities/console.json` (drop it)
- Modify: `apps/server/desktop/ui/src/lib/ipc.ts` (delete `installAgent`), `ui/src/lib/installers.ts` (delete `AGENT_INSTALLS`, `agentInstallPlan`; header comment to tmux only), `ui/src/__tests__/installers.test.ts` (drop agent cases)
- Modify: `apps/server/desktop/ui/src/main.ts` (`doInstallAgent` at ~866 and the `ready` step's "Install an agent CLI…" → "Add agents in the dashboard" calling `ipc.openMain()`)
- Modify: `apps/server/desktop/AGENTS.md` ("The install offers mirror a Rust list" → tmux only)
- Modify: `docs/security.md` (§ 11.10; § 12 checklist line), `.claude/rules/security-context.md`
- Create: `.changeset/agent-install-on-the-plane.md`

- [ ] **Step 1: Rust and ACL removals**, then `bun run rust:check` — PASS.
- [ ] **Step 2: UI removals**, then `cd apps/server/desktop && bun run build && bun run test && bun run verify-types` — `ipc-acl.test.ts` passes with `console.json` shrunk and no undefined permission referenced.
- [ ] **Step 3: `docs/security.md` § 11.10**

```markdown
## 11.10 The control plane runs an agent CLI's installer on request

`POST /api/setup/agents/:id/install` makes the server spawn `sh -c <command>`
where `<command>` is the `install.command` of a BUILT-IN plugin's manifest,
compiled into this binary. What it costs: the control-plane process fetches
and runs a vendor's install script. What it does not add: the script runs as
the server's own OS user on the server's own host, with exactly the reach
the server's children already have (tmux, every harness pane, the plugin
loader), and it is the same command the desktop app used to run from the
user's session as the same user — a different parent process, no new
capability. The id is the only input; the route is admin-cookie-only, never
public in the no-users window, single-flight per id, 10-minute bounded, and
audited as `agent.install` without the output. Trusted-network posture,
unchanged. A hardening pass for a wider deployment would add an operator
switch to disable the route (§ 12).
```

In `.claude/rules/security-context.md`, under the Nodes bullets: `**Agent CLI installs are an admin act on the control-plane host** (spec 2026-09-11 § 7): \`POST /api/setup/agents/:id/install\` runs a BUILT-IN manifest's install command as the server's user; admin cookie only, never public, audited. Accounting in \`docs/security.md\` § 11.10.`

- [ ] **Step 4: Changeset**

```markdown
---
"@internal/server": minor
"@internal/desktop-server": minor
---

Agent CLIs are installed by the control plane on an admin's request (`POST /api/setup/agents/:id/install`, built-in ids only, audited), from the setup assistant's Add an Agent screen. Subshell Server no longer carries its own installer table or the `desktop_install_agent` command; its status page points at the dashboard instead.
```

- [ ] **Step 5: Full verification and commit**

```bash
bun run verify-types && bun run lint:check && bun run test && bun run rust:check
git add -A && git commit -m "refactor(desktop-server,server): agent installs move to the control plane"
```

---

## Acceptance (by hand, on a fresh macOS user account)

1. Launch `Subshell Server.app` with nothing installed: a fixed 1024×720 window, app icon, **Welcome to Subshell**, one dot of three filled, Continue bottom-right. Enter advances.
2. With tmux missing: **Install tmux**, one big button; after it installs, the screen advances by itself. With tmux present: straight to **Set Up Your Server** with two dots done.
3. **Set Up Your Server** lists three things; Customize expands the address form and typing is not interrupted; **Set Up** turns the screen into **Setting Up Subshell…** with rows ticking; then *Opening your dashboard…*.
4. The dashboard appears at the same position and size; the setup window is gone; **Create Your Account** shows six dots, three filled.
5. **Add an Agent**: Claude Code already installed shows `Detected · v…`; the rest `Not found` with How to install collapsed; no switches; Terminal is a sentence. (Phase 3) Install flips a row to Detected within one refetch.
6. **Start Your First Subshell** → **Start** → a live terminal.
7. `/settings` danger card → Reset → back to **Welcome to Subshell**.

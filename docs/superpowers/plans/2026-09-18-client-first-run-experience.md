# Client First-Run Experience (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Subshell Client a first run that asks whether to register this machine as a node or just connect to a server, walks the chosen path without ever opening the dashboard prematurely, and lands a configured client on a client-status screen from which the server dashboard is one button away.

**Architecture:** The existing bundled `node` window's probe-derived screen machine (`node-assistant-state.ts` + `app.tsx`) is kept and extended with a small first-run flow module; a new **client status screen** becomes the landing for a configured client. New privileged work is minimal and shares the server's proven code: the tmux installer is lifted into `crates/desktop-core`, and two thin client commands (`node_install_tmux`, `node_set_plane`) are added to the already-granted `node` window. The `main` window and its single pinned remote origin are untouched.

**Tech Stack:** Tauri v2 + Rust (`crates/desktop-core`, `apps/client/desktop/src-tauri`), React 19 + Vite + Tailwind v4 + TanStack Query (`apps/client/desktop/ui`), `bun test` (happy-dom for UI), `cargo` tests, biome, `lint:design`.

**Spec:** `docs/superpowers/specs/2026-09-18-client-first-run-experience-design.md` — read it; this plan implements its § 2–10, **except** § 7's *run-with-the-app* node supervision and § 11's multi-server dashboard, both deferred (see **Deferred** at the end).

## Global Constraints

- **Styling — pick a role, never a number** (`docs/design-system.md`, `.claude/rules/design-system.md`): use `text-label font-strong`, `text-detail`, `text-body`/`text-sm` only. `bun run lint:design` fails on a literal size/weight/colour outside the token file. Colours by shadcn name (`--foreground`, `--muted-foreground`, `--border`, `--warning`).
- **CSP — no inline style attributes** (`apps/client/desktop/AGENTS.md`): Tailwind classes only; a React `style={{…}}` prop or `dangerouslySetInnerHTML` is a build failure (`ui/src/__tests__/no-inline-styles.test.ts`). Do NOT use portalled/anchored Base UI (popover/tooltip/select) — they position with inline styles.
- **Never spawn `subshell run`** (never resolves, competes with the service) and **never `subshell status --probe`** (supersede-kicks a live agent). Every spawn goes through `desktop_core::proc`.
- **`enroll` spends a single-use 24 h setup key**; there is no already-enrolled guard and no auto-retry of a spent key. Its CLI preflight refuses before the network call when tmux is missing — rely on it.
- **Three-way command contract**: a command name must exist in `ui/src/lib/ipc.ts`, `src-tauri/permissions/desktop.toml`, AND `src-tauri/capabilities/node.json`; `ui/src/__tests__/ipc-acl.test.ts` fails on any mismatch — update all three in the same change.
- **Two `bun test` runs**: `cd ui && bun test` (happy-dom, component tests) and `bun test src` at the app root (release script, no DOM). Rust: `bun run rust:check` from the repo root (fmt + `clippy -D warnings` + test, all three crates; stages a sidecar stub).
- **The `main` window keeps exactly one command** (`desktop_open_in_browser`); `capabilities/main.json` is not touched by this plan.
- **Commits**: conventional, and end every message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `crates/desktop-core/src/tmux.rs` — **create**: the shared tmux install argv + runner (used by both desktop apps).
- `apps/server/desktop/src-tauri/src/control.rs` — **modify**: `desktop_install_tmux` delegates to `desktop_core::tmux`.
- `apps/client/desktop/src-tauri/src/control.rs` — **modify**: add `node_install_tmux`, `node_set_plane`.
- `apps/client/desktop/src-tauri/src/windows.rs` — **modify**: `open_at_startup` lands a configured client on the node window, never auto-opens the dashboard.
- `apps/client/desktop/src-tauri/permissions/desktop.toml` + `capabilities/node.json` — **modify**: grant the two new commands to `node`.
- `apps/client/desktop/ui/src/lib/ipc.ts` — **modify**: `nodeInstallTmux`, `nodeSetPlane`.
- `apps/client/desktop/ui/src/lib/client-flow.ts` — **create**: pure first-run routing + the register-chain step model (testable, no webview).
- `apps/client/desktop/ui/src/lib/node-assistant-state.ts` — **modify**: new `NodeScreenId`s.
- `apps/client/desktop/ui/src/components/assistant/{welcome,choice,tmux,register,startup,progress,status}-screen.tsx` — **create/modify** (status from the existing `connected-screen.tsx`).
- `apps/client/desktop/ui/src/hooks/use-node-commands.ts` — **modify**: `register()`, `startUpLogin()`, `connectOnly()`.
- `apps/client/desktop/ui/src/app.tsx` — **modify**: drive the flow via `client-flow.ts`.
- Tests alongside each: `ui/src/__tests__/*`, `ui/src/lib/__tests__/client-flow.test.ts`, `crates/desktop-core/src/tmux.rs` tests, `src-tauri` command tests.

---

## Task 1: Lift the tmux installer into `desktop-core`

**Files:**
- Create: `crates/desktop-core/src/tmux.rs`
- Modify: `crates/desktop-core/src/lib.rs` (add `pub mod tmux;`)
- Modify: `apps/server/desktop/src-tauri/src/control.rs` (the `desktop_install_tmux` fn near line 1408 and its `tmux_install_argv` table)
- Test: `crates/desktop-core/src/tmux.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces: `desktop_core::tmux::install_argv(platform: &str, has_brew: bool) -> Option<Vec<String>>` — the exact argv to run, or `None` where nothing can be run unattended (macOS without brew; any non-macOS/linux host); and `desktop_core::tmux::install(platform: &str, has_brew: bool) -> crate::proc::RunOutcome`-shaped result. Server and client both consume these.

- [ ] **Step 1: Read the server's current installer so the lift is a move, not a rewrite**

Run: `sed -n '1360,1470p' apps/server/desktop/src-tauri/src/control.rs`
**Ground truth, already measured — do not re-derive it:** the server's `tmux_install_argv()` today takes NO arguments and reads `std::env::consts::OS` plus `shell_env::which("brew")` inline. Its table is exactly:
- `macos` → `which("brew")?` then `["brew","install","tmux"]` (so: no brew ⇒ `None`)
- `linux` → `["pkexec","apt-get","install","-y","tmux"]` (pkexec, NOT sudo — a GUI-spawned sudo has no tty and hangs)
- anything else → `None`

The lift PARAMETERIZES it (`platform`, `has_brew`) purely so it is unit-testable off the host platform; **behaviour must be identical**. Keep the existing comments explaining the brew and pkexec choices.

- [ ] **Step 2: Write the failing pure test for the argv table**

```rust
// crates/desktop-core/src/tmux.rs
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn brew_exists_uses_brew() {
        assert_eq!(install_argv("macos", true).unwrap()[0..2], ["brew", "install"]);
        assert_eq!(install_argv("macos", true).unwrap()[2], "tmux");
    }
    #[test]
    fn no_brew_on_macos_offers_nothing_runnable() {
        assert_eq!(install_argv("macos", false), None);
    }
    #[test]
    fn linux_uses_pkexec_so_the_desktop_prompts_for_the_password() {
        // MEASURED from the server's own table: Linux is
        // ["pkexec","apt-get","install","-y","tmux"] — pkexec, never a bare
        // sudo, because a sudo spawned from a GUI has no terminal to read a
        // password from and hangs until the timeout. It is RUNNABLE.
        assert_eq!(
            install_argv("linux", false).unwrap(),
            ["pkexec", "apt-get", "install", "-y", "tmux"]
        );
    }
    #[test]
    fn an_unknown_platform_offers_nothing() {
        assert_eq!(install_argv("windows", true), None);
    }
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd crates/desktop-core && cargo test tmux::tests -- --nocapture`
Expected: FAIL — `install_argv` not found.

- [ ] **Step 4: Implement `tmux.rs`**

Move the table into `install_argv(platform: &str, has_brew: bool) -> Option<Vec<String>>` and add `install(platform, has_brew)` which runs the argv through `crate::proc` (the mechanism the server uses today). `None` ⇒ no refusal-by-panic: return the same "nothing we can run here" outcome the server produces now, carrying the command for a human to run. The server's caller passes `std::env::consts::OS` and `shell_env::which("brew").is_some()` so its behaviour is bit-for-bit what it was.

- [ ] **Step 5: Run the module tests**

Run: `cd crates/desktop-core && cargo test tmux::`
Expected: PASS.

- [ ] **Step 6: Point the server at the shared fn (behaviour unchanged)**

In `apps/server/desktop/src-tauri/src/control.rs`, make `desktop_install_tmux` call `desktop_core::tmux::install(...)` and delete its private `tmux_install_argv`. The server's existing `desktop_install_tmux` tests must still pass unchanged.

- [ ] **Step 7: Verify both crates + the containment pin still hold**

Run (repo root): `bun run rust:check`
Expected: fmt/clippy/test green in all three crates. Note: `crates/desktop-core` has its own `cargo test` — `rust:check` runs it.

- [ ] **Step 8: Commit**

```bash
git add crates/desktop-core/src/tmux.rs crates/desktop-core/src/lib.rs apps/server/desktop/src-tauri/src/control.rs
git commit -m "refactor(desktop): the tmux installer moves to desktop-core, shared by both apps

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: `node_install_tmux` command (client) + ACL

**Files:**
- Modify: `apps/client/desktop/src-tauri/src/control.rs` (add the command; register in `lib.rs`)
- Modify: `apps/client/desktop/src-tauri/src/lib.rs` (`invoke_handler`)
- Modify: `apps/client/desktop/src-tauri/permissions/desktop.toml`
- Modify: `apps/client/desktop/src-tauri/capabilities/node.json`
- Modify: `apps/client/desktop/ui/src/lib/ipc.ts`
- Test: `apps/client/desktop/ui/src/__tests__/ipc-acl.test.ts`

**Interfaces:**
- Consumes: `desktop_core::tmux::install` (Task 1), `Probe.tmux: Option<String>` + `Probe.hasBrew` (control.rs).
- Produces: Rust `#[tauri::command(async)] fn node_install_tmux(app, …) -> Result<ActionResult, String>`; ipc `nodeInstallTmux(): Promise<ActionResult>`.

- [ ] **Step 1: Add the command**

```rust
// apps/client/desktop/src-tauri/src/control.rs
/// Install tmux so this machine can run subshells. Same sudo-refusing,
/// no-operator-input rule as Subshell Server: it runs only under Homebrew on
/// macOS and returns the command to run by hand everywhere else (AGENTS §tmux).
#[tauri::command(async)]
pub fn node_install_tmux(app: AppHandle) -> Result<ActionResult, String> {
    let _ = &app;
    // MEASURED: the client's `Probe` has `tmux: Option<String>` but NO
    // `platform` and NO `has_brew` field (unlike the server's). So resolve both
    // HERE, exactly as the server's own installer does, rather than adding
    // probe fields nothing else needs.
    let brew = subshell_desktop_core::shell_env::which("brew").is_some();
    // THIRD ARGUMENT, measured after Task 1 landed: the server's install is
    // STREAMED (`run_streaming` + a sink emitting per-line events its page
    // listens for), so the shared fn is
    //   install(platform, has_brew, on_line: LineSink) -> Result<Run, String>
    // with `LineSink = Arc<dyn Fn(&str) + Send + Sync>` (desktop-core `proc`).
    // The client has no line display on this screen yet, so pass a no-op sink
    // rather than dropping the argument. `Run` -> `ActionResult` conversion is
    // app-level: desktop-core must not depend on tauri.
    let sink: subshell_desktop_core::proc::LineSink = std::sync::Arc::new(|_: &str| {});
    Ok(subshell_desktop_core::tmux::install(std::env::consts::OS, brew, sink)?.into())
}
```

- [ ] **Step 2: Register + grant in all three files**

- `lib.rs`: add `control::node_install_tmux,` to the `invoke_handler![…]` list beside the other `node_*`.
- `permissions/desktop.toml`: `[[permission]] identifier = "allow-node-install-tmux"` … `commands.allow = ["node_install_tmux"]`.
- `capabilities/node.json`: append `"allow-node-install-tmux"` to `permissions`.

- [ ] **Step 3: Add the ipc wrapper**

```ts
// ui/src/lib/ipc.ts
export function nodeInstallTmux(): Promise<ActionResult> {
  return invoke<ActionResult>("node_install_tmux");
}
```

- [ ] **Step 4: Update the ACL pin**

In `ipc-acl.test.ts`, add `nodeInstallTmux` to the invoked set and `allow-node-install-tmux` to the granted set so the three-way equality stays exact. Run `cd apps/client/desktop/ui && bun test src/__tests__/ipc-acl.test.ts` → expect FAIL first (sets disagree), then PASS once all three files list it.

- [ ] **Step 5: Verify**

Run: `cd apps/client/desktop/src-tauri && cargo build` (staged sidecar per AGENTS) and `cd apps/client/desktop/ui && bun test`.
Expected: green.

- [ ] **Step 6: Commit** (`feat(desktop-client): node_install_tmux, shared with the server`)

---

## Task 3: `node_set_plane` (persist without opening) + ACL

Needed so the connect step can remember an address WITHOUT opening the dashboard — the exact bug in § 1 of the spec (`node_open_plane` persists AND opens).

**Files:** control.rs, lib.rs, permissions/desktop.toml, capabilities/node.json, ui/src/lib/ipc.ts, ipc-acl.test.ts.

**Interfaces:**
- Consumes: `validate_server_url(&str) -> Result<String,String>` (control.rs:969), `settings.update(|s| s.plane_url = …)`.
- Produces: Rust `fn node_set_plane(app, settings: State<SettingsState>, url: String) -> Result<String,String>` (validate + persist, NO window); ipc `nodeSetPlane(args:{url:string}): Promise<string>`.

- [ ] **Step 1: Add the command** (validate + persist only; reuse the pieces `node_open_plane` already calls, minus `windows::open_plane`):

```rust
/// Remember the control plane WITHOUT opening its window. `node_open_plane`
/// persists and opens; the first-run connect step must only persist, so the
/// dashboard never appears mid-setup.
#[tauri::command(async)]
pub fn node_set_plane(settings: State<'_, SettingsState>, url: String) -> Result<String, String> {
    let resolved = validate_server_url(&url)?;
    settings.update(|s| s.plane_url = Some(resolved.clone()))?;
    Ok(resolved)
}
```

- [ ] **Step 2–4:** register in `lib.rs`; add `allow-node-set-plane` to `permissions/desktop.toml` and `capabilities/node.json`; add ipc `nodeSetPlane`; update `ipc-acl.test.ts` (same three-way pin).
- [ ] **Step 5:** `cd src-tauri && cargo build` + `cd ui && bun test src/__tests__/ipc-acl.test.ts`.
- [ ] **Step 6:** Commit (`feat(desktop-client): node_set_plane persists the control plane without opening it`).

---

## Task 4: Pure first-run flow module (`client-flow.ts`)

The single source of routing truth, tested without a webview. All screen decisions live here.

**Files:**
- Create: `apps/client/desktop/ui/src/lib/client-flow.ts`
- Modify: `apps/client/desktop/ui/src/lib/node-assistant-state.ts` (extend `NodeScreenId`; add `"welcome" | "choice" | "tmux" | "register" | "startup" | "progress" | "status"`, keep `"connect"` as the watch-URL screen, keep `"reset" | "about" | "app-update" | "enroll" | "service"`)
- Test: `apps/client/desktop/ui/src/lib/__tests__/client-flow.test.ts`

**Interfaces:**
- Consumes: `Probe`, `NodeSettings` (`ipc.ts`), `ProbeStep`.
- Produces:
  - `FteStep = "intro" | "choice" | "node" | "watch"` — the in-memory first-run phase (app.tsx owns it).
  - `FlowInput = { probe?: Probe; settings?: NodeSettings; step: FteStep | null; override: NodeUserScreen | null }`.
  - `clientScreen(i: FlowInput): NodeScreenId | null`.
  - `registerSteps(probe: Probe | undefined, phase: RegisterPhase): RegisterRow[]` where `RegisterPhase = "form" | "installing" | "enrolling" | "starting" | "done"` and each row is `{ id: "install" | "enroll" | "start"; label: string; state: "pending" | "active" | "done" | "failed" }`.
  - `configured(settings, probe): boolean` — `true` when `settings?.planeUrl` is non-null (plane_url_from already folds the enrolled node's serverUrl into it).

- [ ] **Step 1: Write the failing routing tests**

```ts
// client-flow.test.ts (excerpt — cover all branches)
import { clientScreen, registerSteps, configured } from "../client-flow";
const s = (planeUrl: string | null) => ({ planeUrl }) as any;
const p = (over: object = {}) => ({ step: "no-agent", tmux: "/usr/bin/tmux", ...over }) as any;

test("no settings yet → checking (null)", () => expect(clientScreen({ step: null, override: null } as any)).toBeNull());
test("first run, nothing chosen → welcome", () =>
  expect(clientScreen({ probe: p(), settings: s(null), step: null, override: null })).toBe("welcome"));
test("after Continue → choice", () =>
  expect(clientScreen({ probe: p(), settings: s(null), step: "choice", override: null })).toBe("choice"));
test("choice=watch → the connect URL screen", () =>
  expect(clientScreen({ probe: p(), settings: s(null), step: "watch", override: null })).toBe("connect"));
test("choice=node, tmux missing → tmux screen (hard gate)", () =>
  expect(clientScreen({ probe: p({ tmux: null }), settings: s(null), step: "node", override: null })).toBe("tmux"));
test("choice=node, tmux present, not set up → register form", () =>
  expect(clientScreen({ probe: p(), settings: s(null), step: "node", override: null })).toBe("register"));
test("configured client lands on status, not a step screen", () =>
  expect(clientScreen({ probe: p({ step: "online" }), settings: s("https://p"), step: null, override: null })).toBe("status"));
test("configured but service stopped → still status (contextual action inside)", () =>
  expect(clientScreen({ probe: p({ step: "stopped" }), settings: s("https://p"), step: null, override: null })).toBe("status"));
test("an explicit user screen outranks all of it", () =>
  expect(clientScreen({ probe: p(), settings: s("https://p"), step: null, override: "reset" })).toBe("reset"));

test("registerSteps marks the running act active and its predecessors done", () => {
  const rows = registerSteps(p({ step: "not-enrolled" }), "enrolling");
  expect(rows.map(r => r.state)).toEqual(["done", "active", "pending"]);
});
```

- [ ] **Step 2: Run — FAIL** (`cd ui && bun test src/lib/__tests__/client-flow.test.ts`).
- [ ] **Step 3: Implement `client-flow.ts`** exactly to the contract above (the `configured` check, the FteStep ladder, the override precedence, and `registerSteps` deriving install/enroll/start states from `RegisterPhase`). Reuse `screenTitle`/`subtitleFor` for any screen that already has copy; add titles for the new ids in `node-assistant-state.ts`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** (`feat(desktop-client): pure first-run flow module for the client assistant`).

---

## Task 5: Welcome + Choice screens

**Files:** Create `welcome-screen.tsx`, `choice-screen.tsx`; wire cases in `app.tsx`.
**Interfaces:** Consumes `Frame`/`Button`; emits `onContinue()` / `onChoose("node"|"watch")` that set `FteStep` in app.tsx.

- [ ] **Step 1:** Mirror the server's `renderWelcome` copy (wizard.ts:414) for the client: title "Welcome to Subshell Client", one sentence naming both halves, single **Continue**. Reuse the assistant `Frame`.
- [ ] **Step 2:** Choice screen: "What would you like to do?" + two buttons — **Run subshells on this machine** (`onChoose("node")`) and **Connect to a server** (`onChoose("watch")`).
- [ ] **Step 3:** In `app.tsx`, add `const [step, setStep] = useState<FteStep | null>(null)`; render these for `"welcome"`/`"choice"`; pass `setStep` down.
- [ ] **Step 4:** Add a component test in `ui/src/__tests__/` that renders `WelcomeScreen` and asserts a Continue button, and `ChoiceScreen` fires `onChoose("node")` on the first button (use `@testing-library/react`; no inline styles).
- [ ] **Step 5:** `cd ui && bun test && bun run lint:design`. Commit.

---

## Task 6: tmux step screen

**File:** Create `tmux-screen.tsx`; wire in `app.tsx`.
**Interfaces:** Consumes `probe.tmux`, `commands.installTmux` (new, wraps `nodeInstallTmux`), `tmuxHint` (copy.ts). Auto-advance: when `clientScreen` next returns `"register"` (tmux found), the app renders that instead — no manual Continue, mirroring the server's `renderTmux` self-leaving behaviour (wizard.ts:433).

- [ ] **Step 1:** Screen "Install tmux" — one line, primary button calling `commands.installTmux()`, and (because the CLI may need a password it cannot answer) show the fallback install command. Reuse the tmux hint already used by `enroll-screen.tsx` (`tmuxHint(probe, "enroll")`).
- [ ] **Step 2:** `use-node-commands.ts`: `installTmux: () => runner.run(async () => finished(await nodeInstallTmux()))`.
- [ ] **Step 3:** Render for `"tmux"` in app.tsx. A component test: button calls `installTmux`; disabled while busy.
- [ ] **Step 4:** Tests + `lint:design`. Commit.

---

## Task 7: Register screen + the one-press `register()` chain

**Files:** Modify `register-screen.tsx` (new; reuse `EnrollFields` + `useEnrollForm`); add `register()` to `use-node-commands.ts`; render `"register"` in app.tsx.
**Interfaces:** Consumes `form.validate(): {server,key,name} | null`, `nodeEnroll({...args, confirm:true})`, `nodeInstallAgent()`, `nodeService({verb:"install"})`, `runner.settle()`. Produces: on success sets `FteStep`→ progress then status; never opens the dashboard.

- [ ] **Step 1: Write the failing action test**

```ts
// use-node-commands register test (mock ipc)
test("register installs only when no-agent, enrolls with confirm:true, starts the service, no confirm dialog", async () => {
  // probe.step "no-agent" → install called once, then enroll(confirm:true), then service install
  // probe.step "not-enrolled" (agent present) → install NOT called
});
```

- [ ] **Step 2: Implement `register()`** — chain, no `asks()`/confirmation (operator: "no need to confirm"):

```ts
register: () => runner.run(async () => {
  const args = form.validate();
  if (args === null) return finished(null);
  setProgress("installing");
  if (probe?.step === "no-agent") {
    const inst = await nodeInstallAgent();
    if (!inst.ok) return finished(inst);
  }
  setProgress("enrolling");
  const enr = await nodeEnroll({ ...args, confirm: true });
  if (!enr.ok) { form.clearSpentKey(); return finished(enr); }
  onEnrolled(enr.node);
  setProgress("starting");
  const svc = await nodeService({ verb: "install", force: false });
  if (svc.ok) await runner.settle();
  return finished(svc);
}, { reprobe: true });
```

`setProgress` is a small state setter passed from app.tsx so the progress screen (Task 9) reflects the current act; `registerSteps` (Task 4) renders it from `RegisterPhase`.
- [ ] **Step 3:** `register-screen.tsx`: render `EnrollFields` (server+name+key) with the **Register** button disabled until `form.validate() !== null` AND `probe?.tmux`. Below the fields, the loopback warning when `isLoopback(form.server)` (reuse `connected-screen.tsx:183`'s sentence).
- [ ] **Step 4:** Run the action test (Step 1) → make PASS. Add a test that a failing enroll stops the chain (service NOT called) and clears the spent key.
- [ ] **Step 5:** Tests + `lint:design`. Commit.

---

## Task 8: Start-at-login — port the server's `--no-autostart` to the node agent

**MEASURED GROUND TRUTH (do not re-derive; my earlier plan was wrong):**
- The node agent has **no** `enable`/`disable` verb. `apps/node/agent/src/service.ts:453`
  defines `ServiceVerb = "start" | "stop" | "restart"`, and `cli.ts:140` lists
  `service: ["install","uninstall","status", ...SERVICE_VERBS]`.
- `installService(deps)` (`apps/node/agent/src/service.ts`) takes **no options** and
  ALWAYS arms login start: `systemctl --user enable --now` on Linux, and a plist
  carrying `RunAtLoad` + `KeepAlive` on macOS.
- The SERVER already solved exactly this: `installService(deps, { autostart })`
  (`apps/server/api/src/service.ts:452`), driven by `--no-autostart`
  (`apps/server/api/src/cli.ts:438`, allowlisted at `cli.ts:515`). On Linux it adds
  `systemctl --user disable`; on macOS it **moves the plist** between
  `~/Library/LaunchAgents` (autostart) and the config dir (`sessionPlistPath`,
  no autostart) — because launchd auto-loads only the former. It also writes a
  different closing line: `"running (not enabled at login)"`.

So this task is a **port of a proven mechanism**, mirroring the server file-for-file.

**Files:**
- Modify: `apps/node/agent/src/service.ts` (`installService`, plist path selection)
- Modify: `apps/node/agent/src/cli.ts` (`--no-autostart` flag + allowlist)
- Modify: `apps/client/desktop/src-tauri/src/control.rs` (`ServiceCommand::Install` carries autostart)
- Modify: `apps/client/desktop/ui/src/lib/ipc.ts` (`nodeService` gains `autostart?: boolean`)
- Create: `apps/client/desktop/ui/src/components/assistant/startup-screen.tsx`
- Test: `apps/node/agent/src/__tests__/service.test.ts` (existing suite, stubbed deps)

**Interfaces:**
- Produces: `installService(deps, opts?: { autostart?: boolean })` (default `true`,
  matching the server's `opts.autostart !== false`); CLI `subshell service install
  [--no-autostart]`; Rust `ServiceCommand::Install` → argv `["service","install"]`
  or `["service","install","--no-autostart"]`; ipc `nodeService({verb:"install", autostart:boolean})`.

- [ ] **Step 1: Read both sides before writing**

```bash
sed -n '440,540p' apps/server/api/src/service.ts        # the mechanism to mirror
sed -n '/export async function installService/,/^}/p' apps/node/agent/src/service.ts
grep -n "sessionPlistPath\|plistPath\|LAUNCHD_LABEL" apps/node/agent/src/service.ts
```

- [ ] **Step 2: Write the failing agent tests** (in the existing service test suite, which uses the stub deps in `__tests__/helpers/service-stub.ts` — no real launchd/systemd)

```ts
it("installs with login start by default", async () => {
  const deps = stub();                       // platform: "linux"
  await installService(deps);
  expect(deps.commands).toContainEqual(["systemctl", "--user", "enable", "--now", "subshell.service"]);
});

it("--no-autostart runs it now but does not arm login (linux)", async () => {
  const deps = stub();
  await installService(deps, { autostart: false });
  expect(deps.commands).toContainEqual(["systemctl", "--user", "disable", "subshell.service"]);
});

it("--no-autostart keeps the plist OUT of ~/Library/LaunchAgents (macos)", async () => {
  const deps = stub({ platform: "darwin" });
  await installService(deps, { autostart: false });
  // launchd auto-loads ONLY ~/Library/LaunchAgents, so a non-autostart plist
  // must live in the config dir instead — the server's own rule.
  expect(deps.written.map((w) => w.path).join()).not.toContain("Library/LaunchAgents");
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cd apps/node/agent && bun test src/__tests__/service.test.ts`
Expected: FAIL (`installService` takes one argument / no disable recorded).

- [ ] **Step 4: Implement, mirroring the server**

`installService(deps, opts: { autostart?: boolean } = {})` with `const autostart = opts.autostart !== false;`. Linux: after `enable --now`, when `!autostart` run `systemctl --user disable <unit>` (and do NOT pass `--now` semantics away — it still runs now). macOS: select `plistPath(home)` vs a new `sessionPlistPath(configDir)` exactly as the server does, and REMOVE the other path so a stale file cannot re-arm autostart on the next reboot. Mirror the server's closing line wording.

- [ ] **Step 5: Run — expect PASS**, then the whole agent suite: `cd apps/node/agent && bun test`

- [ ] **Step 6: Wire the CLI flag**

`cli.ts`: add `--no-autostart` to the `service install` flag allowlist (mirroring `apps/server/api/src/cli.ts:515`) and pass `{ autostart: !flags.includes("--no-autostart") }`. Update the usage text the same way the server's line 171 reads. Add a CLI-level test that the flag reaches `installService`.

- [ ] **Step 7: Carry it through the client Rust**

`ServiceCommand::Install` must be able to emit the flag. Keep the enum closed; add the boolean to the `AgentCommand::Service` variant (it already carries `force`), e.g. `Service { verb, force, autostart: bool }` → argv `["service","install","--no-autostart"]` when `verb == Install && !autostart`. Add a Rust argv test beside the existing ones. Then update `nodeService` in `ipc.ts` and the ACL pin if the signature changed.

- [ ] **Step 8: The screen**

`startup-screen.tsx`: title "How should this node run?", one choice — **Start at login** (default ON, the current behaviour) with the Linux lingering sentence when relevant (`service.ts:292`, `loginctl enable-linger`) — and **Continue**. It sets the boolean the register chain passes to the service install step. NOTE: the *run-with-the-app* alternative is NOT built here (see **Deferred**); this screen presents the service with a login choice.

- [ ] **Step 9: Verify + hand back**

```bash
cd apps/node/agent && bun test
cd /Users/theo/projects/subshell && bun run verify-types && bun run lint:check
```

## Task 9: "Setting Up…" progress screen

**Files:** Create `progress-screen.tsx`; render `"progress"` in app.tsx (shown while `register()` runs and after it succeeds, before status).
**Interfaces:** Consumes `registerSteps(probe, phase)` (Task 4).

- [ ] **Step 1:** Pure test already covers `registerSteps` row states (Task 4). Add a component test: renders three named rows (Install the agent / Enroll this machine / Start the node service), marks the active one, and shows the failed act's verbatim line when a row is `failed`.
- [ ] **Step 2:** Implement using the existing `checklist`-style markup pattern from the app (rows are `label`-over-`detail` per design system). No inline styles; no portalled components.
- [ ] **Step 3:** On all rows `done`, show **Continue** → `setStep(null)` (leaves first-run; `clientScreen` then returns `"status"`). Commit.

---

## Task 10: Client status landing screen

**Files:** Create `status-screen.tsx` (evolve `connected-screen.tsx`); make it the configured-client landing.
**Interfaces:** Consumes `probe`, `settings`, `enrolledNode`, `commands`, `onReset`, `onRegister`; the existing `openPlane(null)` primary button.

- [ ] **Step 1:** `status-screen.tsx` shows: enrollment status (Enrolled as `<name>` / "not registered"), the server address, and:
  - **Open <server> dashboard** — `commands.openPlane(null)` (reuse `connected-screen.tsx:62`), shown whenever a plane is known.
  - If enrolled → **Unregister this machine…** → `onReset()` (the existing Reset flow).
  - If not enrolled (a watcher) → **Register this machine** → `onRegister()` (sets `FteStep = "node"`).
  - Keep Connected's existing More… (update agent / re-enroll / reset / change server / check app updates) reachable here.
- [ ] **Step 2:** `app.tsx`: render `"status"` for a configured client; drop the old direct `connected` auto-landing (status subsumes it; keep the connected content by rendering it inside status). Keep `screenTitle`/`subtitleFor` entries.
- [ ] **Step 3:** Component test: online+enrolled → Open dashboard + Unregister; connected-not-enrolled → Open dashboard + Register (no Unregister).
- [ ] **Step 4:** Update `node-assistant-state.test.ts` / add `client-flow` cases proving configured → status. Run `cd ui && bun test && bun run lint:design`. Commit.

---

## Task 11: Startup lands on the status screen; the dashboard never auto-opens

**Files:** Modify `apps/client/desktop/src-tauri/src/windows.rs` (`open_at_startup`), and the app's launch path in `lib.rs` (line ~236 where `resolve_plane_url` picks the lead).

**Interfaces:** `open_at_startup` currently opens the PLANE window when `plane` is Some (windows.rs:421). Change so a configured client leads with the **node window** (status landing); the dashboard opens only from the status screen's button.

- [ ] **Step 1: Write a Rust test** for the new choice — given `plane: Some(_)` AND the client is configured (which `Some` already means), `open_at_startup` opens the node window and does NOT open the plane window. (Extract a pure `startup_window_choice(plane, tray_home) -> WindowChoice::{Node, Plane}` beside the existing logic, mirroring how the server split `boot_window`.)
- [ ] **Step 2:** Implement `startup_window_choice` → `Node` for a configured client; `open_at_startup` acts on it (still respecting the no-tray-route-home fallback: if the node window has no other route home, show it outright — that path already exists).
- [ ] **Step 3:** Run `cd apps/client/desktop/src-tauri && cargo test` (sidecar stub per AGENTS) → PASS. Then `bun run rust:check` at root.
- [ ] **Step 4:** Confirm by reading `node_open_plane` is still reachable ONLY from the status screen's button and the watch path — grep `openPlane(` in `ui/src` shows no call during the register/progress flow. Commit.

---

## Task 12: End-to-end wiring + full verification + smoke

- [ ] **Step 1:** `app.tsx` renders the full ladder from `clientScreen` (welcome → choice → {node: tmux→register→progress→startup→status} | {watch: connect→status}) and passes `setStep`/`setOverride`. Remove any residual code that calls `nodeOpenPlane` on the connect path's initial "Open"; the connect path uses `nodeSetPlane` then `openPlane` only when the user presses **Open dashboard**.
- [ ] **Step 2:** Full gates:
```bash
bun run verify-types && bun run lint:check && bun run test   # repo root
cd apps/client/desktop/ui && bun test                        # component suite
bun run rust:check                                            # all three Rust crates
bun run lint:design
```
Expected: all green.
- [ ] **Step 3: Manual smoke on a throwaway instance** (never `:3080`; use `e2e/stack.ts` or a temp-plane per root AGENTS). `bun run reset:client` → `bun run dev:desktop-client`:
  - Watch path: choose Connect → enter URL → status screen → **Open dashboard** loads it; confirm NO window opened before the button was pressed.
  - Node path: choose Run-on-this-machine → tmux (if missing) → register (server+name+key; button gated) → Setting Up… checklist ticks → start-at-login → status screen; confirm no dashboard opened during setup; **Open dashboard** works; status shows **Unregister**.
  - Quit and relaunch the configured client: it opens to the **status screen**, not the dashboard.
- [ ] **Step 4:** Update `apps/client/desktop/AGENTS.md`: the FTE section (welcome→choice→register→startup→progress→status), `node_install_tmux`/`node_set_plane` in the command set, the never-auto-open rule, and the two deferrals. Commit.

---

## Deferred (explicitly NOT in v1 — each needs its own design)

- **Background-vs-run-with-the-app node supervision.** v1 runs the node only as a background service + start-at-login (Task 8). The server's `supervisor.rs` runs the SERVER as a child; a node's panes are tmux servers that are children of the daemon, so the signal/respawn discipline must be re-designed for `subshell run` before the client grows an app-run mode. Spec § 5.2/§ 7; needs a sibling spec, then a plan.
- **Client dashboard with a saved-server list + simultaneous multi-server windows.** Spec § 11. Multi-window re-opens the single-pinned-origin trust model (`PlanePin`, `capabilities/main.json`, `docs/security.md`) — its own spec + security accounting. v1's status screen is the single-server landing it grows from.

## Self-Review

- **Spec coverage:** § 4 flow → Tasks 4-11; § 5 screens → Tasks 5-10; § 6 register/no-confirm/loopback → Task 7; § 7 tmux share → Tasks 1-2; § 5.6 progress → Task 9; § 2 never-open rule + status landing → Tasks 10-11; § 10 trust unchanged → asserted (no `main` capability edits). § 11 dashboard + app-run supervision are the two documented deferrals.
- **Placeholders:** none; the two unknown mechanics (service enable/disable verb, server installer internals) are Step-1 read-and-preserve actions with concrete follow-through, not "TBD".
- **Type consistency:** `FteStep`, `RegisterPhase`, `clientScreen`, `registerSteps`, `configured`, `nodeSetPlane`, `nodeInstallTmux`, `ServiceCommand::Enable|Disable` are used by the same names across Tasks 4-11; the three-way command pin is updated in every task that adds a command.

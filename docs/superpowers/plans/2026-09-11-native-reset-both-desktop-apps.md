# Native Reset in Both Desktop Apps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a full reset reachable from the native app in both desktop apps: a console-side entry in Subshell Server (today it is reachable only through the server's own SPA), and a reset in Subshell Client, which has none.

**Architecture:** The four pure guards that make a reset safe move from the server app into `crates/desktop-core` so both apps share one copy. The node CLI grows a `paths` block in `status --json`, because the established rule is that a reset deletes what the CLI NAMES and never what the app guesses. Each app then gets a collapsed "Danger zone" disclosure, an arming command that stashes a plan read at press time, and a chain gated on a typed hostname.

**Tech Stack:** Rust (Tauri v2, `crates/desktop-core`), plain-DOM TypeScript + Vite (both apps' `ui/`), Bun + TypeScript (`apps/node/agent`), `bun test`, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-11-native-reset-both-desktop-apps-design.md` — read it first. Its § 5.2 (deletion order) and § 6 (why the guards move) are the two places the reasoning matters most.

## Global Constraints

- Bun only (`bun`, `bunx`); never npm/pnpm/yarn. Pinned dependency versions.
- No `await import()`. No em dashes in user-facing copy. U+2026 for ellipses.
- Every Elysia `t` schema property carries a `description` (not expected to come up here).
- `apps/server/**` is AGPL-3.0-only; everything else Apache-2.0. `crates/desktop-core` is Apache — moving code INTO it from `apps/server/desktop` is a relicense, and it is sound here only because `apps/server/desktop` is itself outside `apps/server/api`. Check `bun run lint:licenses` passes.
- **The remote windows gain nothing.** `apps/server/desktop`'s `main.json` keeps exactly its three commands; `apps/client/desktop`'s plane window keeps zero. `ipc-acl.test.ts` enforces this per page.
- Verification after every task: `bun run verify-types && bun run lint:check && bun run test` from the repo root, plus `bun run rust:check` for any task touching Rust. **Never prefix a command with `timeout`** — in this environment it resolves to a plugin wrapper that re-execs itself forever. Use `nohup … &` plus polling.
- Commit after each task, trailer exactly: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Do not push.
- Work on a branch off the current one.

---

### Task 1: The reset guards move to `crates/desktop-core`

**Files:**
- Create: `crates/desktop-core/src/reset_guards.rs`
- Modify: `crates/desktop-core/src/lib.rs` (declare the module)
- Modify: `apps/server/desktop/src-tauri/src/reset.rs` (delete the four functions, import them)

**Interfaces produced:**
```rust
pub fn path_rules_ok(p: &Path, home: &Path) -> bool;
pub fn delete_guard_ok(dir: &Path, keep: &Path) -> bool;
pub fn is_subshell_socket(name: &str) -> bool;
pub fn consent_granted(typed: &str, memo: &str) -> bool;
```

**This is a pure move. No behaviour changes.** The functions, their doc comments and their tests are transplanted verbatim; only their home changes.

- [ ] **Step 1: Read the four functions and their tests** in `apps/server/desktop/src-tauri/src/reset.rs`. `consent_granted` is currently private (`fn`, not `pub fn`) — it becomes `pub` in the crate.

- [ ] **Step 2: Create `crates/desktop-core/src/reset_guards.rs`** with a module docstring explaining why these live here rather than in either app:

```rust
//! The pure guards a reset is safe because of, shared by both desktop apps.
//!
//! Each app has its own chain, its own delete plan and its own Tauri commands
//! — they wipe different things. What they must NOT have is two copies of
//! these four predicates. A containment guard that drifts between the apps is
//! a machine that deletes a binary the reset promised to keep, and the drift
//! would be invisible until it happened.
//!
//! `tauri`-free by construction, which is the rule for everything in this
//! crate, and what lets these be tested without a display or a webview.
```

Move the four functions with their existing doc comments intact.

- [ ] **Step 3: Move the tests too**, including the `include_str!` containment test that pins `subshell-` against `pane-runtime`'s `tmuxSocketFor`. **Its relative path changes** — it currently reaches the TypeScript from `apps/server/desktop/src-tauri/`, and from `crates/desktop-core/` the path is different. Fix it and confirm the test still actually reads the file (make it fail once on purpose by pointing it at a wrong path, to prove it is not silently passing on an empty read).

- [ ] **Step 4: Declare the module** in `crates/desktop-core/src/lib.rs` beside the existing ones.

- [ ] **Step 5: Update the server app** — delete the four functions from `reset.rs` and import them:
```rust
use subshell_desktop_core::reset_guards::{consent_granted, delete_guard_ok, is_subshell_socket, path_rules_ok};
```
Leave `DeletePlan`, `parse_delete_plan`, `Stash`, `arm_and_raise` and `desktop_reset` where they are.

- [ ] **Step 6: Verify**
```
cd crates/desktop-core && cargo test
cd /Users/theo/projects/subshell && bun run rust:check && bun run lint:licenses
```
All three crates must pass. `lint:licenses` matters because code moved between packages with different licences.

- [ ] **Step 7: Commit**
```
refactor(desktop-core): one copy of the reset guards, not two

Both apps are about to need them, and two copies of a containment guard that
drift is a machine that deletes a binary the reset promised to keep.
```

---

### Task 2: The node CLI reports its own paths

**Files:**
- Modify: `apps/node/agent/src/cli.ts` (the `status` case)
- Test: `apps/node/agent/src/__tests__/` (find the existing status test, or add one)

**Interfaces produced:** `subshell status --json` gains `paths: { configFile, lockFile, dataDir }`, present only when a config loaded.

**Why:** spec § 5.1. The server's reset takes its deletion set from the CLI's own report rather than deriving paths, because a reset that deletes what the app guessed is the R1 failure with a typed hostname in front of it. The client's reset needs the same authority.

- [ ] **Step 1: Write the failing tests.** Cover: `--json` on an enrolled config carries all three paths and they are absolute; the not-enrolled branch carries NO `paths` key; the node key appears in neither branch's output. Use the existing status tests' fixture style (`SUBSHELL_CONFIG_HOME` points the agent at a temp home).

- [ ] **Step 2: Run them, watch them fail.**

- [ ] **Step 3: Implement.** In the `status` case's `--json` branch, beside the existing fields:
```ts
            paths: { configFile: configPath(), lockFile: lockPath(), dataDir: cfg.dataDir },
```
`configPath` comes from `@/config.js`, `lockPath` from `@/lock.js`. The not-enrolled branch (the `missing` object) is untouched — it has no `cfg`, so no `dataDir` exists to name.

- [ ] **Step 4: Run tests, then the package suite.** `cd apps/node/agent && bun test`.

- [ ] **Step 5: Document** in `apps/node/agent/AGENTS.md` beside the `status` description: the block exists so the desktop app's reset deletes what the CLI names, and it is absent when no config loaded.

- [ ] **Step 6: Commit**
```
feat(node): status --json names the paths a reset would delete
```

---

### Task 3: Subshell Server's console-side entry

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/reset.rs` (add `desktop_arm_reset`)
- Modify: `apps/server/desktop/src-tauri/src/lib.rs` (register it)
- Modify: `apps/server/desktop/src-tauri/permissions/desktop.toml`, `capabilities/console.json`
- Modify: `apps/server/desktop/ui/index.html`, `ui/src/main.ts`, `ui/src/styles.css`, `ui/src/lib/ipc.ts`
- Test: `apps/server/desktop/ui/src/__tests__/ipc-acl.test.ts` (must pass with the new grant)

- [ ] **Step 1: The command.** In `reset.rs`:
```rust
/// Arm the reset screen from the console itself: the arming half of
/// `arm_and_raise`, without the window half, because this window is already
/// up. Every property of the SPA path is kept — the plan is stashed from a
/// probe taken at press time (R18), and the page still supplies only a
/// hostname. Answers whether a plan parsed; `false` means the screen renders
/// its own refusal, which is the useful information.
#[tauri::command(async)]
pub fn desktop_arm_reset(app: AppHandle, settings: State<'_, SettingsState>) -> bool {
    let p = crate::control::probe_now(settings.get().binary_path.as_deref());
    let plan = p.status.as_ref().and_then(parse_delete_plan);
    let armed = plan.is_some();
    *app.state::<Stash>().plan.lock().unwrap() = plan;
    armed
}
```
Register it in `lib.rs`'s `generate_handler!`.

- [ ] **Step 2: The ACL.** A `[[permission]]` block in `desktop.toml`:
```toml
[[permission]]
identifier = "allow-desktop-arm-reset"
description = "Read this machine now and stash the reset's delete plan, so the console can raise its own reset screen. Console-only: the server-origin page still names a SCREEN and nothing else, and the wizard has no reset at all."
commands.allow = ["desktop_arm_reset"]
```
Add `"allow-desktop-arm-reset"` to `console.json` only.

- [ ] **Step 3: `ipc.ts`**
```ts
export const armReset = (): Promise<boolean> => invoke<boolean>("desktop_arm_reset");
```

- [ ] **Step 4: The markup.** At the end of `#status-view` in `index.html`, after the pane region, the `<details class="danger-zone" id="danger-zone">` block from spec § 4.3, verbatim.

- [ ] **Step 5: The styles.** In `styles.css`'s `@layer components`:
```css
  /* The one destructive control in the console. Closed on every render (see
     main.ts): a danger section that remembers being open is one someone
     scrolls past without reading. */
  .danger-zone { margin-top: 14px; }
  .danger-zone > summary { cursor: pointer; color: var(--color-muted); font-size: 14px; }
  .danger-zone > summary:hover { color: var(--color-fg); }
  .danger-zone button { margin-top: 8px; border-color: var(--color-bad); color: var(--color-bad); }
  .danger-zone button:hover:not(:disabled) { border-color: var(--color-bad); background: color-mix(in oklch, var(--color-bad) 12%, transparent); }
```

- [ ] **Step 6: The wiring** in `main.ts`:
```ts
el("reset-open").addEventListener("click", () => {
  void ipc.armReset().finally(() => showReset());
});
```
`finally`, not `then`: a refused or failed arming must still show the screen, because the screen is what explains the refusal. And in the status render path, force the disclosure closed each time:
```ts
(el("danger-zone") as HTMLDetailsElement).open = false;
```

- [ ] **Step 7: Verify**
```
cd apps/server/desktop && bun run build && bun run test && bun run verify-types
cd /Users/theo/projects/subshell && bun run lint:check && bun run rust:check
```
`ipc-acl.test.ts` is the gate: the console's invoked set must equal `console.json`'s grants, and the wizard and `main` must not have gained the command.

- [ ] **Step 8: Commit**
```
feat(desktop-server): reset is reachable from the console, not only the SPA
```

---

### Task 4: Subshell Client's reset chain

**Files:**
- Create: `apps/client/desktop/src-tauri/src/reset.rs`
- Modify: `apps/client/desktop/src-tauri/src/lib.rs` (module, `Stash` managed state, `generate_handler!`)
- Modify: `apps/client/desktop/src-tauri/permissions/desktop.toml`, the node page's capability file
- Test: Rust unit tests in the new module

**Interfaces produced:** spec § 7.2.

**Model it on `apps/server/desktop/src-tauri/src/reset.rs`** — read that file in full first. The differences are the plan's shape (three paths, not five), the chain's steps, and the absence of a window dance.

- [ ] **Step 1: Write the failing tests first.** In the new module's `mod tests`:
  - `parse_delete_plan` returns `None` when each of `configFile`, `lockFile`, `dataDir` is missing in turn, when one is empty, and when one is relative; `Some` when all three are absolute. (All-or-nothing, spec § 5.3.)
  - `parse_delete_plan` returns `None` for a status object with no `paths` key at all — the not-enrolled case.
  - A chain-order test asserting `configFile` is the LAST path deleted. Structure the chain so the order is a value you can assert (a `Vec<PathBuf>` built by a pure function) rather than something only observable by running deletions.
  - The containment guard refusing a `dataDir` that contains the installed `~/.local/bin/subshell`.

- [ ] **Step 2: Run them, watch them fail.**

- [ ] **Step 3: Implement.** Header comment stating the shape, mirroring the server's:

```rust
//! Resetting this machine's node back to un-enrolled: the stashed consent and
//! the chain that honours it (spec 2026-09-11 § 5).
//!
//! Same shape as `apps/server/desktop`'s reset, and deliberately so: the page
//! supplies a hostname, never a path; the plan is read from the CLI's own
//! `status --json` at press time and stashed, because the chain uninstalls the
//! very agent whose report names those paths; and the guards are the shared
//! ones in `subshell_desktop_core::reset_guards`, so the two apps cannot drift
//! about what is safe to delete.
//!
//! What differs: three paths rather than five, and NO window dance. The server
//! app has one manage window and a zero-window moment quits it; this app's two
//! windows are a remote plane window and this page, and resetting the node
//! invalidates neither.
```

The chain, in the order of spec § 5.2, each step calling the same extracted bodies the individual commands use (`service_now` and friends in `control.rs`). Deletion order: `dataDir`, `lockFile`, `configFile` — config last.

Channel discipline, inherited: `Err` only for refusals before the first mutation; a half-run is `Ok(ActionResult { ok: false, stdout: log, stderr })` with the plan still stashed.

- [ ] **Step 4: The ACL.** Two permissions (`allow-node-arm-reset`, `allow-node-reset`) in the client's `desktop.toml`, granted in the **node page's** capability file only. Read that file first to get its identifier right. The plane window's capability file must not be touched.

- [ ] **Step 5: Verify**
```
cd /Users/theo/projects/subshell && bun run rust:check
```

- [ ] **Step 6: Commit**
```
feat(desktop-client): a reset that returns this machine to un-enrolled
```

---

### Task 5: Subshell Client's reset UI

**Files:**
- Modify: `apps/client/desktop/ui/` — the node page's markup, its entry module, its styles, its `lib/ipc.ts`
- Create: `apps/client/desktop/ui/src/lib/reset.ts` (the pure decisions), plus its tests
- Test: the client's `ipc-acl` equivalent

**Read `apps/server/desktop/ui/src/lib/reset.ts` and its `#reset-view` markup first** — this is the same screen for a different set of paths, and the two should read as one product.

- [ ] **Step 1: Write the failing tests** for the pure half: the rows a plan renders, the refusal text when there is no plan (not enrolled), and `armed(typed, host)`.

- [ ] **Step 2: Implement the pure module**, mirroring the server's shape.

- [ ] **Step 3: The markup and wiring.** A `<details class="danger-zone">` on the node page, and a reset view that hides the ordinary view exactly as the console's does. Copy from spec § 5.4 for the disclosures, verbatim — each line names something a user would otherwise assume the reset handled.

- [ ] **Step 4: Verify**
```
cd apps/client/desktop && bun run build && bun run test && bun run verify-types
cd /Users/theo/projects/subshell && bun run lint:check
```

- [ ] **Step 5: Commit**
```
feat(desktop-client): the reset screen, with what it does not reach said plainly
```

---

### Task 6: Docs, security accounting, changesets

**Files:** as listed in spec § 9.

- [ ] **Step 1: `apps/server/desktop/AGENTS.md`** — the reset section gains the console entry and `desktop_arm_reset`'s grant; the IPC table's console row grows by one.
- [ ] **Step 2: `apps/client/desktop/AGENTS.md`** — a new reset section: the deletion set, the order and why config is last, the guards coming from the shared crate, and the absence of a window dance.
- [ ] **Step 3: `apps/node/agent/AGENTS.md`** — the `paths` block (done in Task 2; check it landed).
- [ ] **Step 4: `docs/security.md`** — § 8b gains spec § 3's accounting for the console entry (the admin gate goes, the OS-user gate was always the real one, the typed hostname and the containment guard remain). Add a short subsection for the client reset: what it deletes, that pane logs go with it, and the orphaned node row it leaves on the plane.
- [ ] **Step 5: `.claude/rules/security-context.md`** — one paragraph pointing at both.
- [ ] **Step 6: `README.md`** — its reset paragraph currently describes the SPA route only.
- [ ] **Step 7: Three changesets**, or one naming all three packages: `@internal/desktop-server`, `@internal/desktop-client`, `@internal/node`. Verify each against `.changeset/config.json`'s ignore list before writing.
- [ ] **Step 8: Commit.**

---

## Acceptance (by hand, because no automated test covers a real wipe)

1. **Server app, console entry:** with the server stopped and no browser open, the console shows "Danger zone"; expanding it and pressing the button raises the reset screen with the five paths and the hostname box. Typing the wrong name leaves it disabled.
2. **Server app, SPA entry:** unchanged — the dashboard's danger card still raises the same screen.
3. **Client app:** enrol a throwaway node against a test plane. Reset it. Then confirm: `~/.config/subshell` is gone; the service is absent from `systemctl --user list-units` / `launchctl list`; no `subshell-*` socket under the tmux dir; `~/.local/bin/subshell` still exists; the node page reports not enrolled; the plane still lists the node, now permanently offline.
4. **The plane window is still inert:** from the client's remote window, `window.__TAURI__` is undefined and no invoke reaches anything.

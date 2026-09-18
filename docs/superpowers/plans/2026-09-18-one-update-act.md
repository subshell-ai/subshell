# One Update Act Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One press updates a desktop app AND the CLI it bundles, in both Subshell Server and Subshell Client.

**Architecture:** The act is two phases across the app's relaunch. Phase 1 downloads and installs the app bundle, writing a marker into the shared `settings.json` before it relaunches; the NEW build reads that marker at boot and installs the bundled CLI, then restarts the service (server) or offers to (client). The marker and the pure decision that reads it live in `crates/desktop-core`; what each app DOES with it stays per-app.

**Tech Stack:** Rust (Tauri v2, `crates/desktop-core`), TypeScript (the server app's vanilla-DOM assistant, the client app's React assistant), the SPA (React + TanStack), `bun test`, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-18-one-update-act-design.md`

## Global Constraints

- **No new Tauri command and no capability change.** Both halves already exist as `wizard`/`node`-window commands. `ipc-acl.test.ts` in each app pins the exact granted set — if it goes red, the change is wrong.
- **No dynamic imports** (`.claude/rules/code-style.md`); one sanctioned exception exists and it is not here.
- **Design system:** roles not numbers — `text-label`, `text-detail`, `font-strong`. `bun run lint:design` refuses a literal size/weight/colour. There is no 12px; `detail` (13) is the floor.
- **Pinned dependency versions**, no `^`/`~`. No new dependencies are needed by this plan.
- **Anything with a contract rather than a rendering goes in `lib/`**, testable without a webview.
- **A stale comment is a defect.** Every docblock this plan invalidates must be rewritten in the same commit.
- **Verification after every task:** `bun run verify-types`, `bun run lint:check`, `bun run test`; plus `bun run rust:check` for Rust tasks and `bun run lint:design` for rendering tasks.

## File Structure

| file | responsibility |
|---|---|
| `crates/desktop-core/src/settings.rs` | `PendingBundledInstall`, the `Settings` field, serde round-trip |
| `crates/desktop-core/src/pending_install.rs` **(new)** | pure `resume_decision` + `Resume` |
| `apps/server/desktop/src-tauri/src/reset.rs` | `Screen` enum loses `AppUpdate` |
| `apps/server/desktop/src-tauri/src/control.rs` | marker read/write commands |
| `apps/server/desktop/ui/src/lib/update-act.ts` **(new)** | the pure act model: rows, phases, refusals |
| `apps/server/desktop/ui/src/wizard.ts` | one `update` screen replacing two |
| `apps/client/desktop/ui/src/lib/update-act.ts` **(new)** | mirrored act model |
| `apps/client/desktop/ui/src/components/assistant/update-screen.tsx` **(new)** | replaces `app-update-screen.tsx` |
| `apps/client/desktop/ui/src/hooks/use-node-commands.ts` | §7.2 copy, restart offer |
| `apps/server/web/src/components/updates/updates-table.tsx` | D4's folded row |
| `apps/*/desktop/src/scripts/release.ts` | `bundledCli` in the manifest |

---

### Task 1: The client's stale confirm copy (spec §7.2)

Independent of everything else; wrong today.

**Files:**
- Modify: `apps/client/desktop/ui/src/hooks/use-node-commands.ts` (`updateAgent`, ~line 156)
- Test: `apps/client/desktop/ui/src/__tests__/status-screen.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Copy only.

- [ ] **Step 1: Write the failing test**

```tsx
it("does not claim the service is stopped, because it is not", async () => {
  const fake = await boot({ probe: makeProbe({ agentChoice: "upgrade-available", managed: true }) });
  fireEvent.click(button(/Update the agent/));
  const panel = await screen.findByRole("dialog");
  expect(panel.textContent).not.toMatch(/stopped first/i);
  expect(panel.textContent).toMatch(/keeps running the previous version until you restart it/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd apps/client/desktop/ui && bun test src/__tests__/status-screen.test.tsx`
Expected: FAIL — the current string says "stopped first".

- [ ] **Step 3: Replace the two sentences**

```ts
const messages = [
  `Install the agent that ships inside this app (${probe?.bundledVersion ?? "unknown version"}) over ` +
    "~/.local/bin/subshell. Nothing is downloaded.",
];
if (probe?.managed === true) {
  messages.push(
    "The running daemon is not interrupted — the swap is a rename it never notices — so it keeps running the " +
      "previous version until you restart it.",
  );
}
```

The pane-safety line moves OFF this dialog: it describes a restart, and this install no longer stops anything. It reappears on the restart offer in Task 5.

- [ ] **Step 4: Run the test; then the full client suite**

`cd apps/client/desktop/ui && bun test`

- [ ] **Step 5: Fix the stale docblock and AGENTS.md line**

`apps/client/desktop/AGENTS.md`'s "Installing the bundled agent is a TRANSACTION" section already says the stop is gone; confirm it does not also repeat the old sentence.

- [ ] **Step 6: Commit**

```bash
git add apps/client/desktop/ui/src/hooks/use-node-commands.ts apps/client/desktop/ui/src/__tests__/status-screen.test.tsx
git commit -m "fix(client): the agent install stopped claiming it stops the service"
```

---

### Task 2: The marker, shared (spec §5)

**Files:**
- Modify: `crates/desktop-core/src/settings.rs`
- Create: `crates/desktop-core/src/pending_install.rs`
- Modify: `crates/desktop-core/src/lib.rs` (add `pub mod pending_install;`)

**Interfaces:**
- Produces:
  - `pub struct PendingBundledInstall { pub from_app_version: String, pub started_at: String, pub attempts: u32, pub forced: bool }`
  - `Settings::pending_bundled_install: Option<PendingBundledInstall>`
  - `pub enum Resume { Install { forced: bool }, Clear, Halt }`
  - `pub fn resume_decision(marker: Option<&PendingBundledInstall>, bundled: Option<&str>, installed: Option<&str>) -> Option<Resume>`
  - `pub const MAX_RESUME_ATTEMPTS: u32 = 2;`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn no_marker_means_nothing_to_resume() {
    assert_eq!(resume_decision(None, Some("0.10.0"), Some("0.9.0")), None);
}

#[test]
fn a_marker_with_a_newer_bundle_installs() {
    let m = marker(0, true);
    assert_eq!(resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")), Some(Resume::Install { forced: true }));
}

// The work is already done — a hand `update` in between, say. Clearing
// without acting is what keeps the marker from being a second opinion.
#[test]
fn a_marker_whose_work_is_done_clears_without_acting() {
    let m = marker(0, false);
    assert_eq!(resume_decision(Some(&m), Some("0.10.0"), Some("0.10.0")), Some(Resume::Clear));
}

#[test]
fn a_marker_with_no_bundle_clears() {
    let m = marker(0, false);
    assert_eq!(resume_decision(Some(&m), None, Some("0.9.0")), Some(Resume::Clear));
}

// Bounded: a failure every boot would take the window to a failure screen
// every launch. The marker stays so Retry can find it.
#[test]
fn it_halts_at_the_attempt_limit_rather_than_trying_forever() {
    let m = marker(MAX_RESUME_ATTEMPTS, false);
    assert_eq!(resume_decision(Some(&m), Some("0.10.0"), Some("0.9.0")), Some(Resume::Halt));
}

#[test]
fn the_marker_round_trips_through_settings_json() { /* serde to_string + from_str */ }

#[test]
fn an_older_settings_file_without_the_field_still_reads() {
    let s: Settings = serde_json::from_str("{\"zoom\":1.0}").unwrap();
    assert!(s.pending_bundled_install.is_none());
}
```

- [ ] **Step 2: Run and watch them fail**

`cd crates/desktop-core && cargo test pending_install`

- [ ] **Step 3: Implement**

```rust
/// Whether an interrupted update has a second half left, and whether to run it.
///
/// PURE, and the whole of the branching, because both apps make the same
/// decision and only differ in what they do with the answer (§5).
pub fn resume_decision(
    marker: Option<&PendingBundledInstall>,
    bundled: Option<&str>,
    installed: Option<&str>,
) -> Option<Resume> {
    let marker = marker?;
    // The marker converts an OFFER into a continuation; it never decides on
    // its own that there is work. A machine whose bundled copy is not newer
    // has nothing to install, however the marker got there.
    let has_work = match (bundled, installed) {
        (Some(b), Some(i)) => crate::version::version_lt(i, b),
        (Some(_), None) => true,
        (None, _) => false,
    };
    if !has_work {
        return Some(Resume::Clear);
    }
    if marker.attempts >= MAX_RESUME_ATTEMPTS {
        return Some(Resume::Halt);
    }
    Some(Resume::Install { forced: marker.forced })
}
```

`crate::version::version_lt(a, b)` is the crate's existing comparison (`version.rs:21`) — never add a second one.

- [ ] **Step 4: Run the tests; then `bun run rust:check`**

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-core/src
git commit -m "feat(desktop-core): the marker that carries an update across a relaunch"
```

---

### Task 3: The server app's one screen

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/reset.rs` (`Screen` — delete `AppUpdate`)
- Modify: `apps/server/desktop/src-tauri/src/control.rs` (marker commands)
- Create: `apps/server/desktop/ui/src/lib/update-act.ts`
- Modify: `apps/server/desktop/ui/src/wizard.ts`
- Modify: `apps/server/desktop/ui/src/lib/wizard-state.ts` (`ScreenId`, `REQUESTED_SCREENS`)
- Test: `apps/server/desktop/ui/src/__tests__/update-act.test.ts` (new), `wizard-state.test.ts`, `ipc-acl.test.ts`

**Interfaces:**
- Consumes: Task 2's `resume_decision`, `PendingBundledInstall`.
- Produces:
  - `export interface UpdateActRow { id: "app" | "cli"; label: string; from: string; to: string | null }`
  - `export interface UpdateAct { rows: UpdateActRow[]; canPress: boolean; refusal: string | null; phase: "idle" | "downloading" | "finishing" | "done" }`
  - `export function updateAct(input: {...}): UpdateAct`

- [ ] **Step 1: Write the failing pure tests** — one per §4.1 case (app behind, CLI behind, both, neither) and one per §6 refusal (not managed, air-gapped, in flight).

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `update-act.ts`**, then rewrite `renderUpdate`/`renderAppUpdate` into one `renderUpdate` driven by it. Delete `renderAppUpdate`, `Screen::AppUpdate`, and `"app-update"` from `ScreenId`/`REQUESTED_SCREENS`.

- [ ] **Step 4: Wire the marker** — write it before `app.restart()`, read it in `setup()`, route to `update` in the finishing phase.

- [ ] **Step 5: Run `bun test` in the app, then `bun run rust:check`.**

- [ ] **Step 6: Rewrite the docblocks** this invalidates — `AGENTS.md`'s "Two screens say update" section, `Screen`'s comments, the tray's `update_label`.

- [ ] **Step 7: Commit.**

---

### Task 4: The client app's one screen

Mirrors Task 3. Same steps, in React.

**Files:**
- Create: `apps/client/desktop/ui/src/lib/update-act.ts`, `components/assistant/update-screen.tsx`
- Delete: `components/assistant/app-update-screen.tsx`
- Modify: `lib/node-assistant-state.ts` (`NodeScreenId`), `lib/client-flow.ts`, `components/assistant/subtitles.ts`
- Test: `__tests__/update-act.test.ts` (new), `node-assistant-state.test.ts`, `ipc-acl.test.ts`

---

### Task 5: The client's restart offer (spec §7.1)

**Files:**
- Modify: `apps/client/desktop/ui/src/components/assistant/update-screen.tsx`, `app.tsx`
- Test: `apps/client/desktop/ui/src/__tests__/update-screen.test.tsx`

**Interfaces:**
- Consumes: Task 4's screen; `commands.restart()` (existing).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test** — after a successful agent install, the screen offers "Restart the agent" and says the daemon is still on the previous version; pressing it calls `commands.restart`.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement**, with `installedHere` as page state (the `ranSetupHere` pattern). The pane-safety line lands HERE, on the restart.
- [ ] **Step 4: Run the suite.**
- [ ] **Step 5: Rewire the status screen's "Update the agent to X" to open the screen (spec §7.4).**
- [ ] **Step 6: Commit.**

---

### Task 6: The SPA's folded row (D4)

**Files:**
- Modify: `apps/server/web/src/components/updates/updates-table.tsx`, `desktop-rows.tsx`, `server-row.tsx`
- Test: `apps/server/web/src/components/__tests__/`

- [ ] **Step 1: Failing test** — with `isServerDesktop()` true, one row, one control, and no release-source Update button; with it false, today's two rows unchanged.
- [ ] **Step 2–5:** implement, verify, commit.

---

### Task 7: `bundledCli` in the manifest (spec §4.3)

**Files:**
- Modify: `apps/server/desktop/src/scripts/release.ts`, `apps/client/desktop/src/scripts/release.ts`
- Test: each app's `src/scripts/__tests__/release.test.ts`

- [ ] **Step 1: Failing test** — the written manifest carries `bundledCli` equal to the staged sidecar's version.
- [ ] **Step 2–5:** implement, verify, commit. The screen must keep its unnumbered fallback for manifests published before this.

---

### Task 8: Docs

- [ ] Both apps' `AGENTS.md`: the "Two screens say update" section, the update sections, the IPC tables.
- [ ] Root `AGENTS.md` if it names the two screens.
- [ ] Commit.

---

## Then, per spec §11

1. Full code review over the whole range, by a reviewer that did not write it.
2. Fix every Critical, Important and Minor finding, or record why declined.
3. Re-review the fix wave.
4. `bunx changeset` (both desktop apps), PR, merge green.
5. Two sequential release dispatches; verify each manifest + `.sig`.

# First-Run Wizard and Whole-Machine Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Subshell Server desktop app's first-run status page with a guided multi-step wizard window, and add a hostname-confirmed "reset this machine" chain whose entry lives in the dashboard's Settings page and whose execution lives in the privileged console window.

**Architecture:** The app gains a third bundled window (`wizard`) opened at boot when a new `onboarded` settings flag is false; the flag is marked by Rust the first time a probe sees `ready`. All setup acts ride existing IPC commands; `desktop_setup` gains an optional address payload. Reset is one new console-only command executing a delete plan stashed in Rust app state by the `desktop_open_console` handler, reached from a danger card in the SPA via a new optional argument on a command `main` already holds.

**Tech Stack:** Tauri v2 (Rust 2021, tauri 2.11.5), TypeScript on Vite 8.2.1 + Tailwind (the bundled pages, plain DOM, no framework), Bun workspaces, `bun test`, Elysia/Bun for the server CLI change, React 19 for the SPA card.

**Spec:** `docs/superpowers/specs/2026-09-10-desktop-first-run-wizard-and-reset-design.md` - read it first; every task cites its sections. Four review rounds shaped it; the dispositions at the top of the spec explain WHY several guards are shaped the way they are.

## Global Constraints

- Bun only (`bun install` / `bun run` / `bunx`); never npm/pnpm. Package versions are pinned exact.
- No `await import()` anywhere except the sanctioned `packages/pane-runtime/src/plugin-runtime.ts` (`.claude/rules/code-style.md`).
- UI copy and docs use **no em dashes** (project memory); product strings stay plain ASCII sentences.
- Every spawn from the desktop app goes through `subshell_desktop_core::proc` (login PATH + deadline); never `Command::output()` in `shell_env`.
- `desktop-core` tests run standalone (`cd crates/desktop-core && cargo test`); the two app crates need the stub sidecar, so test them with `bun run rust:check` from the repo root (it stages/removes the stub, runs fmt + clippy `-D warnings` + tests in all three crates).
- The TypeScript verification trio runs from the repo root when touching TS: `bun run verify-types && bun run lint:check && bun run test`. The app's own UI tests: `cd apps/server/desktop && bun run test`.
- Serde conventions already in force: `#[serde(rename_all = "camelCase")]` on structs, `kebab-case` on `ProbeStep`; keep them.
- The console's CSP is `script-src 'self'` - no inline scripts or styles in any bundled HTML page, dev or prod (`ui/src/__tests__/tauri-config.test.ts` pins the pairing).
- No new direct dependencies, anywhere (Rust or npm).
- Commit messages end with the attribution line the EXECUTING session's own
  guidance dictates; session guidance supersedes any value written in this plan
  (reviewer P6, and the plan should not be the source of truth for it). The line
  in force at plan-writing time, and the one the example blocks below use, is
  `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: `desktop-core` - the `onboarded` field and an atomic save

Spec § 4. The flag every window choice hangs off, plus the durability fix the flag depends on: `Settings::save` is one `std::fs::write` today, and a torn file silently resets every setting (`load` swallows parse failures into `Default`).

**Files:**
- Modify: `crates/desktop-core/src/settings.rs` (struct at line 51, `save` at line 107, tests at the bottom of the file)

**Interfaces:**
- Produces: `Settings { binary_path, close_to_tray, open_at_login, plane_url, onboarded: bool }` (camelCase `onboarded` on the wire); `Settings::save` leaves no temp file and never a torn file.

- [ ] **Step 1: Write the failing tests** (append to the existing `#[cfg(test)] mod tests` in `settings.rs`)

```rust
    #[test]
    fn onboarded_defaults_false_and_reads_old_files() {
        // A settings file written before this field existed must read as
        // false: failing toward the wizard is the correct direction.
        let s: Settings =
            serde_json::from_str(r#"{"closeToTray":true,"binaryPath":"/x/subshell-server"}"#).unwrap();
        assert!(!s.onboarded);
        assert!(!Settings::default().onboarded);
    }

    #[test]
    fn onboarded_round_trips() {
        let mut s = Settings::default();
        s.onboarded = true;
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert!(back.onboarded);
    }

    #[test]
    fn save_to_is_atomic_by_shape_and_leaves_no_litter() {
        // The rename guarantee, exercised on a temp path through the seam
        // save() delegates to - never by mutating HOME, which other tests in
        // this same binary would read racily. After a save the directory
        // holds exactly settings.json: no .tmp a later observer would find.
        let dir = std::env::temp_dir().join(format!("subshell-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        let s = Settings {
            onboarded: true,
            ..Settings::default()
        };
        s.save_to(&file).expect("save");
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["settings.json".to_string()]);
        let back: Settings = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(back.onboarded);
        std::fs::remove_dir_all(&dir).ok();
    }
```

This requires the seam the test names: `save` keeps resolving `paths.file()` and then delegates to a new `fn save_to(&self, path: &Path) -> Result<(), String>` holding the create-dir/write/rename body (Step 3 writes it that way).

- [ ] **Step 2: Run to verify failure**

Run: `cd crates/desktop-core && cargo test onboarded` - expected: compile error (no field `onboarded`).

- [ ] **Step 3: Implement**

Add to `Settings` (after `plane_url`):

```rust
    /// Set once this app has watched a server on this machine reach `ready`.
    /// Decides whether boot opens the wizard or the status console. The
    /// struct-level `#[serde(default)]` gives an absent field the false that
    /// old files need: an upgrade without a completed setup re-enters the
    /// wizard, which is the correct direction to fail.
    pub onboarded: bool,
```

Add `onboarded: false` to the hand-written `Default` impl (its comment already explains why it is hand-written - extend the list, do not switch to derive).

Split `save` at the seam Step 1's test uses, and make the write temp + rename in the same directory (this is the discipline `publishArtifacts` and `plugins-seed` use; a rename inside one directory is the atomic swap):

```rust
    pub fn save(&self, paths: &SettingsPaths) -> Result<(), String> {
        let path = paths
            .file()
            .ok_or_else(|| "no HOME to save settings into".to_string())?;
        self.save_to(&path)
    }

    /// The write half, separated so its atomicity is testable against a temp
    /// path without relocating HOME (a process-wide variable the whole test
    /// binary shares).
    fn save_to(&self, path: &Path) -> Result<(), String> {
        let dir = path.parent().ok_or_else(|| "settings path has no parent".to_string())?;
        let name = path
            .file_name()
            .ok_or_else(|| "settings path has no file name".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        // Temp + rename, not fs::write: this file became the record (the
        // onboarded flag decides which window opens), and a crash between a
        // truncate and the last byte would leave JSON that `load`'s forgiving
        // parse reads as "no settings" - silently losing the picked binary.
        // The dot prefix keeps the in-flight name out of any listing globbing
        // for settings.json.
        let tmp = dir.join(format!(".{}.tmp-{}", name.to_string_lossy(), std::process::id()));
        std::fs::write(&tmp, &text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("could not move settings into {}: {e}", path.display())
        })
    }
```

(`use std::path::Path;` joins the imports if absent; `save_to` stays private to the crate, which the in-file test module reaches.)

- [ ] **Step 4: Run all crate tests + fmt/clippy**

Run: `cd crates/desktop-core && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test` - expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-core/src/settings.rs
git commit -m "feat(desktop-core): the onboarded flag, and settings saves that cannot tear

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `pane-runtime` - `cleanSocket` resolves the way tmux does

Spec § 7.2 step 3 / review disposition R1. `tmuxSocketPath` (the authority) resolves `-L` sockets under `$TMUX_TMPDIR ?? /tmp`, symlink-resolved; `cleanSocket` uses `TMPDIR ?? /tmp`, which on macOS (where `TMPDIR` is per-user `/var/folders/...`) names a file that never exists. Best-effort and silent, so it has never failed loudly.

**Files:**
- Modify: `packages/pane-runtime/src/tmux-runner.ts:350-357` (`cleanSocket`)
- Modify: `apps/server/api/src/services/nodes/__tests__/local-launcher.test.ts` (five call sites: lines 21, 84, 117, 141, 149)
- Modify: `apps/node/agent/src/__tests__/commands-launch.test.ts` (one call site: line 1129)
- Test: `packages/pane-runtime/src/__tests__/tmux-runner.test.ts` (exists - extend)

A grep of the repo finds NO production callers of `cleanSocket` (only the definition and these six test sites); the signature change therefore lands entirely in test hygiene, which is exactly why the two test files must be touched in THIS task rather than "found later by CI".

**Interfaces:**
- Produces: `cleanSocket(socket: string): Promise<void>` (now awaits instead of firing and forgetting, which is what makes it testable; existing callers that ignore the value still compile).

- [ ] **Step 1: Write the failing test** (inside the existing describe blocks)

```ts
describe("cleanSocket", () => {
  it("unlinks under TMUX_TMPDIR, which is where tmux put it", async () => {
    // The bug this pins: the old code joined process.env.TMPDIR, which on
    // macOS is a per-user /var/folders path holding no tmux sockets. tmux
    // itself resolves -L names under TMUX_TMPDIR ?? /tmp (tmuxSocketPath).
    const base = mkdtempSync(join(tmpdir(), "tmux-sock-test-"));
    const uid = process.getuid?.() ?? 0;
    const dir = join(base, `tmux-${uid}`);
    mkdirSync(dir, { recursive: true });
    const socket = "subshell-0123456789ab";
    const file = join(dir, socket);
    writeFileSync(file, "");
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = base;
    try {
      await new TmuxRunner().cleanSocket(socket);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
```

(Add whatever of `node:fs`/`node:os` imports the file's test module does not already have; match its existing import style.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/pane-runtime && bun test src/__tests__/tmux-runner.test.ts` - expected: FAIL, the file still exists (the old code resolved `TMPDIR`, not the test's `TMUX_TMPDIR` base).

- [ ] **Step 3: Implement**

```ts
  /**
   * Deletes the socket file for a dead subshell (best-effort, but awaited:
   * the path rule is `tmuxSocketPath`'s, and the test needs the unlink to
   * have happened before it asserts). TMPDIR is NOT the variable tmux
   * consults - TMUX_TMPDIR is; reading TMPDIR silently missed every socket
   * on macOS, where TMPDIR is a per-user /var/folders path.
   */
  cleanSocket(socket: string): Promise<void> {
    return Bun.file(tmuxSocketPath(socket))
      .unlink()
      .catch(() => {});
  }
```

`tmuxSocketPath` is a module-level export in the same file - call it directly.

- [ ] **Step 4: Update the six test call sites (P2)**

The return type changed under them: each bare call becomes a floating promise
AND loses the (never-real, but assumed) ordering guarantee that the unlink ran
before the test moved on. Match each file's local style, which is already
visible at `local-launcher.test.ts:20-22`: the file's own convention for an
ignored fire-and-forget is `void` on the neighboring call (`void
Bun.file(...).unlink().catch(...)`, three lines below the bare
`tmux.cleanSocket(socket)`). So: prefix the bare five in
`local-launcher.test.ts` and the one in `commands-launch.test.ts` with `void `
where they sit in a synchronous callback, and use `await` where the enclosing
hook is already `async` and a later assertion depends on the unlink (check the
next three lines of each site; where nothing reads the socket afterward,
`void` is honest and `await` is noise).

- [ ] **Step 5: Verify at the right scope**

Run: `cd packages/pane-runtime && bun test` (the new test plus the package),
then the repo-root trio, because this task touched TS in three packages:
`bun run verify-types && bun run lint:check && bun run test`. Expected: all
pass - the two touched test files run inside the root `test`, which is the
gate that sees all six call sites.

- [ ] **Step 6: Commit**

```bash
git add packages/pane-runtime/src apps/server/api/src/services/nodes/__tests__/local-launcher.test.ts apps/node/agent/src/__tests__/commands-launch.test.ts
git commit -m "fix(pane-runtime): cleanSocket resolves the socket path the way tmux does

TMPDIR is not the variable tmux reads; TMUX_TMPDIR is, and on macOS the
difference is a per-user /var/folders path with no sockets in it, so the
unlink has been silently missing forever (best-effort hid it).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: server - `status --json` reports where its data lives

Spec § 8. Reset deletes only locations the CLI itself reports; the status body today reports `configEnv.path` but not the data dir, database, logs, or artifacts. Additive field, same "ONE fact, ONE spelling" rule as the rest of `StatusView`.

**Files:**
- Modify: `apps/server/api/src/commands/status.ts` (`StatusView` near line 88, `collectStatus` where it builds the view)
- Test: `apps/server/api/src/__tests__/cli-commands.test.ts` (extend, following its existing `status --json` invocation style)

**Interfaces:**
- Produces: `StatusView.paths: { dataDir: string; database: string; logsDir: string; nodeArtifacts: string }`, all absolute (the constants are already resolved absolutes; `subshellLogDir()` is `${SUBSHELL_SERVER_DATA_DIR}/subshells`).

- [ ] **Step 1: Write the failing test**

Follow whatever pattern the existing status tests use to run the command and parse stdout. The new case asserts (exact wiring per the file's existing helper style):

```ts
  it("paths reports the four resolved data locations", async () => {
    const view = /* however the file already invokes collectStatus / status --json */;
    expect(Object.keys(view.paths).sort()).toEqual(["dataDir", "database", "logsDir", "nodeArtifacts"]);
    expect(isAbsolute(view.paths.dataDir)).toBe(true);
    expect(view.paths.dataDir).toBe(SUBSHELL_SERVER_DATA_DIR);
    expect(view.paths.database).toBe(DATABASE_PATH);
    expect(view.paths.logsDir).toBe(`${SUBSHELL_SERVER_DATA_DIR}/subshells`);
    // Already a StatusView fact: the paths block must not be a second source.
    expect(view.paths.nodeArtifacts).toBe(view.nodeArtifacts.dir);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server/api && bun test src/__tests__/cli-commands.test.ts` - expected: FAIL (`view.paths` undefined).

- [ ] **Step 3: Implement**

In `StatusView`, after `configEnv`:

```ts
  /**
   * The four absolute locations instance data lives at, as THIS process
   * resolved them. `status` is the authority on where the server's data is -
   * the desktop app's reset deletes exactly these and nothing else, which is
   * why they travel as data instead of being re-derived elsewhere. Read-only,
   * like everything here; presence with an unusable value is impossible
   * because these are already-resolved constants.
   */
  paths: { dataDir: string; database: string; logsDir: string; nodeArtifacts: string };
```

In `collectStatus`, alongside the existing `configEnv` entry:

```ts
    paths: {
      dataDir: SUBSHELL_SERVER_DATA_DIR,
      database: DATABASE_PATH,
      logsDir: subshellLogDir(),
      nodeArtifacts: NODE_ARTIFACTS_DIR,
    },
```

(Import `SUBSHELL_SERVER_DATA_DIR`, `DATABASE_PATH` from `@/constants.js` and `subshellLogDir` from `@/services/nodes/subshell-paths.js`; `NODE_ARTIFACTS_DIR` is already imported. The text view does NOT need a new line - a human reading `status` gains nothing from four paths; only the machine consumer asked. If a test pins the exact text output, it stays green by construction.)

- [ ] **Step 4: Run the suite pieces + full verification**

Run: `cd apps/server/api && bun test src/__tests__/cli-commands.test.ts`, then from the repo root `bun run verify-types && bun run lint:check && bun run test` - expected: all pass. (No `turbo build` needed: `status --json` is CLI output, not a route response, so `backend-client`'s inferred types are untouched - spec § 8's licence note explains why no crossing moves either.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/commands/status.ts apps/server/api/src/__tests__/cli-commands.test.ts
git commit -m "feat(server): status --json reports the data paths, for the machine that reads it

Additive block: dataDir, database, logsDir, nodeArtifacts, each the
resolved absolute constant this process booted with. The desktop app's
reset will delete exactly what this says and refuse when it cannot say.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: app Rust - probe carries `onboarded` and `hostname`, setup takes the addresses

Spec §§ 4, 5, 7.1. Everything the wizard page decides from, delivered on the probe it already polls, plus the marking function § 4 R16 named, the pure `boot_window` R6 asked for, and the `desktop_setup` address payload.

**Files:**
- Modify: `apps/server/desktop/src-tauri/src/control.rs` (Probe struct ~28-170, `desktop_probe` ~261, `desktop_setup`/`SetupStep` ~388-455)
- Modify: `apps/server/desktop/ui/src/lib/ipc.ts` (Probe interface, `setup`)

**Interfaces:**
- Produces:
  - `Probe { …, onboarded: bool, hostname: String }` (JSON camelCase)
  - `pub fn machine_hostname() -> String` (OnceLock memo, `hostname` spawn through `proc`, trimmed)
  - `pub fn mark_onboarded(next: ProbeStep, settings: &SettingsState)`
  - `pub fn boot_probe(settings: &SettingsState) -> Probe` (probe_now + mark; the boot path's one call)
  - `#[derive(PartialEq, Debug)] pub enum WindowChoice { Wizard, Console }` + `pub fn boot_window(p: &Probe) -> WindowChoice`
  - `desktop_setup(settings, port: Option<String>, host: Option<String>, base_url: Option<String>, trusted_origins: Option<String>)`
  - TS: `ipc.setup(payload?: InitPayload)`, `Probe.onboarded: boolean`, `Probe.hostname: string`

- [ ] **Step 1: Write the failing Rust tests** (append to the existing `mod tests` in `control.rs`, matching the `probe_with` fixture style already there)

```rust
    #[test]
    fn boot_window_picks_console_on_a_ready_probe_even_before_marking() {
        // The R6 case: a machine set up entirely from the CLI stores
        // onboarded:false, and the FIRST probe is what corrects it. Boot must
        // branch on the probe's answer, so a ready probe names Console no
        // matter what the field carried a moment ago.
        let mut p = Probe::default();
        p.next = ProbeStep::Ready;
        p.onboarded = true; // as mark_onboarded would have set it before boot_window runs
        assert_eq!(boot_window(&p), WindowChoice::Console);
        let mut virgin = Probe::default();
        virgin.next = ProbeStep::Setup;
        assert_eq!(boot_window(&virgin), WindowChoice::Wizard);
    }

    #[test]
    fn probe_serializes_onboarded_and_hostname_for_the_page() {
        let mut p = Probe::default();
        p.onboarded = true;
        p.hostname = "devbox".into();
        let v: serde_json::Value = serde_json::to_value(&p).unwrap();
        assert_eq!(v["onboarded"], serde_json::json!(true));
        assert_eq!(v["hostname"], serde_json::json!("devbox"));
    }

    #[test]
    fn hostname_is_trimmed_and_non_empty_here() {
        // Memo + trim contract; the value itself is the machine's business.
        let h = machine_hostname();
        assert!(!h.is_empty());
        assert_eq!(h, h.trim(), "the compared string must be exactly what the screen shows");
        assert!(!h.contains('\n'));
    }

    #[test]
    fn setup_payload_maps_through_the_same_init_args_as_init() {
        // R4 of the chain contract: a setup press that carried wizard edits
        // writes exactly what the init form would have written.
        let args = init_args("4100", "0.0.0.0", "http://x:4100", Some("http://lan"));
        assert!(args.contains(&"--port".to_string()) && args.contains(&"4100".to_string()));
        let empty = init_args("", "", "", None);
        assert!(!empty.iter().any(|a| a.starts_with("--port")), "omitted flags fall back to derived defaults");
    }
```

- [ ] **Step 2: Run to verify failure**

Run `bun run rust:check` from the repo root - expected: compile errors on the new names.

- [ ] **Step 3: Implement in `control.rs`**

Add fields to `Probe` (end of struct + `Default`):

```rust
    /// Whether this app has ever watched a server on this machine reach
    /// `ready`. Boot branches on it (via boot_window, after marking, never on
    /// the stored value alone), and the page reads it off the probe rather
    /// than owning a second source of the fact.
    pub onboarded: bool,
    /// The machine's hostname: the string the reset screen shows, asks to be
    /// typed, and compares against - one read, memoized, never re-derived on
    /// the other side of the boundary (spec § 7.1, R15).
    pub hostname: String,
```

Add, near `console_platform`:

```rust
/// The machine's hostname, read once per process. `libc::gethostname` was
/// declined (libc is no direct dependency of either crate; spec § 7.1), and
/// `hostname(1)` is one bounded spawn through the discipline every other
/// subprocess already uses. Memoized because a running machine does not
/// rename itself, and the memo is the SINGLE source: the displayed value and
/// the checked value are the same read by construction (R15).
pub fn machine_hostname() -> String {
    static HOSTNAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HOSTNAME
        .get_or_init(|| {
            // The module's own spawn helper (the one desktop_install_agent
            // uses for `sh -c`), which injects the login PATH and bounds the
            // wait; /bin/hostname needs no PATH help but pays no cost for it.
            run(&vec!["hostname".to_string()], ACTION_TIMEOUT)
                .stdout
                .trim()
                .to_string()
        })
        .clone()
}
```

```rust
/// Mark `onboarded` once a probe has seen `ready`. One function by name,
/// called by the probe command and by boot (R16); `probe_now` stays pure.
pub fn mark_onboarded(next: ProbeStep, settings: &SettingsState) {
    if next != ProbeStep::Ready {
        return;
    }
    if settings.get().onboarded {
        return;
    }
    // A failed write here is survivable: the cost is opening the wizard once
    // more on next boot, which the page renders as facts already met.
    let _ = settings.update(|s| s.onboarded = true);
}

/// Boot's probe: look at the machine, mark what it proves, return the answer
/// the window choice is made from. The write-in-read is deliberate and is
/// documented at the call site in lib.rs.
pub fn boot_probe(settings: &SettingsState) -> Probe {
    let p = probe_now(settings.get().binary_path.as_deref());
    mark_onboarded(p.next, settings);
    p
}

/// Which window boot opens, as a pure decision over the post-mark probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowChoice {
    Wizard,
    Console,
}

pub fn boot_window(p: &Probe) -> WindowChoice {
    if p.onboarded {
        WindowChoice::Console
    } else {
        WindowChoice::Wizard
    }
}
```

In `desktop_probe`, after computing `p`: `mark_onboarded(p.next, &settings);` before returning (and set the two new fields on the value `probe_now` builds - add `onboarded: settings.get().onboarded` is NOT available inside `probe_now`; set both in the command wrapper AFTER the call, `let mut p = …; p.onboarded = settings.get().onboarded; p.hostname = machine_hostname();` then mark, then re-read `p.onboarded = true` if the mark happened - simplest correct shape:

```rust
#[tauri::command(async)]
pub fn desktop_probe(app: AppHandle, settings: State<'_, SettingsState>) -> Probe {
    let mut p = probe_now(settings.get().binary_path.as_deref());
    crate::tray::set_server_ready(&app, p.next == ProbeStep::Ready);
    p.hostname = machine_hostname();
    p.onboarded = settings.get().onboarded;
    if p.next == ProbeStep::Ready && !p.onboarded {
        mark_onboarded(p.next, &settings);
        p.onboarded = true;
    }
    p
}
```

and give `probe_now` the two fields as `false` / `machine_hostname()` defaults so the struct literal compiles (the Default impl gains `onboarded: false, hostname: String::new()`). `boot_probe` likewise fills both from the same helpers; `boot_window` sees the marked value.

`desktop_setup` / `SetupStep::Init` payload:

```rust
#[tauri::command(async)]
pub fn desktop_setup(
    settings: State<'_, SettingsState>,
    port: Option<String>,
    host: Option<String>,
    base_url: Option<String>,
    trusted_origins: Option<String>,
) -> Result<ActionResult, String> {
```

thread the four into `SetupStep::run` (change its signature to `run(self, settings, &SetupAddresses { port, host, base_url, trusted_origins })` or pass an `init_args`-shaped tuple) so `SetupStep::Init => Ok(init_now(settings, a.port.as_deref().unwrap_or_default(), …, a.trusted_origins))`. Document at the signature: *None for every field is today's derived-defaults chain, byte for byte; the wizard sends the addresses the operator chose in its Addresses step, and the empty-string-vs-None rules are `init_args`' existing ones.*

- [ ] **Step 4: Mirror in `ui/src/lib/ipc.ts`**

Add to `interface Probe`:

```ts
  /** Whether this machine's setup has reached `ready` at least once (§ 4). */
  onboarded: boolean;
  /** The hostname the reset screen shows, types for, and compares (R15). */
  hostname: string;
```

Change `setup`:

```ts
/** The one-press chain; the address fields are the wizard's Addresses step, absent means derived defaults. */
export const setup = (payload?: InitPayload): Promise<ActionResult> =>
  invoke<ActionResult>("desktop_setup", payload ?? {});
```

- [ ] **Step 5: Verify**

Run: `bun run rust:check` from the repo root, then `cd apps/server/desktop && bun run test && bun run verify-types`. Expected: all green (the existing `ipc-acl` console==ipc.ts pin is unaffected: no command names changed).

- [ ] **Step 6: Commit**

```bash
git add apps/server/desktop/src-tauri/src/control.rs apps/server/desktop/ui/src/lib/ipc.ts
git commit -m "feat(desktop-server): the probe carries onboarded and hostname; setup takes the wizard's addresses

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: `lib/wizard-state.ts` - the wizard's decisions, pure

Spec § 5. Every judgment the wizard page makes, written where it can be tested without a webview (the `config-form.ts` / `installers.ts` pattern).

**Files:**
- Create: `apps/server/desktop/ui/src/lib/wizard-state.ts`
- Test: `apps/server/desktop/ui/src/__tests__/wizard-state.test.ts`

**Interfaces:**
- Consumes: `Probe`, `ProbeStep` from `./ipc`.
- Produces:

```ts
export type WizardStepId = "welcome" | "prerequisites" | "addresses" | "agents" | "run" | "done";
export type PrereqState = "found" | "install" | "manual";
export interface RunRow {
  id: "server" | "config" | "service" | "running";
  label: string;
  done: boolean;
}
export function firstOpenStep(probe: Probe): WizardStepId;
export function prereqState(probe: Probe): PrereqState;
export function runRows(probe: Probe): RunRow[];
export function canContinue(step: WizardStepId, probe: Probe | null, busy: boolean): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "bun:test";
import type { Probe } from "../lib/ipc";
import { canContinue, firstOpenStep, prereqState, runRows } from "../lib/wizard-state";

/** A virgin machine: nothing found, one bundled. */
const virgin = (over: Partial<Probe> = {}): Probe =>
  ({
    bundledVersion: "1.2.3",
    server: null,
    managed: false,
    status: null,
    service: null,
    serverChoice: "install-bundled",
    next: "setup",
    error: null,
    tmux: null,
    platform: "linux",
    hasBrew: false,
    onboarded: false,
    hostname: "box",
    ...over,
  }) as Probe;

describe("firstOpenStep", () => {
  it("starts a virgin machine at welcome", () => expect(firstOpenStep(virgin())).toBe("welcome"));
  it("resumes past tmux once it answers", () =>
    expect(firstOpenStep(virgin({ tmux: "/usr/bin/tmux" }))).toBe("addresses"));
  it("resumes past addresses once config exists", () =>
    expect(
      firstOpenStep(virgin({ tmux: "/t", next: "install-service", status: { configEnv: { path: "/c", exists: true } } as Probe["status"] })),
    ).toBe("run"));
});

describe("prereqState", () => {
  it("found when tmux answers", () => expect(prereqState(virgin({ tmux: "/usr/bin/tmux" }))).toBe("found"));
  it("install where a plan exists", () => {
    expect(prereqState(virgin())).toBe("install"); // linux has a pkexec plan
    expect(prereqState(virgin({ platform: "darwin", hasBrew: true }))).toBe("install");
  });
  it("manual where it does not", () => expect(prereqState(virgin({ platform: "darwin", hasBrew: false }))).toBe("manual"));
});

describe("runRows", () => {
  it("ticks from facts, never optimism", () => {
    const rows = runRows(virgin({ server: { argv: ["/x"], source: "local-bin", version: "1" }, tmux: "/t" }));
    expect(rows.map((r) => r.done)).toEqual([true, false, false, false]);
  });
  it("all four ticked at ready", () => {
    const p = virgin({
      tmux: "/t",
      next: "ready",
      server: { argv: ["/x"], source: "local-bin", version: "1" },
      status: { configEnv: { path: "/c", exists: true } } as Probe["status"],
      service: { installed: true, state: "running" } as Probe["service"],
    });
    expect(runRows(p).every((r) => r.done)).toBe(true);
  });
});

describe("canContinue", () => {
  it("gates the wizard only where the CLI will", () => {
    expect(canContinue("prerequisites", virgin(), false)).toBe(false); // no tmux
    expect(canContinue("prerequisites", virgin({ tmux: "/t" }), false)).toBe(true);
    expect(canContinue("addresses", virgin(), false)).toBe(true); // the step asks for nothing
    expect(canContinue("run", virgin(), true)).toBe(false); // busy is busy
    expect(canContinue("run", virgin({ tmux: "/t", server: { argv: ["/x"], source: "path", version: "1" } }), false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** - `cd apps/server/desktop && bun test ui/src/__tests__/wizard-state.test.ts` (import error).

- [ ] **Step 3: Implement**

```ts
/**
 * The first-run wizard's decisions, pure (§ 5 of the spec).
 *
 * Page state (which step the human navigated to) is deliberately NOT here:
 * only the facts a probe licenses, so the same functions decide on a reopen
 * after a quit, a crash, or a machine changed from a terminal.
 */
import type { Probe } from "./ipc";

export type WizardStepId = "welcome" | "prerequisites" | "addresses" | "agents" | "run" | "done";

export type PrereqState =
  /** tmux answers. */
  | "found"
  /** missing, and the platform has an installer this app may run */
  | "install"
  /** missing, and the honest answer is docs plus the poll */
  | "manual";

const STEP_ORDER: WizardStepId[] = ["welcome", "prerequisites", "addresses", "agents", "run", "done"];

export function prereqState(probe: Probe): PrereqState {
  if (probe.tmux) return "found";
  // The same two facts tmuxInstallPlan branches on, so "install" always
  // means the button this step renders can actually be pressed.
  if (probe.platform === "darwin") return probe.hasBrew ? "install" : "manual";
  return "install"; // the linux plan is a package-manager search; installers.ts owns the truth
}

export function firstOpenStep(probe: Probe): WizardStepId {
  // Resume where the facts say the human is: each rung already met is not a
  // step to walk again. Agents never "complete" (optional), so it is only
  // ever landed on, never skipped past by a fact.
  if (probe.next === "ready") return "done";
  if (!probe.tmux) {
    // No tmux: welcome only for a machine nothing has touched yet; a
    // half-run machine resumes at the gate that actually binds it.
    return probe.server === null && probe.status === null ? "welcome" : "prerequisites";
  }
  if (!probe.status?.configEnv?.exists) return "addresses";
  return "run";
}

export interface RunRow {
  id: "server" | "config" | "service" | "running";
  label: string;
  done: boolean;
}

export function runRows(probe: Probe): RunRow[] {
  // Ticked from probe facts, never from the command's progress: the chain
  // runs in Rust, and the same facts that drive probe.next are the ones the
  // rows show (spec § 5's table).
  return [
    { id: "server", label: "Server installed", done: probe.server !== null },
    { id: "config", label: "Configuration written", done: probe.status?.configEnv?.exists === true },
    { id: "service", label: "Service registered", done: probe.service?.installed === true },
    { id: "running", label: "Server running", done: probe.next === "ready" },
  ];
}

export function canContinue(step: WizardStepId, probe: Probe | null, busy: boolean): boolean {
  if (probe === null) return false; // no facts, no claims
  if (busy) return false;
  switch (step) {
    case "welcome":
      return true;
    case "prerequisites":
      return probe.tmux !== null;
    case "addresses":
    case "agents":
      return true;
    case "run":
      // The chain's one hard stop. Install is step one of the chain itself,
      // so a missing server is not a reason to bar the press; a missing tmux
      // is (init and service install both refuse without it), and that is
      // the only gate. One condition, no cleverness: a guard that is wrong
      // in no case beats a ternary nobody can read.
      return probe.tmux !== null;
    case "done":
      return probe.next === "ready";
  }
}

export const STEP_LABELS: Record<WizardStepId, string> = {
  welcome: "Welcome",
  prerequisites: "Prerequisites",
  addresses: "Addresses",
  agents: "Agents",
  run: "Set up",
  done: "Done",
};

export { STEP_ORDER };
```

The `canContinue("run")` test above covers exactly two cases: no tmux blocks, tmux does not. If the implementation ever grows a third condition, the test grows with it or the condition does not ship.

- [ ] **Step 4: Verify** - same bun command passes; then `cd apps/server/desktop && bun run verify-types`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop/ui/src/lib/wizard-state.ts apps/server/desktop/ui/src/__tests__/wizard-state.test.ts
git commit -m "feat(desktop-server): the wizard's decisions, pure and pinned

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: The wizard window, and boot choosing it

Spec §§ 3, 5. The page, the Vite input, the window, the boot branch, the manage-window routing, the capability file, and the ACL test's promotion to per-page sets.

**Files:**
- Create: `apps/server/desktop/ui/wizard.html`, `apps/server/desktop/ui/src/wizard.ts`
- Modify: `apps/server/desktop/vite.config.ts` (build block), `src-tauri/src/windows.rs` (wizard builder + `open_manage_window`), `src-tauri/src/lib.rs` (setup branch, single-instance/Reopen fallbacks), `src-tauri/capabilities/wizard.json` (new)
- Test: `ui/src/__tests__/ipc-acl.test.ts` (per-page sets), `ui/src/__tests__/tauri-config.test.ts` (second input pinned)

**Interfaces:**
- Consumes: `boot_probe`, `boot_window`, `WindowChoice` (Task 4); `wizard-state` (Task 5); ipc functions incl. `openConsole` (added here).
- Produces: window label `wizard` loading `wizard.html`; `ipc.openConsole()`; `windows::open_wizard(app)`, `windows::open_manage_window(app)`; capability id `wizard` granting exactly the wizard's set.

- [ ] **Step 1: Failing pins in the two existing test files**

`tauri-config.test.ts` add:

```ts
  it("builds the wizard page beside the console, CSP-clean by the same rules", () => {
    expect(viteConfig).toContain('wizard: path.resolve(dirname, "ui/wizard.html")');
    expect(existsSync(join(import.meta.dir, "../../wizard.html"))).toBe(true);
    const wizard = readFileSync(join(import.meta.dir, "../../wizard.html"), "utf8");
    expect(wizard).not.toMatch(/<script(?![^>]*\bsrc=)/); // module script only
    expect(wizard).not.toMatch(/style=/);
    expect(wizard).toContain('src="/src/wizard.ts"');
  });
```

`ipc-acl.test.ts`: rework the console-equality check into a per-entry-page check. Keep the existing helpers; add:

```ts
/** The ipc.ts functions a page file calls, mapped to command names. */
function commandsInvokedBy(pageFile: string): Set<string> {
  const nameToCommand = new Map<string, string>();
  const decl = /export const (\w+)\s*=[^;]*?invoke\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"/g;
  for (const m of ipcSource.matchAll(decl)) {
    nameToCommand.set(m[1] as string, m[2] as string);
  }
  const src = codeOf(join(UI_SRC, pageFile)); // codeOf takes a PATH and strips comments itself
  const out = new Set<string>();
  for (const m of src.matchAll(/\bipc\.(\w+)\s*\(/g)) {
    const cmd = nameToCommand.get(m[1] as string);
    if (cmd) out.add(cmd);
  }
  return out;
}
```

Then the assertions: `commandsInvokedBy("main.ts")` equals console.json's `allow-desktop-*` grants; `commandsInvokedBy("wizard.ts")` equals wizard.json's grants; main.json stays exactly its three + dragging (existing pin, unchanged).

And widen the two existing union assertions (P1; without this the wizard's legitimate grants fail checks that predate it, in a way that reads like a permissions bug): "names no permission the manifest does not define" and "defines no app permission neither capability grants" each hardcode `console.json + main.json`; both unions gain `capabilityPermissions("wizard.json")`.

Run: `cd apps/server/desktop && bun test ui/src/__tests__/` - expect the two new pins to FAIL.

- [ ] **Step 2: Vite input** - in `vite.config.ts` `build`:

```ts
    rollupOptions: {
      // Two bundled pages, two windows: the console (index.html) and the
      // first-run wizard. Tauri resolves each by name against the dev server
      // in dev and the bundle in prod (WebviewUrl::App), so the pair must
      // both be inputs or one window loads the other's page in a release
      // build, silently.
      input: {
        index: path.resolve(dirname, "ui/index.html"),
        wizard: path.resolve(dirname, "ui/wizard.html"),
      },
    },
```

- [ ] **Step 3: `ui/wizard.html`**

```html
<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subshell Server – Setup</title>
  </head>
  <body>
    <h1 class="m-0 mb-0.5 text-[17px] font-semibold tracking-[0.01em]">Set up Subshell Server</h1>
    <div id="rail" class="rail mb-3" aria-label="Setup progress"></div>
    <div class="mb-3 rounded-[10px] border border-line bg-card px-4 py-3.5">
      <p class="mb-2.5 text-sm text-warn empty:hidden" id="problem"></p>
      <div id="screen"></div>
      <div class="mt-3 flex flex-wrap items-center gap-2" id="screen-actions"></div>
    </div>
    <div class="mb-3 rounded-[10px] border border-line bg-card px-4 pb-3.5 pt-2.5" id="output-card" hidden>
      <pre class="pane-pre" id="output" aria-live="polite"></pre>
    </div>
    <script type="module" src="/src/wizard.ts"></script>
  </body>
</html>
```

Add to `ui/src/styles.css`: a `.rail` (horizontal step list: label + dot, `.done`, `.current`, `.locked` states, muted text), `.row-done` (green tick line), `.row-pending`, `.wizard-copy p { margin: 0 0 8px; }`. Match the file's existing custom-property vocabulary (`--color-ok`, `--color-muted`, etc.) - read its `@theme` block first.

- [ ] **Step 4: `ui/src/wizard.ts`** (full implementation, DOM only; decisions come from `wizard-state`)

```ts
/**
 * The first-run wizard (spec § 5): decisions are steps, machine work is
 * progress. DOM only; every judgment is imported from wizard-state, where it
 * is tested without a webview. Shares lib/ with the console on purpose:
 * prefill, install plans and the IPC edge are one contract, not two.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CONFIG_FIELDS,
  configPayload,
  derivedBaseUrl,
  effectiveForm,
  explicitFields,
  fieldProblems,
  type ExplicitMap,
  type FormValues,
} from "./lib/config-form";
import * as ipc from "./lib/ipc";
import type { Probe } from "./lib/ipc";
import { agentInstallPlan, tmuxInstallPlan } from "./lib/installers";
import {
  canContinue,
  firstOpenStep,
  prereqState,
  runRows,
  STEP_LABELS,
  STEP_ORDER,
  type WizardStepId,
} from "./lib/wizard-state";
import "./styles.css";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the wizard page is missing #${id}`);
  return node;
};

let probe: Probe | null = null;
let busy = false;
let problem = "";
let step: WizardStepId = "welcome";
/** Run is the only screen with a live checklist; its fast tick runs only then. */
let running = false;
let form: FormValues = effectiveForm(undefined);
let explicit: ExplicitMap = {};
/** Agents rows remember what this session installed (the probe cannot see CLIs). */
const agentInstalled = new Set<string>();

const AGENTS: { id: string; name: string; blurb: string }[] = [
  { id: "claude-code", name: "Claude Code", blurb: "Anthropic's agent CLI." },
  { id: "codex", name: "Codex", blurb: "OpenAI's agent CLI." },
  { id: "hermes", name: "Hermes", blurb: "Nous Research's agent CLI." },
  { id: "opencode", name: "OpenCode", blurb: "Open-source agent CLI." },
  { id: "pi", name: "Pi", blurb: "Pi's agent CLI." },
];

function setProblem(err: unknown): void {
  problem = err instanceof Error ? err.message : String(err);
}

async function refresh(): Promise<void> {
  probe = await ipc.probe();
  problem = probe.error ?? "";
}

function button(label: string, handler: () => unknown, primary = false, disabled = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  b.disabled = disabled || busy;
  b.addEventListener("click", handler);
  return b;
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "wizard-copy";
  p.textContent = text;
  return p;
}

function bulletList(items: string[]): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "wizard-copy list-disc pl-5";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.append(li);
  }
  return ul;
}

function renderRail(): void {
  const rail = el("rail");
  rail.textContent = "";
  for (const id of STEP_ORDER) {
    const s = document.createElement("span");
    const state = id === step ? "current" : probe !== null && stepIndex(id) < stepIndex(step) ? "done" : "locked";
    s.className = `rail-step ${state}`;
    s.textContent = STEP_LABELS[id];
    rail.append(s);
  }
}

const stepIndex = (id: WizardStepId): number => STEP_ORDER.indexOf(id);

function renderWelcome(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph("Subshell runs agent sessions in terminal panes you can watch from any browser. This sets up a control plane on this machine: the server, its settings, and a background service that keeps them running."),
    paragraph("Pressing Get started consents to all of this:"),
    bulletList([
      "Installs the bundled subshell-server to ~/.local/bin/subshell-server. Nothing is downloaded.",
      "Writes ~/.config/subshell-server/config.env (port 3080, all interfaces, unless you change them).",
      "Registers it to start at login (a systemd user unit on Linux, a launchd agent on macOS).",
      "Starts it and opens the dashboard.",
    ]),
  );
  actions.append(button("Get started", () => go("prerequisites"), true));
}

function renderPrerequisites(screen: HTMLElement, actions: HTMLElement): void {
  if (probe === null) return;
  const p = probe;
  const state = prereqState(p);
  if (p.tmux !== null) {
    screen.append(paragraph(`tmux found at ${p.tmux}. The server launches every pane through it.`));
  } else {
    screen.append(paragraph("tmux is not installed yet. The server launches every pane through it, so setup needs it before anything else can run."));
    if (state === "install") {
      const plan = tmuxInstallPlan(p.platform, p.hasBrew);
      if (plan.kind === "run") {
        actions.append(button(plan.label, () => runGuarded(() => ipc.installTmux()), true));
      } else {
        const code = document.createElement("code");
        code.textContent = plan.command.join(" ");
        screen.append(paragraph("This machine has no package manager this app may drive. In a terminal:"), code);
        if (plan.docsUrl !== "") {
          actions.append(button("Read the tmux docs", () => void ipc.openTmuxDocs().catch(setProblem)));
        }
      }
    }
    screen.append(paragraph("The Next button unlocks the moment tmux appears. This page rechecks on its own; installing in a terminal works too."));
  }
  if (p.serverChoice === "no-bundled") {
    screen.append(paragraph("This build ships no server binary, so point the app at one:"));
    actions.append(button("Choose an existing server...", () => pickBinary(), true));
  }
  actions.append(
    button("Next", () => go("addresses"), p.tmux !== null || p.serverChoice === "no-bundled"),
  );
  if (stepIndex(step) > stepIndex("prerequisites")) return;
}

function renderAddresses(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph("Port and addresses. The defaults are right for most machines; change anything here or press Continue."),
  );
  const seeded = effectiveForm(probe?.status?.settings);
  for (const { name } of CONFIG_FIELDS) form[name] = form[name] || seeded[name];
  for (const [name, on] of Object.entries(explicitFields(probe?.status?.settings)) as [keyof ExplicitMap, boolean][]) {
    if (on) explicit[name] = true;
  }
  const grid = document.createElement("div");
  grid.className = "grid w-full grid-cols-2 gap-2.5";
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
    });
    cell.append(label, input);
    for (const problem of fieldProblems(probe?.status?.settings, field.name)) {
      const warn = document.createElement("p");
      warn.className = "hint warn-text";
      warn.textContent = problem.reason;
      cell.append(warn);
    }
    grid.append(cell);
  }
  screen.append(grid);
  actions.append(button("Back", () => go("prerequisites")));
  actions.append(button("Continue", () => go("agents"), true));
}

function renderAgents(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(paragraph("Install an agent CLI (optional). You can install several, or none: subshells can run a plain terminal right now, with nothing to install, and an agent can be added any time later."));
  for (const agent of AGENTS) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-3 py-1.5";
    const text = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = agent.name;
    const blurb = document.createElement("span");
    blurb.className = "text-sm text-muted";
    blurb.textContent = ` - ${agent.blurb}`;
    text.append(name, blurb);
    row.append(text);
    if (agentInstalled.has(agent.id)) {
      const done = document.createElement("span");
      done.className = "ok-text";
      done.textContent = "Installed";
      row.append(done);
    } else {
      const plan = agentInstallPlan(agent.id);
      if (plan !== null) {
        row.append(button("Install", () => runGuarded(async () => {
          const r = await ipc.installAgent(agent.id);
          if (r.ok) agentInstalled.add(agent.id);
          return r;
        }, false)));
      }
    }
    screen.append(row);
  }
  actions.append(button("Back", () => go("addresses")));
  actions.append(button("Continue", () => go("run"), true));
}

function renderRun(screen: HTMLElement, actions: HTMLElement): void {
  if (probe === null) return;
  screen.append(paragraph("This is what will run:"), bulletList([
    "Install the bundled server to ~/.local/bin/subshell-server",
    "Write ~/.config/subshell-server/config.env with the addresses from the previous step",
    "Register it to start at login, and start it",
  ]));
  const rows = runRows(probe);
  for (const row of rows) {
    const line = document.createElement("p");
    line.className = row.done ? "row-done" : "row-pending";
    line.textContent = `${row.done ? "[done]" : "[ .. ]"} ${row.label}`;
    screen.append(line);
  }
  const allDone = rows.every((r) => r.done);
  if (!allDone) {
    actions.append(button("Back", () => go("agents")));
    actions.append(
      button("Set up and start", () => startSetup(), true, !canContinue("run", probe, busy)),
    );
    if (probe.tmux === null) {
      screen.append(paragraph("tmux is still missing; the prerequisites step explains why the button waits."));
    }
  } else {
    go("done");
  }
}

function renderDone(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph("Subshell is running on this machine. The dashboard's own wizard will walk through creating your account."),
  );
  actions.append(
    button("Open dashboard", () => void runGuarded(async () => {
      await ipc.openMain();
      return null;
    }, true), true),
  );
  actions.append(button("Go to status page", () => void ipc.openConsole().catch(setProblem)));
}

function go(next: WizardStepId): void {
  step = next;
  render();
}

async function startSetup(): Promise<void> {
  running = true;
  render();
  try {
    const result = await ipc.setup(configPayload(form, explicit));
    showOutput(result);
  } catch (err) {
    setProblem(err);
  } finally {
    running = false;
  }
  await refresh().catch(setProblem);
  render();
}

async function pickBinary(): Promise<void> {
  const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
  if (!chosen) return;
  try {
    await ipc.setServerBin(chosen);
    await refresh().catch(setProblem);
  } catch (err) {
    setProblem(err);
  }
  render();
}

function showOutput(result: ipc.ActionResult | null): void {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  el("output").textContent = parts.join("\n\n");
  el("output-card").hidden = parts.length === 0;
}

async function runGuarded(fn: () => Promise<ipc.ActionResult | null | unknown>, settle = false): Promise<void> {
  if (busy) return;
  busy = true;
  problem = "";
  showOutput(null);
  render();
  try {
    const r = await fn();
    if (r !== null && typeof r === "object" && "stdout" in r) showOutput(r as ipc.ActionResult);
  } catch (err) {
    setProblem(err);
  }
  await refresh().catch(setProblem);
  if (settle) {
    for (let i = 0; i < 2 && probe?.next !== "ready"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refresh().catch(setProblem);
    }
  }
  busy = false;
  render();
}

function render(): void {
  el("problem").textContent = problem;
  renderRail();
  const screen = el("screen");
  const actions = el("screen-actions");
  screen.textContent = "";
  actions.textContent = "";
  if (probe === null) {
    screen.append(paragraph("Checking this machine..."));
    return;
  }
  const views: Record<WizardStepId, (s: HTMLElement, a: HTMLElement) => void> = {
    welcome: renderWelcome,
    prerequisites: renderPrerequisites,
    addresses: renderAddresses,
    agents: renderAgents,
    run: renderRun,
    done: renderDone,
  };
  views[step](screen, actions);
}

// One interval at 1500 ms: faster than a person reaches for a button, slow
// enough that the CLI spawns behind each probe stay invisible, and single-
// speed on purpose - a reschedulable timer is a second mechanism for no gain.
async function tick(): Promise<void> {
  if (busy || (document.hidden && !running)) return;
  try {
    await refresh();
  } catch {
    return;
  }
  render();
}

void (async () => {
  try {
    await refresh();
    step = firstOpenStep(probe as Probe);
  } catch (err) {
    setProblem(err);
  }
  render();
  setInterval(() => void tick(), 1500);
})();
```

Notes for the implementer, each resolving something the file will show you: `running` stays in use only for the skip-while-hidden carve-out (a Run in flight must keep polling even backgrounded, because its settle waits ride the probe) and for nothing else; `busy` alone throttles the interval, matching the console's single-flight discipline. Confirm `agentInstallPlan`'s real export signature in `lib/installers.ts` before wiring the agent buttons (this plan uses `id -> { kind: "run"; command } | null`, which is what the file's `agentInstallPlan(id)` returns today). The `configPayload`/`explicitFields` imports mirror `main.ts`'s usage exactly; if `main.ts` names any of these differently, follow `main.ts` and update the wizard-state test's import list, not the contract.

Also add to `ui/src/lib/ipc.ts` (this is where the command gains its second caller; main.json is untouched, the wizard's own capability file does the granting):

```ts
/** Raise the status console from the wizard's Done screen (granted to `wizard`, never to `console` itself). */
export const openConsole = (): Promise<void> => invoke<void>("desktop_open_console");
```

- [ ] **Step 5: Rust window + capability**

`windows.rs`, beside `open_console`:

```rust
/// Create (or focus) the first-run wizard. Same one-press-then-focus contract
/// as the console: `windows::raise` on an existing window, never a second
/// creation (two wizard windows is a state machine with two heads).
pub fn open_wizard(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("wizard") {
        raise(&w);
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html".into()))
        .title("Subshell Server")
        .inner_size(720.0, 620.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("could not open the setup window: {e}"))
}

/// Raise whichever window MANAGES this machine: the wizard while the setup
/// has never finished, the console after. Every opener (menu, tray, the SPA's
/// pill through desktop_open_console) goes through here so a machine can
/// never have its manage surface decided twice in two places.
pub fn open_manage_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let onboarded = app.state::<subshell_desktop_core::settings::SettingsState>().get().onboarded;
    if onboarded {
        open_console(app)
    } else {
        open_wizard(app)
    }
}
```

`lib.rs` setup: replace `windows::open_console(&handle)?;` with:

```rust
            // Boot looks before it leaps: the probe marks what it proves
            // (control::boot_probe -> mark_onboarded, spec § 4), and the
            // WINDOW CHOICE is made from the fresh answer, never the stored
            // flag. A machine set up from the CLI opens the console, because
            // by the time the branch runs, onboarded is true.
            let settings = handle.state::<subshell_desktop_core::settings::SettingsState>();
            match control::boot_window(&control::boot_probe(&settings)) {
                control::WindowChoice::Wizard => {
                    windows::open_wizard(&handle)?;
                }
                control::WindowChoice::Console => {
                    windows::open_console(&handle)?;
                }
            }
```

(`settings` borrow of `handle` must end before the window builders; scope it in a block if the checker objects.) Replace the tray's and menu's console-opening calls with `windows::open_manage_window(&app)` (grep `open_console(` in `tray.rs`/`menu.rs`; there are one or two). Extend the single-instance and Reopen fallback chains: `main.or(wizard).or(console)`. `desktop_open_console` (control.rs) now calls `windows::open_manage_window(&app)`.

`src-tauri/capabilities/wizard.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "wizard",
  "description": "The first-run setup window. It may walk a machine from virgin to ready - install the server, tmux, and agent CLIs, pick a server binary, probe, and open the dashboard or the console - and nothing else: no service verbs, no init (setup is the chain), no config/log reads, no tray settings. Pinned equal to what wizard.ts actually invokes by ui/src/__tests__/ipc-acl.test.ts.",
  "local": true,
  "windows": [
    "wizard"
  ],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "allow-desktop-probe",
    "allow-desktop-setup",
    "allow-desktop-install-tmux",
    "allow-desktop-install-agent",
    "allow-desktop-set-server-bin",
    "allow-desktop-open-tmux-docs",
    "allow-desktop-open-main",
    "allow-desktop-open-console"
  ]
}
```

- [ ] **Step 6: Verify**

`cd apps/server/desktop && bun test ui/src/__tests__/ && bun run verify-types && bun run build` (the build proves the second input bundles CSP-clean), then repo-root `bun run rust:check`. Expected: green; the wizard.json grants equal wizard.ts's `ipc.*` calls under the reworked pin test.

- [ ] **Step 7: Commit**

```bash
git add apps/server/desktop
git commit -m "feat(desktop-server): the first-run wizard window, and boot that asks the machine before choosing

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Reset, the Rust half

Spec § 7, §§ R13/R14/R17/R18 dispositions. The screen argument, the stashes, the guards, and the chain. New module because control.rs is already the file the size rules would split anyway.

**Files:**
- Create: `apps/server/desktop/src-tauri/src/reset.rs` (with inline `#[cfg(test)] mod tests`)
- Modify: `apps/server/desktop/src-tauri/src/lib.rs` (`mod reset;` + manage `reset::Stash::default()` + register `reset::desktop_reset`)
- Modify: `apps/server/desktop/src-tauri/src/control.rs` (`desktop_open_console` gains `screen`, calls into `reset::arm_and_raise`)
- Modify: `apps/server/desktop/src-tauri/src/windows.rs` (`open_console`'s builder gains `.on_page_load(...)` delivering the stash)

**Interfaces:**
- Consumes: `machine_hostname`, `probe_now` (control), `service_now` (control), `SettingsState` (core), `proc::run` (core), `sidecar::install_path` + `SERVER_SIDECAR` (server_bin).
- Produces:
  - `pub enum Screen { Console, Reset }`, `pub fn parse_screen(raw: Option<String>) -> Screen`
  - `pub struct DeletePlan { config_env, database, logs_dir, artifacts_dir, data_dir: PathBuf }` (`Clone, PartialEq`)
  - `pub fn parse_delete_plan(status: &serde_json::Value) -> Option<DeletePlan>` (all-or-nothing, R17)
  - `pub fn path_rules_ok(p: &Path, home: &Path) -> bool` (pure shape: absolute, not `/`, not home)
  - `pub fn delete_guard_ok(dir: &Path, keep: &Path) -> bool` (dir contains-or-equals keep ⇒ false). **Callers pass canonicalized paths** (P3): a prefix test between a symlinked and a real spelling would pass while the delete still reached the binary, so the chain canonicalizes both sides before calling, and a path that exists but cannot be canonicalized is a refusal.
  - `pub fn is_subshell_socket(name: &str) -> bool` (`subshell-` prefix)
  - `pub struct Stash { pub screen: Mutex<Option<Screen>>, pub plan: Mutex<Option<DeletePlan>> }` (`Default`)
  - `pub fn arm_and_raise(app: &AppHandle, screen: Option<String>) -> Result<(), String>`
  - `#[tauri::command] pub async fn desktop_reset(app: AppHandle, typed: String) -> Result<ActionResult, String>`

- [ ] **Step 1: Write the failing unit tests** (pure parts only; no spawn, no fs mutation beyond `std::env::temp_dir` listings where unavoidable)

```rust
    #[test]
    fn screen_parses_closed_and_defaults_open() {
        // Absent and unknown both mean the plain console: a remote page
        // cannot name a screen this enum has not admitted.
        assert_eq!(parse_screen(None), Screen::Console);
        assert_eq!(parse_screen(Some("reset".into())), Screen::Reset);
        assert_eq!(parse_screen(Some("/etc".into())), Screen::Console);
    }

    #[test]
    fn plan_parses_all_or_nothing() {
        // R17: a partial block is the same refusal as no block. A subset
        // deleted and reported success is R1's shape again.
        let good = json!({"configEnv": {"path": "/c/config.env", "exists": true},
            "paths": {"dataDir": "/data", "database": "/data/subshell.db",
                      "logsDir": "/data/subshells", "nodeArtifacts": "/data/node-artifacts"}});
        let plan = parse_delete_plan(&good).expect("the four-path block parses");
        assert_eq!(plan.data_dir.to_str().unwrap(), "/data");
        assert_eq!(plan.config_env.to_str().unwrap(), "/c/config.env");
        for missing in [
            json!({"configEnv": {"path": "/c/config.env"}, "paths": {"database": "/d", "logsDir": "/l", "nodeArtifacts": "/n"}}),
            json!({"configEnv": {"path": "/c/config.env"}, "paths": {"dataDir": "", "database": "/d", "logsDir": "/l", "nodeArtifacts": "/n"}}),
            json!({"configEnv": {"path": "/c/config.env"}, "paths": {"dataDir": "relative", "database": "/d", "logsDir": "/l", "nodeArtifacts": "/n"}}),
            json!({"configEnv": {"path": "/c/config.env"}}),
        ] {
            assert!(parse_delete_plan(&missing).is_none(), "must refuse, not partially plan");
        }
    }

    #[test]
    fn default_layout_passes_and_an_ancestor_of_the_binary_does_not() {
        // R13 from both sides + R3's single keep path: the default install's
        // data dir EQUALS the config dir that holds config.env, and that is
        // legal; a data dir that would take the binary with it is not.
        let home = Path::new("/home/u");
        assert!(delete_guard_ok(Path::new("/home/u/.config/subshell-server"), Path::new("/home/u/.local/bin/subshell-server")));
        assert!(!delete_guard_ok(Path::new("/home/u/.local"), Path::new("/home/u/.local/bin/subshell-server")));
        assert!(!delete_guard_ok(Path::new("/home/u"), Path::new("/home/u/.local/bin/subshell-server")));
        assert!(path_rules_ok(Path::new("/data"), home));
        assert!(!path_rules_ok(Path::new("/"), home));
        assert!(!path_rules_ok(Path::new("/home/u"), home));
        assert!(!path_rules_ok(Path::new("relative/path"), home));
    }

    #[test]
    fn socket_prefix_selects_only_this_products_servers() {
        // Mirrors tmuxSocketFor (`subshell-<hash>`) in pane-runtime; the
        // containment test below pins the pair like the installer table does.
        assert!(is_subshell_socket("subshell-0a1b2c3d4e5f"));
        assert!(!is_subshell_socket("0a1b2c3d4e5f"));
        assert!(!is_subshell_socket("mywork"));
        const RUNTIME: &str = include_str!("../../../../packages/pane-runtime/src/tmux-runner.ts");
        assert!(RUNTIME.contains("`subshell-${hash}`"), "the prefix rule moved; update both sides");
    }
```

Run: `bun run rust:check` - expected: compile failure on the new module.

- [ ] **Step 2: Implement `reset.rs`**

Write the module with: `Screen`/`parse_screen` (string match, `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]`, serialize `as_str()` for the event payload); `DeletePlan`/`parse_delete_plan` reading the § 8 block plus `configEnv.path` exactly as the test above spells (all four paths `is_absolute()` and non-empty, else `None`); `path_rules_ok` and `delete_guard_ok` pure as spelled; `is_subshell_socket` = `name.starts_with("subshell-")`; `Stash` per the interface list; `arm_and_raise`:

```rust
/// The reset entry's whole Rust side at press time: parse the (untrusted,
/// optional) screen argument, and for `reset` read the machine NOW and stash
/// both the screen request and the validated delete plan (R18). If the read
/// fails or the plan will not parse, the screen still raises - it renders its
/// own refusal from the probe - but nothing is stashed, so desktop_reset has
/// nothing to execute either. The page never supplies a path to anything;
/// its only input is the typed hostname.
pub fn arm_and_raise(app: &tauri::AppHandle, screen: Option<String>) -> Result<(), String> {
    let stash = app.state::<Stash>();
    if parse_screen(screen.clone()) == Screen::Reset {
        let settings = app.state::<subshell_desktop_core::settings::SettingsState>();
        let p = crate::control::probe_now(settings.get().binary_path.as_deref());
        *stash.plan.lock().unwrap() = p.status.as_ref().and_then(|s| parse_delete_plan(s));
        *stash.screen.lock().unwrap() = Some(Screen::Reset);
    }
    let existed = app.get_webview_window("console").is_some();
    crate::windows::open_console(app)?;
    if existed {
        // A live window has no page-load to catch the stash; deliver now.
        if let Some(s) = stash.screen.lock().unwrap().take() {
            if let Some(w) = app.get_webview_window("console") {
                use tauri::Emitter;
                let _ = w.emit("desktop-screen", s.as_str());
            }
        }
    }
    Ok(())
}
```

(`probe_now` must become `pub(crate)`; note in its docblock that `arm_and_raise` is why.)

`desktop_reset` - the chain, spelling exactly the spec § 7.2 order:

```rust
#[tauri::command(async)]
pub fn desktop_reset(app: tauri::AppHandle, typed: String) -> Result<ActionResult, String> {
    use subshell_desktop_core::proc;
    // The typed string must equal the memo the screen was built from (R15);
    // mismatch is an Err (a refusal to start, not a failed run).
    if typed.trim() != crate::control::machine_hostname() {
        return Err("the hostname did not match this machine".into());
    }
    let stash = app.state::<Stash>();
    let plan = stash.plan.lock().unwrap().clone().ok_or_else(|| {
        "no reset plan is staged; the reset screen must be opened again".to_string()
    })?;
    let settings = app.state::<subshell_desktop_core::settings::SettingsState>();
    // The one thing the confirmation promised to keep: the managed copy's
    // path, resolved exactly as install_server_now resolves it.
    let keep = subshell_desktop_core::sidecar::install_path(&crate::server_bin::SERVER_SIDECAR)
        .ok_or_else(|| "cannot locate this app's managed server copy to protect it".to_string())?;
    // Canonicalize the kept path so the containment comparison is between
    // real locations, not spellings (P3). An absent binary keeps the
    // uncanonicalized path, and containment THEN STILL REFUSES a delete
    // target that would prefix-contain it (N3): fail-closed on purpose,
    // because that path is where the binary would be reinstalled, so
    // recursive-deleting its ancestor is what should stop the chain even
    // with no file standing there yet. Present-but-unresolvable is a refusal.
    let keep = match std::fs::canonicalize(&keep) {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => keep,
        Err(e) => return Err(format!("cannot resolve the protected path {keep:?}: {e}")),
    };
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .map_err(|_| "HOME is unset; reset refuses to delete with no home to guard".to_string())?;

    // The three RECURSIVE deletes get the containment guard (N1): the
    // database is removed as a single file, so its parent directory is never
    // deleted and guarding it could only refuse a reset that was never going
    // to touch the binary (a database at ~/.local/bin/subshell.db would
    // otherwise refuse on its parent). All three elements are &PathBuf, so
    // the array type-checks; plan.database keeps its own path_rules_ok check
    // two paragraphs below.
    for p in [&plan.data_dir, &plan.logs_dir, &plan.artifacts_dir] {
        if !path_rules_ok(p, &home) {
            return Err(format!("refusing to delete {p:?}: fails the shape rules"));
        }
        if !p.exists() {
            continue; // already-deleted is a step succeeding, not a guard case
        }
        let canonical = std::fs::canonicalize(p)
            .map_err(|e| format!("cannot resolve {p:?} to guard it against the protected binary: {e}"))?;
        if !delete_guard_ok(&canonical, &keep) {
            return Err(format!("refusing to delete {p:?}: it contains the installed server binary this reset promises to keep"));
        }
    }
    if !path_rules_ok(&plan.database, &home) || !path_rules_ok(&plan.config_env, &home) {
        return Err("refusing: database or config.env path fails the shape rules".into());
    }

    let mut log = String::new();
    // 2. Stop, tolerating "there is nothing to stop" (the CLI's own words).
    let stop = crate::control::service_now(&settings, crate::control::ServiceCommand::Stop, false);
    if let Some(stderr) = push_step(&mut log, &stop, &[]) {
        return Ok(ActionResult { ok: false, stdout: log, stderr });
    }
    // 3. Close this instance's panes (their per-subshell tmux servers).
    if let Some(detail) = close_subshell_tmux(&mut log) {
        return Ok(ActionResult { ok: false, stdout: log, stderr: detail });
    }
    // 4. Uninstall the service, while the binary and config it names exist.
    let un = crate::control::service_now(&settings, crate::control::ServiceCommand::Uninstall, false);
    if let Some(stderr) = push_step(&mut log, &un, &["not installed"]) {
        return Ok(ActionResult { ok: false, stdout: log, stderr });
    }
    // 5. Delete in the order the screen drew, absence = done, config.env last.
    delete_consent(&plan.database, &mut log);
    delete_tree(&plan.logs_dir, &mut log);
    delete_tree(&plan.artifacts_dir, &mut log);
    if let Some(detail) = delete_tree_but(&plan.data_dir, &plan.config_env, &mut log) {
        return Ok(ActionResult { ok: false, stdout: log, stderr: detail });
    }
    remove_if_exists(&plan.config_env, &mut log);
    let _ = std::fs::remove_dir(plan.config_env.parent().unwrap()); // empty-dir tidy, tolerated
    let _ = std::fs::remove_dir(&plan.data_dir);
    // 6. This app's own choices, which are the machine state this screen owns.
    let _ = settings.update(|s| {
        s.binary_path = None;
        s.onboarded = false;
    });
    *stash.plan.lock().unwrap() = None; // the consent has been spent
    // 7. Windows, in the order that keeps the app alive (N2; spec § 7.2
    // step 7 amended to match): close main (its port just died), OPEN THE
    // WIZARD, and close the console last. The order is not cosmetic: if the
    // console closed while it was the last window, the zero-window moment
    // runs the last-window path, and lib.rs's ExitRequested prevent-exit
    // fires only when a `main` window exists - which a reset may well have
    // just closed. An app that quits in the middle of the one command that
    // is supposed to land the user in the wizard is the failure this order
    // forecloses.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
    match crate::windows::open_wizard(&app) {
        Ok(()) => {
            if let Some(w) = app.get_webview_window("console") {
                let _ = w.close();
            }
        }
        // M2: the machine IS reset; a window that would not build does not
        // undo that, and the stash is already spent, so answering Err here
        // would tell the user the wipe failed on a machine where it fully
        // succeeded - with Retry impossible ("no plan stashed") and no route
        // forward. The console stays open ON PURPOSE in this arm: closing it
        // would be the zero-window moment N2 exists to prevent, with no
        // wizard to replace it.
        Err(e) => log.push_str(&format!(
            "\nthe wizard window could not be opened: {e}\nthis machine is reset; reopen the app to continue setup\n"
        )),
    }
    Ok(ActionResult { ok: true, stdout: log, stderr: String::new() })
}
```

Channel discipline (M1, the correction round 3 earned): an in-chain failure is a **return value the caller puts into `Ok(ActionResult { ok: false, stdout: log, stderr })`**, never a `?` into `Err`. `Err` belongs only to the refusals that fire before the first mutation (hostname, no plan, guard, shape, unresolvable keep) exactly as spec § 10 enumerates. The precedent is `desktop_setup` in the same crate (`control.rs:399-408`): a step that ran and refused answers `ok: false` carrying the accumulated verbatim log; `?` there means "could not even be attempted". The half-run paths also deliberately fall BEFORE `*stash.plan.lock().unwrap() = None`, so a Retry still holds the consent that produced the partial run.

Implement the named helpers in this same file with these exact contracts, each one or two sentences of doc: `push_step(log: &mut String, r: &ActionResult, tolerated: &[&str]) -> Option<String>` (append stdout, and on success any non-empty stderr, the chain's verbatim rule; `None` when ok or when stderr contains a tolerated phrase; otherwise `Some(r.stderr)` verbatim, there being no separate `push_step_tolerant`); `remove_if_exists` (`NotFound` is success); `delete_tree(log)` / `delete_tree_but(root, keep_out, log) -> Option<String>` (`remove_dir_all` / manual walk skipping exactly `keep_out`; a missing root is success; any other error returns `Some(message)` for the caller's half-run); `close_subshell_tmux`:

```rust
/// Kill the tmux servers this product created and nobody is watching anymore.
/// Each pane owns a tmux server on a `subshell-<hash>` socket named by
/// pane-runtime; the directory is tmux's own rule, TMUX_TMPDIR ?? /tmp
/// symlink-resolved with a tmux-<uid> subdir (NOT TMPDIR - on macOS that is a
/// per-user /var/folders path with no sockets in it, and a silent zero-kill
/// would let a reset report success with every pane still running, spec § 7.2
/// step 3 / R1). A kill answered by "error connecting" means the server is
/// already dead: unlink the stale socket and continue. Any other failure ends
/// the chain (as M1's half-run Some): a pane that survived is a reset that
/// lied.
fn close_subshell_tmux(log: &mut String) -> Option<String> {
    let base_raw = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    let base = std::fs::canonicalize(&base_raw).unwrap_or_else(|_| std::path::PathBuf::from(&base_raw));
    // A uid this side cannot read means a directory this side cannot name,
    // which means zero kills reported as success - the R1 shape exactly. So
    // this failure ends the chain (as a half-run), never a silent skip.
    let uid_res = proc::run(&vec!["id".to_string(), "-u".to_string()], crate::control::ACTION_TIMEOUT);
    if !uid_res.ok {
        return Some(format!("could not read the uid to locate tmux sockets: {}", uid_res.stderr.trim()));
    }
    let dir = base.join(format!("tmux-{}", uid_res.stdout.trim()));
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => {
            log.push_str("no tmux socket directory here; nothing to close\n");
            return None;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_subshell_socket(&name) {
            continue;
        }
        let r = proc::run(&["tmux".into(), "-L".into(), name.clone(), "kill-server".into()], crate::control::ACTION_TIMEOUT);
        if !r.ok {
            let combined = format!("{}{}", r.stdout, r.stderr);
            if combined.contains("error connecting") {
                let _ = std::fs::remove_file(dir.join(&name));
                log.push_str(&format!("stale socket {name} removed\n"));
                continue;
            }
            return Some(format!("could not close the pane server {name}: {}", r.stderr.trim()));
        }
        log.push_str(&format!("closed pane server {name}\n"));
    }
    None
}
```

Adapt the `proc::run` result-field names to the crate's actual result shape (read `crates/desktop-core/src/proc.rs` first; `service_now` shows how it converts). If tmux itself is absent the spawn fails with a not-found error - that is the weird-machine case the spec admits: treat a `tmux` spawn failure whose error names `tmux`/`No such file` as "nothing to close", everything else fatal.

Visibility, one edit list: `probe_now`, `service_now`, and `ACTION_TIMEOUT` become `pub(crate)` in `control.rs` (`ServiceCommand` is already `pub`). Its docblock gains one sentence naming `reset::arm_and_raise` as why `probe_now` is no longer private.

`windows.rs` builder gains (inside `open_console`'s `WebviewWindowBuilder` chain):

```rust
        .on_page_load(|window, _| {
            // A console created under a screen request delivers it once the
            // page exists; a request while one was live is emitted directly
            // by reset::arm_and_raise.
            if let Some(stash) = window.app_handle().try_state::<crate::reset::Stash>() {
                if let Some(screen) = stash.screen.lock().unwrap().take() {
                    use tauri::Emitter;
                    let _ = window.emit("desktop-screen", screen.as_str());
                }
            }
        })
```

`control.rs` `desktop_open_console` becomes `pub fn desktop_open_console(app: AppHandle, screen: Option<String>) -> Result<(), String>` that routes: if `!settings onboarded` → `crate::windows::open_manage_window(&app).map(|_| ())` (a wizard machine cannot reset; the screen argument is dropped there, per § 3), else `crate::reset::arm_and_raise(&app, screen)`.

`lib.rs`: `mod reset;`, `.manage(reset::Stash::default())`, add `reset::desktop_reset` to `generate_handler!`.

- [ ] **Step 3: No ACL changes in this task (P1, decided here rather than at the keyboard)**

The `allow-desktop-reset` toml entry and its `console.json` grant BOTH land in Task 8 as one step: `ipc-acl.test.ts`'s "defines no app permission neither capability grants" unions exactly `console.json + main.json` and fails any manifest entry granted nowhere, so a lone toml entry here turns a green task red on a check this task is otherwise unrelated to. The toml block goes to Task 8 verbatim.

- [ ] **Step 4: Verify**

`bun run rust:check` (fmt, clippy -D warnings, all tests including the new pure ones) and `cd apps/server/desktop && bun test ui/src/__tests__/` - expected green: this task touches no manifest or capability file, so the pin cannot move.

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop/src-tauri
git commit -m "feat(desktop-server): reset's Rust half - stashed plan, guards, and the chain

The delete plan lives in app state (captured while the machine could
still answer), desktop_reset takes only the hostname, and every path
must pass shape rules and the single containment guard (protect the
installed binary; the config dir is a deletion target, not a keepsake -
spec R13). Panes close through tmux's OWN directory rule (TMUX_TMPDIR,
not TMPDIR; R1) and a survive-kill is a chain failure, never silence.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Reset, the console half (view, grant, contract)

Spec §§ 7.1, 9. The second view of the console page, its pure decision module, the `desktop-screen` listener, and the ACL trio landing together so the pin never breaks.

**Files:**
- Create: `apps/server/desktop/ui/src/lib/reset.ts`, test `apps/server/desktop/ui/src/__tests__/reset.test.ts`
- Modify: `apps/server/desktop/ui/index.html` (second-view markup), `apps/server/desktop/ui/src/main.ts` (view swap + listener), `apps/server/desktop/ui/src/lib/ipc.ts` (`reset`, `StatusBody.paths`), `apps/server/desktop/src-tauri/capabilities/console.json` (grant), `apps/server/desktop/src-tauri/permissions/desktop.toml` (permission entry - both ACL halves arrive in THIS task, together with the invoke that makes them honest; Task 7 deliberately carried neither)

**Interfaces:**
- Consumes: `Probe.hostname` (Task 4), `status.paths` (Task 3), the `desktop-screen` event with payload `"reset"` (Task 7), `desktop_reset` command (Task 7).
- Produces: `resetRows(status): { label: string; path: string | null }` and `armed(typed: string, hostname: string): boolean` and `refusal(status): string | null`; `ipc.reset(typed)`.

- [ ] **Step 1: Write the failing pure tests**

```ts
import { describe, expect, it } from "bun:test";
import { armed, refusal, resetRows } from "../lib/reset";

const paths = { dataDir: "/data", database: "/data/subshell.db", logsDir: "/data/subshells", nodeArtifacts: "/data/node-artifacts" };

describe("resetRows / refusal", () => {
  it("names the real paths when the block is complete", () => {
    const rows = resetRows({ configEnv: { path: "/c/config.env", exists: true }, paths } as never);
    expect(rows.map((r) => r.path)).toEqual([
      "/data/subshell.db", "/data/subshells", "/data/node-artifacts", "/data", "/c/config.env",
    ]);
    expect(refusal({ configEnv: { path: "/c/config.env", exists: true }, paths } as never)).toBeNull();
  });
  it("refuses, with the same sentence, for absent or partial blocks (R17)", () => {
    expect(refusal({} as never)).toContain("does not report");
    expect(refusal({ paths: { ...paths, dataDir: "" } } as never)).toContain("does not report");
    expect(refusal({ paths: { ...paths, dataDir: "relative" } } as never)).toContain("does not report");
  });
});

describe("armed", () => {
  it("is exact and case-sensitive, and so is the Rust side", () => {
    expect(armed("devbox", "devbox")).toBe(true);
    expect(armed("Devbox", "devbox")).toBe(false);
    expect(armed("devbox ", "devbox")).toBe(true); // trailing space is a typing artifact, trimmed
    expect(armed("", "devbox")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to fail** - `cd apps/server/desktop && bun test ui/src/__tests__/reset.test.ts`.

- [ ] **Step 3: Implement `reset.ts`**

```ts
/**
 * The reset confirmation's decisions, pure (spec § 7.1). The display order
 * here is the deletion order in Rust § 7.2 step 5, because the screen shows
 * what will happen, in the order it will happen, and a screen that disagrees
 * with its own chain is the drift this file exists to prevent. The arming
 * compare is UX; the Rust compare against the same memoized hostname (R15)
 * is the gate, and its test name says so.
 */

interface StatusLike {
  configEnv?: { path: string; exists: boolean };
  paths?: { dataDir?: string; database?: string; logsDir?: string; nodeArtifacts?: string };
}

const isAbsolute = (p: unknown): p is string => typeof p === "string" && p.startsWith("/");

export function refusal(status: StatusLike | null | undefined): string | null {
  const p = status?.paths;
  const complete =
    p !== undefined && isAbsolute(p.dataDir) && isAbsolute(p.database) && isAbsolute(p.logsDir) && isAbsolute(p.nodeArtifacts) && typeof status?.configEnv?.path === "string";
  if (complete) return null;
  return (
    "This server does not report its data locations, so there is no list this screen can promise to delete. " +
    "Reset refuses to guess at a filesystem. Updating the server (the button this page offers when an update " +
    "is available) adds the report; otherwise remove the directories shown by `subshell-server status` by hand."
  );
}

export function resetRows(status: StatusLike): { label: string; path: string }[] {
  const p = status.paths as NonNullable<StatusLike["paths"]>; // refusal() gates callers
  return [
    { label: "Database (users, sessions, API keys, the node signing keypair)", path: p.database as string },
    { label: "Pane logs (every transcript on disk)", path: p.logsDir as string },
    { label: "Node artifacts (the agent binaries this plane serves)", path: p.nodeArtifacts as string },
    { label: "Instance data directory", path: p.dataDir as string },
    { label: "Configuration", path: status.configEnv?.path as string },
  ];
}

export function armed(typed: string, hostname: string): boolean {
  return typed.trim() === hostname;
}
```

- [ ] **Step 4: Wire the view**

`ipc.ts`:

```ts
/** `status --json`'s data locations (spec § 8); absent on an older server, which arms nothing. */
paths?: { dataDir?: string; database?: string; logsDir?: string; nodeArtifacts?: string };
```

into `StatusBody`, and beside the other verbs:

```ts
/** The one destructive verb. Typed hostname in, machine state wiped out; the paths are Rust's plan, never this side's. */
export const reset = (typed: string): Promise<ActionResult> => invoke<ActionResult>("desktop_reset", { typed });
```

`index.html`: wrap the four existing cards in `<div id="status-view">` and append the second view (module script stays the last element):

```html
<div id="reset-view" hidden>
  <p class="mb-1 font-medium text-[15px]">Reset this machine's Subshell instance</p>
  <p class="hint mb-2.5" id="reset-refusal"></p>
  <ul class="wizard-copy list-disc pl-5" id="reset-rows"></ul>
  <div class="wizard-copy text-sm text-muted mb-2.5" id="reset-disclosures"></div>
  <label class="mb-1 block text-sm" for="reset-confirm">Type this machine's hostname to confirm, exactly as shown: <code id="reset-hostname"></code></label>
  <div class="flex gap-2">
    <input id="reset-confirm" class="min-w-0 flex-1" spellcheck="false" autocapitalize="off" />
    <button type="button" id="reset-run" class="primary" disabled>Reset everything</button>
    <button type="button" id="reset-cancel">Cancel</button>
  </div>
  <!-- The half-run record lands HERE, not in #output: the status view is
       hidden while this one is up, so a chain log rendered there would be
       invisible - which is M1's whole promise unkept by the page. -->
  <pre class="pane-pre mt-3" id="reset-log" aria-live="polite" hidden></pre>
</div>
```

`main.ts` (add near the pane-tab wiring at the bottom; import `listen` from `@tauri-apps/api/event` and the three functions from `./lib/reset`):

```ts
/**
 * The console's second view (spec § 7.1). Entered ONLY by the desktop-screen
 * event from the dashboard's danger card (no console-side entry: § 7.1 says
 * so); it renders the captured-plan truth from the live probe and compares
 * the typed hostname the same way Rust will (displayed value wins nowhere:
 * both sides read the probe's single memo, R15).
 */
let view: "status" | "reset" = "status";

function renderReset(): void {
  const st = probe?.status;
  const why = refusal(st);
  el("reset-refusal").textContent = why ?? "";
  const rows = el("reset-rows");
  rows.textContent = "";
  if (why === null && st !== undefined) {
    for (const row of resetRows(st)) {
      const li = document.createElement("li");
      li.textContent = `${row.label}: ${row.path}`;
      rows.append(li);
    }
  }
  el("reset-disclosures").textContent =
    "Enrolled remote nodes are NOT reached: their agents and panes keep running with keys to a plane that will not exist. A subshell node agent on this very machine is not reached either and must be stopped from Subshell Client or `subshell service stop`. The installed server binary stays. Everything listed above is permanent.";
  el("reset-hostname").textContent = probe?.hostname ?? "";
  (el("reset-run") as HTMLButtonElement).disabled = !(why === null && armed((el("reset-confirm") as HTMLInputElement).value, probe?.hostname ?? ""));
  el("reset-run").dataset.armed = String(armed((el("reset-confirm") as HTMLInputElement).value, probe?.hostname ?? ""));
}

function showReset(): void {
  view = "reset";
  el("status-view").hidden = true;
  el("reset-view").hidden = false;
  renderReset();
}

el("reset-confirm").addEventListener("input", renderReset);
el("reset-cancel").addEventListener("click", () => {
  view = "status";
  el("reset-view").hidden = true;
  el("status-view").hidden = false;
});
/** M1's promise kept by the page: a half-run's verbatim log renders where
 *  the human still is. Success normally needs no rendering - the chain
 *  closes this window on its way to the wizard - but the wizard-open failure
 *  arm (M2) answers ok:true with a note in the log, and Retry needs the
 *  partial record on screen. */
function showResetResult(text: string): void {
  const box = el("reset-log");
  box.textContent = text;
  box.hidden = text === "";
}

el("reset-run").addEventListener("click", () => {
  void (async () => {
    const typed = (el("reset-confirm") as HTMLInputElement).value;
    if (!armed(typed, probe?.hostname ?? "")) return;
    busy = true;
    showResetResult("");
    render();
    try {
      const result = await ipc.reset(typed);
      const parts: string[] = [];
      if (result?.stdout?.trim()) parts.push(result.stdout.trim());
      if (result?.stderr?.trim()) parts.push(result.stderr.trim());
      showResetResult(parts.join("\n\n"));
    } catch (err) {
      // Err is the pre-flight channel (hostname mismatch, no plan, refused
      // guard): one sentence, no partial log exists to show.
      showResetResult(errText(err));
    }
    busy = false;
    try {
      await refresh();
    } catch {
      /* the machine is being deleted under us */
    }
    render();
  })();
});

void listen<string>("desktop-screen", (event) => {
  if (event.payload === "reset") showReset();
});
```

`render()` gains one line: `if (view === "reset") renderReset();` (the reset view coexists with the busy state; buttons re-arm themselves from the probe).

`console.json`: add `"allow-desktop-reset"` to `permissions`. `permissions/desktop.toml` gains, in the same commit as that grant and the `ipc.ts` invoke (this is the trio Task 7 deferred):

```toml
[[permission]]
identifier = "allow-desktop-reset"
description = "Wipe this machine's Subshell instance: stop and uninstall the service, close this instance's panes, delete the paths status reported, and clear this app's choices. Takes ONLY the typed hostname; the paths are a plan Rust captured when the screen was opened, and the command refuses without one. Console window only."
commands.allow = ["desktop_reset"]
```

- [ ] **Step 5: Verify the trio and everything**

`cd apps/server/desktop && bun test ui/src/ && bun run verify-types && bun run build`, repo root `bun run rust:check && bun run verify-types && bun run lint:check && bun run test`. The set of commands invoked from `ui/src/main.ts` (the CONSOLE page's entry module - not the `main` window, which holds and must keep holding only its three) now includes `desktop_reset` and matches `console.json` exactly, which is the proof the trio held.

- [ ] **Step 6: Commit**

```bash
git add apps/server/desktop
git commit -m "feat(desktop-server): the console's reset view, and the ACL trio for the one verb that destroys

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: The dashboard's danger card

Spec § 6. Entry lives in Settings (admin + desktop marker); execution stays in the console.

**Files:**
- Create: `apps/server/web/src/components/settings/reset-card.tsx`
- Modify: `apps/server/web/src/routes/settings.tsx` (mount inside the existing admin gate)
- Test: `apps/server/web/src/components/__tests__/reset-card.test.tsx` (follow the pattern of `instance-name-card.test.tsx` beside it)

**Interfaces:**
- Consumes: `desktopInvoke` + `desktopShell` from `src/lib/desktop.ts`; `usePublicSettings`' `viewerIsAdmin` (already read by the route).
- Produces: `resetCardVisible(opts: { viewerIsAdmin?: boolean; desktop: boolean }): boolean`; the card calls `desktopInvoke("desktop_open_console", { screen: "reset" })`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it } from "bun:test";
import { resetCardVisible } from "../settings/reset-card";

describe("resetCardVisible", () => {
  it("shows for an admin inside the desktop shell, and nowhere else", () => {
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: true })).toBe(true);
    expect(resetCardVisible({ viewerIsAdmin: false, desktop: true })).toBe(false);
    expect(resetCardVisible({ viewerIsAdmin: undefined, desktop: true })).toBe(false);
    // A plain browser, or Subshell Client (marker stripped): the reset verb
    // lives in the SERVER app's console, so an entry with no path to it
    // would be a button that lies.
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Fail, then implement the card**

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { desktopInvoke, desktopShell } from "@/lib/desktop";

/** Visibility is UX; the security gate is the console-only ACL behind it. */
export function resetCardVisible(opts: { viewerIsAdmin?: boolean; desktop: boolean }): boolean {
  return opts.viewerIsAdmin === true && opts.desktop;
}

export function ResetServerCard() {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Reset this machine</CardTitle>
        <CardDescription>
          Stops and uninstalls the Subshell Server service, closes this machine&apos;s panes, and deletes the
          instance data: accounts, sessions, API keys, signing keys, pane logs, plugins, and the server
          configuration. Enrolled nodes and any subshell agent on this machine are not touched and will need
          to be re-enrolled or stopped separately. The installed server binary stays. There is no undo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* The confirmation and the whole chain run in the Subshell Server window: it is the only surface
            that may drive the CLI. This button raises it at the reset screen. Older desktop builds ignore
            the screen argument, so the worst skew is a plain console appearing. */}
        <Button
          variant="destructive"
          onClick={() => void desktopInvoke("desktop_open_console", { screen: "reset" })}
        >
          Reset server...
        </Button>
      </CardContent>
    </Card>
  );
}
```

(Adjust `Card`/`Button` imports to the exact shadcn paths this app uses; check `instance-name-card.tsx` and match it.)

- [ ] **Step 3: Mount in the route** - in `settings.tsx`, inside the existing admin-gated body, after the last card, add the visibility-gated render using the route's existing `viewerIsAdmin` value:

```tsx
      {resetCardVisible({ viewerIsAdmin, desktop: desktopShell() !== null }) && <ResetServerCard />}
```

- [ ] **Step 4: Verify**

`cd apps/server/web && bun test src/components/__tests__/reset-card.test.tsx`, then repo root `bun run verify-types && bun run lint:check && bun run test`. (e2e note: no suite change needed; bare Chromium has no marker, so the card is already asserted invisible by this unit test's own `desktop: false` case; if the suite grows a Settings visit, add the invisibility assertion there.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/web
git commit -m "feat(server-web): a danger-zone Settings card that raises the desktop console to reset

Admin-only, desktop-shell-only: the verb lives in the Subshell Server
window, so the entry appears only where raising it can reach it.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: Docs, changesets, and the full gate

Spec § 12. The design knowingly breaks two documentation sentences; fix them here, not silently.

**Files:**
- Modify: `apps/server/desktop/AGENTS.md`, `apps/server/desktop/README.md`, `.claude/rules/security-context.md`, `docs/security.md`
- Create: `.changeset/<three names>.md`

- [ ] **Step 1: App AGENTS.md.** Replace the "The two windows, and why they are two" heading/table with three windows (wizard row: bundled `wizard.html`, the reset entry's counterpart role: console owns the reset view, wizard owns first run); add short sections in the file's measured style for: boot probes-then-branches via `boot_window` (R6), `mark_onboarded` as the single writer (R16), the `onboarded` field and what its false does, the wizard's steps and why decisions-are-steps (link the spec), the deep link with its R21-worded worst case, the reset chain summary with the two guards (shape + containment/R13) and the tmux `TMUX_TMPDIR` rule (R1, and that `cleanSocket` used to get it wrong), and the pin-test list gaining wizard.json. Update the "Where things live" tree with `reset.rs`, `wizard.html`, `ui/src/wizard.ts`, `ui/src/lib/wizard-state.ts`, `ui/src/lib/reset.ts`.

- [ ] **Step 2: security-context.md.** Replace "Both apps have the same two-window shape, and it is the boundary" with the server app's three-window reality and the unchanged boundary argument (privileged verbs stay on bundled pages; `main` holds exactly three; the open_console screen argument and R21's precise worst case quoted verbatim from the spec); add a reset paragraph: console-only command, hostname compared against Rust's memo, paths from `status --json` only, all-or-nothing block, remote nodes and same-machine agent not reached.

- [ ] **Step 3: docs/security.md.** Same substance in the authoritative file's desktop section (this is where the rules file points for detail; keep the two consistent, rules file summary first).

- [ ] **Step 4: README.** Replace any "first run shows the console" phrasing with the wizard; add one paragraph: resetting is a Settings danger-zone action confirmed by hostname, described in AGENTS.md.

- [ ] **Step 5: Changesets** (one file each; `bunx changeset` is interactive, so write the files):

```md
---
"@internal/desktop-server": minor
---

First-run setup is now a guided wizard in its own window, and a hostname-confirmed "reset this machine" wipes the instance from the dashboard's Settings danger zone.
```

```md
---
"@internal/server-web": minor
---

Settings gains an admin-only, desktop-only danger card that raises Subshell Server to reset this machine.
```

```md
---
"@internal/server": patch
---

`subshell-server status --json` now reports `paths` (dataDir, database, logsDir, nodeArtifacts) so the desktop app's reset deletes exactly what it shows.
```

- [ ] **Step 6: The full gate**

Run from the repo root: `bun run verify-types && bun run lint:check && bun run test && bun run rust:check && bunx turbo build`. Expected: all green.

- [ ] **Step 7: Manual smoke (the only one that can see the whole flow)**

Inside the builder image or a dev box with a staged sidecar (`bun run dev:app` in `apps/server/desktop`), on a throwaway HOME: confirm boot opens the wizard on a virgin machine, the chain completes to Done, reopening the app opens the console, the Settings card (browser on the loopback plane inside the app, admin) raises the console at the reset view, hostname confirmation arms, and a completed reset lands on the wizard with the service gone. A dev-form `~/.config` makes reset fast to iterate.

- [ ] **Step 8: Commit**

```bash
git add apps/server/desktop/AGENTS.md apps/server/desktop/README.md .claude/rules/security-context.md docs/security.md .changeset
git commit -m "docs(desktop-server): three windows, the reset contract, and the release notes

The two-window symmetry sentence dies here (the server app grew a wizard
window); the security docs gain the reset accounting and the R21-worded
worst case for the deep link.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Review notes (2026-09-11) - RESOLVED; where each fix landed is in the
## self-review notes at the end of this plan

The plan is accurate where I checked it against the code. Task 1's claims about
`settings.rs` all hold (struct at 51, `save` at 107, the hand-written `Default`,
`load`'s `unwrap_or_default()` swallowing parse failures into a reset file),
`desktopInvoke` exists at `apps/server/web/src/lib/desktop.ts:152`, tauri is
2.11.5 on Rust 2021, and Task 7's R13 test pinning the default layout as
*passing* beside the ancestor case as failing is exactly the shape that finding
asked for. Task-to-task interfaces are consistent; there are no placeholders.

Six findings. P1 is an open question the plan asks the executor to answer, and
it can be answered here instead. P2 and P3 are real gaps. The rest are small.

**P1. Task 7 step 3's open conditional resolves to "yes, it fails". Decide it
in the plan rather than at the keyboard.** The step says: "if that check counts
a permission granted nowhere as a failure, move this toml addition into Task 8
where the grant arrives... the test file you are in is the arbiter, not this
sentence." The arbiter has been consulted.
`apps/server/desktop/ui/src/__tests__/ipc-acl.test.ts` carries:

```ts
it("defines no app permission neither capability grants", () => {
  const granted = new Set([...capabilityPermissions("console.json"), ...capabilityPermissions("main.json")]);
  for (const id of manifestPermissions().keys()) expect(granted.has(id)).toBe(true);
});
```

Every id in `desktop.toml` must be granted by some capability file. A
`allow-desktop-reset` entry landing a task before its `console.json` grant fails
this immediately. **Move the toml entry into Task 8**, or add the console grant
in Task 7 so the pair lands together. Either is fine; leaving it as a branch is
what to avoid, because the executor discovers it as a red test in a task whose
other steps all passed.

While in that file: Task 6 adds `wizard.json`, and **two** of its assertions
read the capability set as a union of exactly `console.json` and `main.json`
(the one above, and "names no permission the manifest does not define"). Both
need `wizard.json` added to their union, or the wizard's own grants fail them.
Task 6's step 4 says the pin test is "reworked"; make it explicit that the
rework is those two unions plus the new wizard assertion, since missing one
produces a failure that reads as a permissions bug rather than a test that was
never widened.

**P2. Task 2 changes a shared signature and verifies only the package it
changed.** `cleanSocket` goes from returning `void` to returning
`Promise<void>`, and its call sites are not in `pane-runtime`:

```
apps/server/api/src/services/nodes/__tests__/local-launcher.test.ts:21,84,117,141,149
apps/node/agent/src/__tests__/commands-launch.test.ts:1129
```

Step 4 runs only `cd packages/pane-runtime && bun test`, so nothing in this task
sees those six. They still compile, as the task says, but two things change for
them: each becomes a floating promise, and each stops being guaranteed to finish
before the test that calls it returns. `local-launcher.test.ts:20-22` makes the
inconsistency visible in three lines, calling `tmux.cleanSocket(socket)` bare and
then `void Bun.file(...).unlink().catch(...)` directly beneath it, the same
pattern with the `void` the file's own style applies.

Add to Task 2: update those six call sites (`await` inside the async hooks,
`void` elsewhere, matching each file's local style), and end the task with the
repo-root trio rather than the package suite. Global Constraints already says
the trio runs "from the repo root when touching TS"; this task's steps contradict
it, and an executor follows the steps.

**P3. `delete_guard_ok` is a prefix comparison, and the plan does not say the
paths reaching it are canonical.** `pub fn delete_guard_ok(dir: &Path, keep:
&Path) -> bool` with "dir contains-or-equals keep" is right, and the tests cover
the literal cases. But a prefix test between a symlinked path and a real one
passes while the delete still reaches the binary: if `~/.local/bin` is a symlink,
or the data dir is reached through one, `/home/u/.config/subshell-server` and the
binary's real location compare as unrelated strings. The spec's shape guard
("final component not a symlink") covers the deleted directory's own last
component, not the ancestors of either side.

Two lines to add to Task 7: both arguments are canonicalized before the
comparison (or the caller passes canonical paths and the signature says so), and
a `keep` that cannot be resolved is a **refusal**, not a skipped check.
`sidecar::install_path` returns an `Option`, so "no path to protect" is
reachable, and the safe reading of it is to stop rather than to delete with the
guard disabled.

**P4. "the `ipc-acl` main.ts set" is ambiguous in the one place ambiguity is
expensive.** Task 8 step 5: "The `ipc-acl` main.ts set now includes
`desktop_reset` and matches console.json exactly." This is correct, and it is one
character from describing the exact thing the design forbids. In this app
`main.ts` is the console page's entry module, `main.json` is the remote window's
capability file, and `main` is the window that must never hold the reset command.
Spell it out: "the set of commands invoked from `ui/src/main.ts` (the console
page)".

**P5. Tech Stack says Vite 7; the app is on 8.2.1.** (`apps/server/desktop/package.json`.)
Minor, but Task 6 adds a second Vite input and an executor consulting
version-specific docs for `rollupOptions.input` would be reading the wrong major.

**P6. Confirm the commit attribution line.** Global Constraints and all ten task
commit blocks end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
The attribution in force for this repo's current sessions is
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. If the
executing agent carries its own attribution, it should use that and the plan
should say so rather than hardcoding a third value in ten places.

## Re-review (2026-09-11), round 2

P1 through P6 all landed in the task bodies, not just in the disposition: I
checked each against the file. P1's resolution is better than the finding asked
for (Task 7 now explains *why* the toml block moves rather than just moving it,
and Task 6 names both unions it widens). P6's resolution is correct and the
disagreement is not one: two sessions carry different attribution guidance, and
deferring to whichever session executes is exactly the fix, so nothing further
is owed there.

Three findings, all in Task 7's new guard code. One does not compile.

**N1. The guard loop's array has two different element types, and `rustc`
rejects it.** In `desktop_reset`:

```rust
for p in [
    &plan.data_dir,        // &PathBuf
    &plan.logs_dir,        // &PathBuf
    &plan.artifacts_dir,   // &PathBuf
    &plan.database.parent().unwrap_or(&plan.database),   // &&Path
] {
```

`DeletePlan`'s fields are all `PathBuf`, so the first three are `&PathBuf`;
`parent()` yields `Option<&Path>`, so the fourth is `&&Path`. Measured, not
reasoned:

```
error[E0308]: mismatched types
  |     for p in [&data_dir, &database.parent().unwrap_or(&database)] {
  |                          ^^^ expected `&PathBuf`, found `&&Path`
```

**The fourth element should not be there at all**, which is the cleaner fix.
The containment guard exists to stop a *recursive directory delete* from taking
the server binary with it. The database is removed as a single file
(`delete_consent(&plan.database, ...)`), so its parent directory is never
deleted, and guarding that parent can only produce false refusals: a database
at `~/.local/bin/subshell.db` would have a parent containing the binary and
would refuse a reset that was never going to touch it. Drop the fourth element,
keep the three directories that actually get `delete_tree`d, and let
`plan.database` keep the separate `path_rules_ok` check it already has below.

**N2. The window-order comment contradicts the code beneath it, and the spec
sides with the comment.** The comment reads "dashboard first (its port just
died), console, then wizard"; the code closes `main`, then calls
`open_wizard`, then closes `console`. Spec § 7.2 step 7 says "close `main`,
close the console, open the wizard at Welcome", which is the comment's order.

The code's order is probably the right one, and that is why this needs saying
out loud rather than quietly correcting: opening the wizard before closing the
console means the app is never momentarily at zero windows, which on this app
matters because closing the last window runs the close-to-tray path
(`lib.rs`'s `CloseRequested` handler, and `effective_close_to_tray`'s clamp).
An executor who "fixes" the code to match the comment and the spec would be
introducing that window, not removing a discrepancy. Decide it, make the
comment state the reason, and amend spec § 7.2 step 7 to match whichever order
wins.

**N3. The `keep` NotFound comment claims the opposite of what the code does.**

```rust
Err(e) if e.kind() == std::io::ErrorKind::NotFound => keep,
// "Absent keep = no binary on disk to take down, and a non-existent path
//  cannot be contained by anything - the guard passes honestly."
```

`delete_guard_ok` is a path-prefix comparison, so a non-existent
`~/.local/bin/subshell-server` is still "contained by" `~/.local`, and the
guard still refuses. The behaviour is fine and fails closed, which is the right
direction: that path is where the binary would be reinstalled, so refusing to
recursively delete its ancestor is defensible. Only the comment is wrong, and a
comment asserting a guard passes when it refuses is the kind a later reader
trusts instead of re-deriving. Say what it does: an absent binary keeps the
uncanonicalized path, and containment still refuses an ancestor, deliberately.

Nothing else in the re-read changed. The delete order, the `delete_tree_but`
skip for a nested `config.env`, the stash clearing only on success so a Retry
still has its consent, and the tmux socket rule all read correctly against the
spec.

## Re-review (2026-09-11), round 3 - RESOLVED (M1: the chain's channels
## rewritten to the spec's, M2: the post-wipe wizard-open failure handled; see
## the self-review notes at the end of this plan)

N1, N2 and N3 all landed correctly. N2's resolution is better than the finding:
I asked for a decision and got a measured reason. `lib.rs:153-158` really does
gate `api.prevent_exit()` on `app.get_webview_window("main").is_some()`, and
reset closes `main` first, so a console closed while it was the last window
would hit `ExitRequested` with nothing to prevent the exit. Adopting the code's
order and amending spec § 7.2 step 7 is right.

Two findings, both about how the chain reports failure rather than what it
does. They are one issue seen from two distances, and the second is the one
with a bad end state.

**M1. Mid-chain failures return `Err`, which contradicts § 10, § 7.2, and the
function the plan says it copies.** Spec § 10: "an `Err` is a refusal to start
(hostname mismatch, no plan stashed, refused deletion guard), **never a
half-run**; a half-run is `ok: false` with the log showing where it stopped."
§ 7.2: "A failure mid-chain leaves the reset screen up with verbatim output and
Retry."

Five sites in `desktop_reset` return `Err` after work has already happened:

```rust
push_step(&mut log, "stop", &stop)?;                       // service already stopped
close_subshell_tmux(&mut log)?;                            // panes already killed
push_step_tolerant(&mut log, "uninstall", &un, "...")?;    // service already uninstalled
delete_tree_but(&plan.data_dir, &plan.config_env, ...)?;   // deletions already done
crate::windows::open_wizard(&app)?;                        // everything already done
```

and the helper contract makes it explicit: "`push_step` (append stdout;
`ok == false` and not tolerated ⇒ `Err` carrying stderr verbatim)". On every one
of those paths the accumulated `log`, which is the verbatim CLI output § 7.2
promises the screen, is dropped on the floor; the user gets one error string
instead of a record of which steps succeeded before the stop.

The shape to copy is in the same file, a hundred lines away, and already gets
this right (`control.rs:399-408`):

```rust
if !result.ok {
    // The failure's stderr leaves on the failure channel, not also
    // into the log: the console renders both halves, and the refusal
    // a user most needs to read must appear exactly once.
    return Ok(ActionResult { ok: false, stdout: log, stderr: result.stderr });
}
```

`desktop_setup` reserves `?` for "the step could not even be run" and returns
`Ok(ok: false)` for "the step ran and refused". `desktop_reset` should do the
same: the four in-chain sites become `return Ok(ActionResult { ok: false,
stdout: log, stderr })`, and `Err` stays for the pre-flight refusals § 10 lists,
which are all already above the first mutation. This also makes the helper
contracts change: `push_step` and `delete_tree_but` should hand back a failure
the caller converts, rather than deciding the channel themselves.

**M2. `open_wizard(&app)?` fires after a complete, successful wipe, and the
stash has already been spent, so the user cannot retry out of it.** Sequence as
written:

```rust
*stash.plan.lock().unwrap() = None;   // consent spent
if let Some(w) = app.get_webview_window("main") { let _ = w.close(); }
crate::windows::open_wizard(&app)?;   // <- Err here
```

A webview build can fail. If it does: the machine is fully reset, the log of
everything that succeeded is discarded, `desktop_reset` answers `Err`, the
screen renders a failure, and Retry is impossible because the plan is already
`None` (it would answer "no plan stashed"). The user is told the reset failed,
on a machine where it entirely succeeded, with no route forward.

One accident is currently load-bearing and should become deliberate: the early
return *skips* closing the console, which is the only window left once `main` is
closed, so the app does not end up with zero windows. That is the right outcome
reached by the wrong mechanism. Make it explicit, and let the reset report the
truth:

```rust
match crate::windows::open_wizard(&app) {
    Ok(()) => {
        if let Some(w) = app.get_webview_window("console") {
            let _ = w.close();
        }
    }
    // The machine IS reset; a window that would not build does not undo that.
    // The console stays open on purpose: closing it here would be the
    // zero-window moment N2 exists to prevent, with no wizard to replace it.
    Err(e) => log.push_str(&format!(
        "\nthe wizard window could not be opened: {e}\nthis machine is reset; reopen the app to continue setup\n"
    )),
}
Ok(ActionResult { ok: true, stdout: log, stderr: String::new() })
```

Nothing else changed on re-read. The N1 guard loop now type-checks (three
`&PathBuf` elements), N3's comment states the fail-closed behaviour it actually
has, and `plan.config_env.parent().unwrap()` cannot panic because
`path_rules_ok` has already rejected `/` for that path.

## Self-review notes (author, post-write)

- Spec coverage: § 3 windows/boot (Task 6), § 4 flag + save (Tasks 1, 4), § 5 wizard (Tasks 5, 6), § 6 deep link + card + R21 wording (Tasks 7, 9, 10), § 7 reset screen/chain (Tasks 7, 8), § 8 paths block (Task 3), § 9 contracts (all), § 10 error handling (embedded in each chain step), § 11 tests (each task's step 1), § 12 docs/changesets (Task 10), § 13 non-goals (nothing scheduled touches them).
- Plan-review round (P1-P6, this section's author round): P1 resolved in the plan (reset's toml entry + grant both moved to Task 8; Task 6 names the two ipc-acl unions it widens); P2 resolved (six test call sites enumerated with the file's own `void`/`await` convention, and Task 2 now ends on the repo-root trio); P3 resolved (both guard sides canonicalized, unresolvable-present is a refusal, absent keep passes honestly); P4 resolved (Task 8 step 5 spells "the set invoked from ui/src/main.ts, the CONSOLE page's entry module"); P5 fixed (Vite 8.2.1); P6 partially: the attribution is now declared inherited from the executing session's guidance, but the reviewer's stated current value conflicts with this session's guidance ("replaces any earlier attribution guidance", naming Claude Code) - the plan defers to whichever session executes, which is the fix the finding's structure wanted.
- Plan re-review round 2 (N1-N3, all verified against the code before adopting): N1 adopted with its better reason (the fourth guard element protected a directory the chain never deletes, so it could only mis-refuse; and the mixed `&PathBuf`/`&&Path` array indeed does not compile, E0308 measured by the reviewer); N2 adopted IN THE CODE'S ORDER with spec § 7.2 step 7 amended to match, because the zero-window moment the comment-vs-code mismatch hid is a real quit-mid-reset path (lib.rs's ExitRequested guard requires a `main` window); N3 adopted as a comment correction only, the behavior was already the fail-closed one, now stated truthfully.
- Plan re-review round 3 (M1-M2, both verified against spec § 10 and `control.rs:399-408` before adopting): M1 adopted across five call sites plus every helper contract (`push_step` gained the tolerance list, `close_subshell_tmux` and `delete_tree_but` return `Option<String>`); the failure paths fall before the stash clearing so a Retry still holds its consent; and M1's page-side consequence - the half-run log rendering into the HIDDEN status view's `#output` - got its own fix: `#reset-log` renders the record where the human still is. M2 adopted as given: the wizard-open failure after a completed wipe logs the truth, keeps ok:true, and leaves the console open deliberately (the one arm where closing it would recreate N2's zero-window moment with no wizard to replace it). No spec change: § 10 already said the right thing; the plan had drifted from it.
- Remaining intentional softness: a few comments defer to the file on disk ("match the file's existing style", "read `proc.rs` for the result field names") - those point at named sources of truth rather than at nothing.

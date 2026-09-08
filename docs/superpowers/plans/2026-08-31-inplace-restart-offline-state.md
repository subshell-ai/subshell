# In-place Restart + Offline State + iPhone Touch-Scroll — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restarting a session revives the same row (same id, resume-when-possible) instead of cloning; a temporarily-down mote server reads as "reconnecting" everywhere instead of "not found"; and the xterm terminal scrollable by one-finger swipe on iPhone.

**Architecture:** Backend extracts the auto-restart revival core (`maybeAutoRestart`'s spawn sequence) into a shared `#reviveRow` and rewrites `restartSession` to kill→park→revive the same row. Frontend gains a `NetworkError` class at the fetch boundary, a network-aware retry policy in the shared `QueryClient`, a derived offline banner fed by a `QueryCache` subscription, and per-page fixes where downtime lies. Touch scroll is a standalone passive-listener module driving `term.scrollLines` alongside xterm's own touch handlers.

**Tech Stack:** Bun, ElysiaJS, Kysely/SQLite, `bun test`; React 19, TanStack Query v5, xterm.js 6, happy-dom.

**Spec:** `docs/superpowers/specs/2026-08-31-inplace-restart-offline-state-design.md` (approved).
**Deviation from spec (recorded deliberately):** the spec's `restartNonce` becomes a terminal key of `` `${id}:${alive}` `` (Task 4) — same mechanism, but it also heals the workspace-pane path, where a `4004` attach-rejection before a restart used to leave a permanently blank pane.
**Add-on (no spec, bug report):** iPhone terminal touch scroll (Task 9) — root cause: xterm.js calls `preventDefault()` on `touchmove` for its long-press selection, cancelling the native pan the `touch-action: pan-y` CSS (styles.css:112-121) advertises.

## Global Constraints

- `bun` only (never npm/pnpm); exact-pinned deps (`bun add` then `bunx syncpack fix` — but see the ⚠️ warning in `apps/mobile/AGENTS.md`: **no dependency changes are planned; do not run syncpack at all**).
- No dynamic `import()` anywhere (`.claude/rules/code-style.md`).
- Every fixed option set: use union/schema types with `description` fields on Elysia `t` schemas (unchanged schemas here — description text only).
- Verification after ALL code tasks: `bun run verify-types && bun run lint:check && bun run test` from repo root; `turbo build` after backend route/schema-description edits.
- Tests use `bun test`; backend route suites share one per-process temp DB via `src/test-preload.ts` — never assume an empty DB.
- Commit per task with conventional commits; author email must be theo@suteki.nu (already the git config — do not override).

---

### Task 1: Extract `#reviveRow` from `maybeAutoRestart` (pure refactor)

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts` (the body of `maybeAutoRestart`, ~lines 532-645)
- Test: existing `apps/backend/src/services/__tests__/session-manager.service.test.ts` + `session-manager-mcp.test.ts` — **must pass UNCHANGED**; they are the refactor's gate.

**Interfaces:**
- Consumes: existing private helpers `#revokeTokenOrUnlink`, `#tokens.issue`, `#planHarnessSession`, `registerSessionMcp`, `sessionMcpEnv`, `buildHarnessCommand`, `tmuxSocketFor`, `sessionLogPath`, `#sessions.updateIfRunning`, `#tmux.newSession/killSession/pipePane`.
- Produces: `#reviveRow(row: SessionTable, opts: { backoffCount: number }): Promise<boolean>` — resolves the launch inputs from the row's own fields, rotates the token, spawns, conditionally revives. `true` = pane spawned + row revived; `false` = a terminate slipped in (orphan killed, fresh token revoked). Throws plain `Error`s on unbuildable launches ("profile missing", "harness missing", "harness binary missing"). Task 2 calls it for manual restart.

- [ ] **Step 1: Add the `#reviveRow` method** (place it right after `maybeAutoRestart`). Its body is the exact sequence currently inlined in `maybeAutoRestart` from the profile lookup through the pipe-pane re-arm — same order, same error strings, same comments:

```typescript
  /**
   * Revive a parked row (`status: "running"`, `alive: 0`) in place: rotate
   * credentials, re-register MCP, resume the conversation when its transcript
   * survived, respawn the pane, and conditionally flip the row back alive.
   *
   * Shared by the auto-restart sweep and the manual `POST /:id/restart`;
   * both must obey the same race guards (pre-spawn re-read, conditional
   * revival) so a terminate landing mid-flight cannot leave a live pane
   * under a dead row. `nextRestartAt` is cleared on success and the row's
   * `tmuxSocket` is persisted (a row parked before its first socket write
   * still gets a durable one).
   * @returns true when the pane spawned and the row revived; false when a
   *          terminate won the race (orphan pane killed, fresh token revoked)
   * @throws when the launch cannot even be composed (profile/harness/binary
   *         gone, working dir unlinked, tmux refused the spawn)
   */
  async #reviveRow(
    row: SessionTable,
    { backoffCount }: { backoffCount: number },
  ): Promise<boolean> {
    const profileRow = await this.#profiles.findById(row.profileId);
    if (!profileRow) throw new Error("profile missing");
    const harness = getHarness(row.harnessId);
    if (!harness) throw new Error("harness missing");
    const realPath = await validateWorkingDir(row.workingDir);
    const binary = await harness.findBinary();
    if (!binary) throw new Error("harness binary missing");
    const profile = parseProfile(profileRow);
    // Rotate the MCP token: the old process is gone and its baked key must
    // die with it; the new pane bakes the freshly issued one. A failed
    // revoke must NOT abort the restart — `issue` below rewrites the row's
    // apiKeyId, and the guard's link check then 401s the orphaned old key.
    await this.#revokeTokenOrUnlink(row.id);
    const apiKey = await this.#tokens.issue(row.id, row.userId);
    const mcp = registerSessionMcp(harness, row.id);
    // Same-row restart: resume the crashed conversation when it survived,
    // re-pin when it didn't (or the row predates the feature).
    const harnessSession = this.#planHarnessSession(harness, row.harnessSessionId ?? null, realPath);
    const cmd = buildHarnessCommand(
      harness,
      binary,
      realPath,
      profile,
      row.name,
      sessionMcpEnv(apiKey, row.id, row.name),
      mcp,
      harnessSession,
    );
    const socket = row.tmuxSocket ?? tmuxSocketFor(row.id);
    // Cheap last look before the spawn: everything above (profile lookup,
    // findBinary, two token round-trips) is a window in which the operator
    // can terminate the session — never bake a pane under a killed row.
    const preSpawn = await this.#sessions.findById(row.id);
    if (preSpawn?.status !== "running" || preSpawn.alive !== 0) {
      // The row died mid-flight; retire the token we just minted for it.
      await this.#revokeTokenOrUnlink(row.id);
      return false;
    }
    this.#tmux.newSession(socket, row.id, realPath, cmd);
    // Re-attach the log pipe if it was unlinked by cleanup.
    const logFile = sessionLogPath(row.id);
    // Conditional revival: a terminate that landed after the pre-spawn
    // check (between it and this write) must not resurrect the row — the
    // guard makes this a no-op and the orphan below is cleaned up instead.
    const revived = await this.#sessions.updateIfRunning(row.id, {
      alive: 1,
      exitCode: null,
      endedAt: null,
      tmuxSocket: socket,
      startedAt: new Date().toISOString(),
      backoffCount,
      nextRestartAt: null,
      // Persist the pinned id when this attempt re-pinned (mode "start");
      // a mode "resume" id equals the stored one, so this is a no-op write.
      ...(harnessSession ? { harnessSessionId: harnessSession.id } : {}),
    });
    if (revived === 0) {
      logger.warn(`session ${row.id} terminated mid-restart; killing the orphan pane and revoking its token`);
      this.#tmux.killSession(socket, row.id); // swallows "already gone"
      await this.#revokeTokenOrUnlink(row.id);
      return false;
    }
    try {
      this.#tmux.pipePane(socket, row.id, logFile);
    } catch {
      /* best-effort */
    }
    return true;
  }
```

- [ ] **Step 2: Slim `maybeAutoRestart` to its gates + the call.** Keep verbatim: the entry gates (`status/alive/restartOnExit`, backoff-due, `backoffCount >= 5`), the up-front `nextRestartAt` scheduling, the fresh re-read, the `harnessUsable` defer, the `catch` block (log + advance `backoffCount` + clear `nextRestartAt`). Everything between the `harnessUsable` block and the success log becomes:

```typescript
      const revived = await this.#reviveRow(fresh, { backoffCount: fresh.backoffCount + 1 });
      if (revived) logger.info(`session auto-restarted (${row.id}), backoff=${row.backoffCount + 1}`);
      return revived;
```

(The pre-spawn `preSpawn` re-read, the `updateIfRunning` block, the orphan cleanup and the pipe-pane try/catch now live in `#reviveRow` — delete them from `maybeAutoRestart`, along with its local `profileRow/harness/realPath/binary/profile/apiKey/mcp/harnessSession/cmd/socket/logFile/revived` declarations.)

- [ ] **Step 3: Run the auto-restart regression gate**

Run: `cd apps/backend && bun test src/services/__tests__/session-manager.service.test.ts src/services/__tests__/session-manager-mcp.test.ts`
Expected: all PASS with **zero test-file edits**. (Real tmux is required on this host — it is available; tests use the `claude-stub`.)

- [ ] **Step 4: `bun run verify-types && bun run lint:check` from repo root; commit**

```bash
git add apps/backend/src/services/session-manager.service.ts
git commit -m "refactor(backend): extract #reviveRow from maybeAutoRestart

The auto-restart sweep already revives the same row with full race
protection; the manual restart path is about to reuse it. Pure extraction,
no behavior change (existing auto-restart tests pass untouched)."
```

---

### Task 2: `restartSession` revives the same row (test-first)

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts` (`restartSession`, ~lines 395-434)
- Test: Modify `apps/backend/src/services/__tests__/session-manager.service.test.ts` (the four `restartSession` tests + the bell test), `apps/backend/src/services/__tests__/session-manager-mcp.test.ts` ("restart issues a token for the NEW session row", ~line 215)

**Interfaces:**
- Consumes: `#reviveRow(row, { backoffCount })` from Task 1; `#sessions.update`, `#tmux.killSession`.
- Produces: `restartSession(userId, sourceId): Promise<{ id: string; tmuxSocket: string } | null>` — **return type loses `apiKey` and `promptDelivered`** (they were never on this method's surface but the clone's `createSession` result leaked `promptDelivered` through `sessions.service`; Task 3 adjusts the service to supply the literal `false`). Same id ⇒ callers (route, MCP tool, mobile) see the response shape unchanged: `{ id, tmuxSocket, promptDelivered }`.

- [ ] **Step 1: Rewrite the manager-suite restart tests** (replace the four `restartSession` tests in `describe("SessionManagerService notes + restart")`):

```typescript
  it("restartSession revives the SAME row (same id, name, profile; parked fields cleared)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId);
    await sessionsRepo.update(id, {
      status: "terminated",
      alive: 0,
      exitCode: 3,
      endedAt: new Date().toISOString(),
      backoffCount: 4,
      nextRestartAt: new Date().toISOString(),
    });
    const restarted = await sessionManager.restartSession("u1", id);
    if (!restarted) throw new Error("expected a restarted session");
    trackTmuxSocket(restarted.tmuxSocket);
    expect(restarted.id).toBe(id); // NOT a new id — in-place revival
    const row = await sessionsRepo.findById(id);
    expect(row?.name).toBe("Original"); // no " (2)" suffix ever
    expect(row?.status).toBe("running");
    expect(row?.alive).toBe(1);
    expect(row?.exitCode).toBeNull();
    expect(row?.endedAt).toBeNull();
    expect(row?.backoffCount).toBe(0); // operator intent resets the ladder
    expect(row?.nextRestartAt).toBeNull();
    expect(row?.tmuxSocket).toBe(restarted.tmuxSocket);
    await sessionManager.terminateSession("u1", id);
    expect(sessionManager.isAlive({ id, tmuxSocket: restarted.tmuxSocket })).toBe(false);
  });

  it("restartSession kills a live source before respawning it (same row, same socket)", async () => {
    const profileId = await seedProfileFor("u1");
    const created = await sessionManager.createSession({ userId: "u1", profileId, workingDir: "/tmp" });
    trackTmuxSocket(created.tmuxSocket);
    expect(sessionManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    const restarted = await sessionManager.restartSession("u1", created.id);
    if (!restarted) throw new Error("expected a restarted session");
    expect(restarted.id).toBe(created.id);
    expect(restarted.tmuxSocket).toBe(created.tmuxSocket);
    // A pane is running again under the SAME identity (the stub sleep re-spawned).
    expect(sessionManager.isAlive({ id: created.id, tmuxSocket: created.tmuxSocket })).toBe(true);
    await sessionManager.terminateSession("u1", created.id);
  });

  it("restartSession keeps the bell on the row (operator monitoring survives a restart)", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId);
    await sessionsRepo.update(id, { notify: 1 });
    const restarted = await sessionManager.restartSession("u1", id);
    if (!restarted) throw new Error("expected a restarted session");
    trackTmuxSocket(restarted.tmuxSocket);
    expect((await sessionsRepo.findById(id))?.notify).toBe(1);
    await sessionManager.terminateSession("u1", id);
  });

  it("concurrent restartSession calls join one revival", async () => {
    const profileId = await seedProfileFor("u1");
    const id = await seedSession("u1", profileId);
    // A token-stub manager so the revival count is observable: one issue per
    // real restart, and a double click must issue exactly once.
    let issues = 0;
    const counting = new SessionManagerService({
      sessions: sessionsRepo,
      profiles: profilesRepo,
      tmux: new TmuxRunner(),
      tokens: {
        issue: async () => {
          issues += 1;
          return "mote_stub";
        },
        revoke: async () => {},
      },
      audit: async () => {},
    });
    const [a, b] = await Promise.all([counting.restartSession("u1", id), counting.restartSession("u1", id)]);
    expect(a?.id).toBe(id);
    expect(b?.id).toBe(id);
    expect(issues).toBe(1); // the second call JOINED the in-flight restart
    await counting.terminateSession("u1", id);
  });
```

Keep the two existing 404-path tests ("rejects a foreign userId", "returns null for a missing session") exactly as they are — `restartSession` keeps its null contract.

- [ ] **Step 2: Rewrite the MCP-suite token test** in `session-manager-mcp.test.ts`:

```typescript
  it("restart rotates the token on the SAME row", async () => {
    const first = await manager.createSession({ userId: "u1", profileId, workingDir: testDir });
    const restarted = await manager.restartSession("u1", first.id);
    if (!restarted) throw new Error("restart returned null");
    expect(restarted.id).toBe(first.id);
    // Revocation of the dead process's key is the auto path's pattern:
    // revoke-then-issue on the same id, apiKeyId rewritten by `issue`.
    expect(tokens.issued).toEqual([first.id, first.id]);
    expect(tokens.revoked).toContain(first.id);
  });
```

- [ ] **Step 3: Run to verify the new tests FAIL**

Run: `cd apps/backend && bun test src/services/__tests__/session-manager.service.test.ts -t "restartSession"`
Expected: FAIL — old code returns a new id (`expect(restarted.id).toBe(id)` breaks; the clone tests assert `.not.toBe`).

- [ ] **Step 4: Implement.** Add the field to the class (next to the other `readonly #` fields):

```typescript
  /** In-flight manual restarts by session id: a double click JOINS the first
   * revival instead of double-killing and double-spawning the pane. */
  readonly #restarts = new Map<string, Promise<{ id: string; tmuxSocket: string } | null>>();
```

Replace `restartSession` (and its JSDoc) wholesale:

```typescript
  /**
   * Restart the session IN PLACE: same row, same id, same name. Kills the
   * pane (live or already dead), parks the row in the exact crashed shape
   * (`running` / `alive: 0`) the auto path revives from, and runs the shared
   * `#reviveRow` — token rotated, MCP re-registered, harness conversation
   * RESUMED when its transcript survived (`planHarnessSession` decides). The
   * auto-restart ladder resets: operator intent supersedes backoff state.
   *
   * The parked window is sub-second and the sweep interval is far longer;
   * as in the auto path, a sweep landing inside it could fire a spurious
   * death push on a notify row — the conditional revival keeps the pane and
   * the token honest either way.
   * @returns the restarted id + tmuxSocket (same as before the restart), or
   *          null when the session is absent or not the caller's
   * @throws Error when the relaunch cannot be composed (profile/harness/
   *         binary gone, working dir unlinked, tmux refused the spawn); the
   *         row stays parked — visible and restartable again.
   */
  async restartSession(userId: string, sourceId: string): Promise<{ id: string; tmuxSocket: string } | null> {
    const inFlight = this.#restarts.get(sourceId);
    if (inFlight) return inFlight;
    const run = (async (): Promise<{ id: string; tmuxSocket: string } | null> => {
      const source = await this.#sessions.findById(sourceId);
      if (!source || source.userId !== userId) return null;
      if (source.alive === 1 && source.tmuxSocket) {
        // killSession swallows "already gone"; the tree dies with its baked key,
        // which #reviveRow then rotates off the same row anyway.
        this.#tmux.killSession(source.tmuxSocket, source.id);
      }
      await this.#sessions.update(source.id, {
        status: "running",
        alive: 0,
        exitCode: null,
        endedAt: null,
      });
      // Fresh re-read: the flip above is the only rewrite this path does by
      // hand; everything after it obeys the auto path's guards.
      const parked = await this.#sessions.findById(source.id);
      if (!parked) return null; // deleted mid-flight
      const revived = await this.#reviveRow(parked, { backoffCount: 0 });
      // `revived === false` means a terminate won the race — honor it: the
      // response describes the (now terminated) session the operator asked for.
      await this.#audit({
        actorUserId: userId,
        action: "session.restart",
        targetType: "session",
        targetId: parked.id,
        metadataJson: JSON.stringify({ name: parked.name, racedTerminate: !revived }),
      });
      logger.info(`session restarted in place: ${parked.id} (${parked.name})${revived ? "" : " [terminate raced, left dead]"}`);
      return { id: parked.id, tmuxSocket: parked.tmuxSocket ?? tmuxSocketFor(parked.id) };
    })().finally(() => this.#restarts.delete(sourceId));
    this.#restarts.set(sourceId, run);
    return run;
  }
```

- [ ] **Step 5: Run the full backend suite**

Run: `cd apps/backend && bun test src`
Expected: PASS. (If `session-manager-view.test.ts` or any route test asserts clone semantics, fix the EXPECTATION — same id now — not the implementation.)

- [ ] **Step 6: `bun run verify-types && bun run lint:check`; commit**

```bash
git add apps/backend/src/services/session-manager.service.ts apps/backend/src/services/__tests__/
git commit -m "feat(backend): restartSession revives the same row in place

Restart used to clone (new id, 'name (2)', revoked channel identity). Now
it kills, parks, and runs the shared #reviveRow: same id, name, socket,
E2EE channel membership, and (when the transcript survived) the harness
conversation resumes. Concurrent restarts join one revival."
```

---

### Task 3: Contract text — route, service, security doc, mobile comments

**Files:**
- Modify: `apps/backend/src/api/sessions/restart-session.route.ts`
- Modify: `apps/backend/src/services/sessions.service.ts` (`restartSession` wrapper, ~lines 206-224)
- Modify: `.claude/rules/security-context.md` (the per-session-tokens bullet)
- Modify: `apps/mobile/src/types/session.ts` (line ~25), `apps/mobile/src/lib/api-error.ts` (lines ~70-75)

**Interfaces:**
- Consumes: `SessionManagerService.restartSession` returning `{ id, tmuxSocket } | null` (Task 2).
- Produces: HTTP contract — `POST /api/sessions/:id/restart` still returns `CreateSessionResponseSchema` (`{ id, tmuxSocket, promptDelivered }`); `promptDelivered` is now always `false` (no prompt is typed on restart, matching auto-restart).

- [ ] **Step 1: Update the service wrapper.** Its JSDoc ("Starts a new session… deliberately does NOT re-check harness usability…") keeps its *meaning* — the manual restart still bypasses the `harnessUsable` gate, which lives on the auto call site — but the text must say revive, not clone:

```typescript
  /**
   * Revives a session IN PLACE (same id, same row): the manager kills the
   * pane and re-runs the auto-restart's guarded respawn on this row.
   * Deliberately does NOT re-check harness usability — the gate lives on
   * creation and the auto path; a session whose harness was disabled later
   * can still be restarted.
   * @throws SessionError 404 when the session is absent or not the caller's.
   */
```

and its return mapping becomes (manager no longer reports `promptDelivered`):

```typescript
    const revived = await this.#manager.restartSession(userId, id);
    if (!revived) {
      throw new SessionError("not_found", "Session not found");
    }
    // No prompt is typed on a restart (matching auto-restart); the schema
    // keeps the create-session shape, so the flag is a truthful false.
    return { id: revived.id, tmuxSocket: revived.tmuxSocket, promptDelivered: false };
```

- [ ] **Step 2: Route description + JSDoc:**

```typescript
/** `POST /api/sessions/:id/restart` — revives this session in place (same id): new process, same row, conversation resumed when its transcript survived. */
```

with the OpenAPI `description:` string: `"Revive this session in place: same id and name, new process, conversation resumed when its transcript survived"`.

- [ ] **Step 3: Security rule** — in `.claude/rules/security-context.md`, change "revoked immediately when the session is terminated/deleted (auto-restart rotates the key)" to "(restart — auto or manual — rotates the key on the same row)".

- [ ] **Step 4: Mobile comments** — `apps/mobile/src/types/session.ts`: the `id` JSDoc becomes `/** Session id (uuid). Restart revives the row in place: the id survives. */`. In `apps/mobile/src/lib/api-error.ts`, the `isAlreadyGone` comment's "or restarted into a new id" / "Session restart mints a NEW id, so a stale id converging on 'gone' is the" sentence: reword the cause list to "deleted elsewhere" + "terminated then deleted" and drop the restart clause (sessions still die — the convergence behavior itself stays).

- [ ] **Step 5: Rebuild + verify**

Run: `turbo build && bun run verify-types && bun run lint:check && bun run test` (repo root)
Expected: all green (`turbo build` re-infers `@internal/backend-client` after the route-description edit, per `.claude/rules/build.md`).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/api/sessions/restart-session.route.ts apps/backend/src/services/sessions.service.ts .claude/rules/security-context.md apps/mobile/src/types/session.ts apps/mobile/src/lib/api-error.ts
git commit -m "docs(contract): restart is in-place across route, service, security rule, mobile"
```

---

### Task 4: Frontend restart UX — no navigation, alive-keyed terminal

**Files:**
- Modify: `apps/frontend/src/hooks/use-session-mutations.ts`
- Modify: `apps/frontend/src/components/session-actions-menu.tsx` (drop `onRestarted`, ~lines 32/43/51)
- Modify: `apps/frontend/src/routes/sessions_.$id.tsx` (remove the restart/delete `useSessionMutations` callbacks' restart navigation; key `SessionTerminal` by aliveness)

**Interfaces:**
- Consumes: `POST /:id/restart` returning the same id (Task 2/3).
- Produces: `useSessionMutations(id, session, { onDeleted? })` — the `onRestarted` option is **deleted**; restart's only client-side effect is the existing `refresh()` (invalidate list + detail queries).

- [ ] **Step 1: `use-session-mutations.ts`** — delete `onRestarted` from `SessionMutations`'s doc, the options parameter, and the mutation:

```typescript
  const restart = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/sessions/${id}/restart`, { method: "POST" }),
    onSuccess: refresh, // same row, same id: the refreshed queries ARE the sync
  });
```

JSDoc: `restart: "Revives the session in place (same id): new process, conversation resumed where it can"`; the "Restart does not [ask]:" comment becomes "it revives the same session and resumes the conversation — nothing is lost by clicking it." Signature: `{ onDeleted }: { onDeleted?: () => void } = {}`.

- [ ] **Step 2: `session-actions-menu.tsx`** — remove the `onRestarted` prop from the interface, destructuring, and the hook call (keep `onDeleted`).

- [ ] **Step 3: `sessions_.$id.tsx`** — the mutations call loses `onRestarted`; the `onRestarted={(newId) => void navigate(...)}` in the header `SessionActionsMenu` and the `onRestart={() => void restart()}` stay (the latter just runs the mutation). Replace the terminal's key and its comment:

```tsx
        {/* Keyed by aliveness: a restart (or a crash) flipping `alive` changes
            the key and builds a FRESH terminal. The id survives an in-place
            restart, so without this the exited panel would never give way to
            the live terminal — the WS hook inside stopped retrying the moment
            the dead row rejected the attach (4xxx). The restart POST returns
            after the pane spawns, so the fresh hook attaches to a live pane;
            a workspace pane recovers the same way through the 5s detail poll. */}
        <SessionTerminal
          key={`${id}:${session?.alive === false ? "down" : "up"}`}
          sessionId={id}
```

(`session?.alive` is a boolean on `SessionView`; undefined/loading folds into `"up"` so the first mount still attaches.)

- [ ] **Step 4: Sweep stale comments** — anywhere in these three files still saying "restarts as a new row", "follows the user to the fresh session", "a restart follows the user": reword to the in-place truth. Grep: `grep -rn "new row\|newId\|fresh session" apps/frontend/src` and clean every remaining hit that describes restart (leave delete/unrelated matches).

- [ ] **Step 5: Verify**

Run: `bun run verify-types && bun run lint:check && bun run test` from repo root (or `--cwd apps/frontend`)
Expected: green; any component test referencing `onRestarted` gets the prop expectation deleted.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/hooks/use-session-mutations.ts apps/frontend/src/components/session-actions-menu.tsx apps/frontend/src/routes/sessions_.\$id.tsx
git commit -m "feat(frontend): restart stays on the same id, terminal keyed by aliveness"
```

---

### Task 5: `NetworkError` at the fetch boundary (test-first)

**Files:**
- Modify: `apps/frontend/src/lib/api.ts`
- Test: Create `apps/frontend/src/lib/__tests__/api.test.ts`

**Interfaces:**
- Consumes: nothing (this is the bottom of the stack).
- Produces: `class NetworkError extends Error`, `function isNetworkError(err: unknown): boolean`; `apiFetch`/`apiPost` reject with `NetworkError` when `fetch` itself rejects, `ApiError` otherwise. Tasks 6-8 import `isNetworkError`.

- [ ] **Step 1: Write the failing tests** — `apps/frontend/src/lib/__tests__/api.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, NetworkError, apiFetch, isNetworkError } from "@/lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("apiFetch error classes", () => {
  it("wraps a rejected fetch in NetworkError (no HTTP answer at all)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await apiFetch("/api/anything").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(isNetworkError(err)).toBe(true);
  });

  it("HTTP failures stay ApiError — the server ANSWERED, it is reachable", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ errId: "e1", code: "NOT_FOUND_ERROR", message: "gone", statusCode: 404 }),
        { status: 404 },
      )) as unknown as typeof fetch;
    const err = await apiFetch("/api/anything").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isNetworkError(err)).toBe(false);
    expect((err as ApiError).status).toBe(404);
  });

  it("isNetworkError matches only NetworkError (plain errors stay fail-fast)", () => {
    expect(isNetworkError(new NetworkError(new TypeError("x")))).toBe(true);
    expect(isNetworkError(new TypeError("x"))).toBe(false);
    expect(isNetworkError(new Error("boom"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test src/lib/__tests__/api.test.ts`
Expected: FAIL — `NetworkError` is not exported (import-time error).

- [ ] **Step 3: Implement in `api.ts`** — add after the `ApiError` class:

```typescript
/**
 * The request never got an HTTP answer — DNS failure, refused connection,
 * dropped socket: the server (or its proxy) is DOWN. `ApiError` means the
 * opposite (something answered with a status). The retry policy and the
 * offline banner both key off this one distinction.
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? `Server unreachable: ${cause.message}` : "Server unreachable", { cause });
    this.name = "NetworkError";
  }
}

/** True when a caught failure means "no HTTP answer" (see {@link NetworkError}). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof NetworkError;
}
```

and wrap ONLY the fetch call in `apiFetch` (`res.json()`/`res.text()` failures keep their existing behavior — a mid-body drop surfaces as a plain parse error to callers, as today):

```typescript
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new NetworkError(err);
  }
```

- [ ] **Step 4: Run to verify PASS, then commit**

Run: `cd apps/frontend && bun test src/lib/__tests__/api.test.ts && bun run verify-types`

```bash
git add apps/frontend/src/lib/api.ts apps/frontend/src/lib/__tests__/api.test.ts
git commit -m "feat(frontend): NetworkError distinguishes a down server from an HTTP answer"
```

---

### Task 6: Network-aware retry policy in the shared QueryClient (test-first)

**Files:**
- Modify: `apps/frontend/src/lib/query-client.ts`
- Test: Create `apps/frontend/src/lib/__tests__/query-client.test.ts`

**Interfaces:**
- Consumes: `isNetworkError` (Task 5).
- Produces: exported pure `queryRetry(failureCount: number, err: unknown): boolean` and `queryRetryDelay(attempt: number, err: unknown): number`, installed as the shared client's query defaults. Task 7 reads the same cache the policy keeps retrying.

- [ ] **Step 1: Write the failing tests** — `apps/frontend/src/lib/__tests__/query-client.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { ApiError, NetworkError } from "@/lib/api";
import { queryRetry, queryRetryDelay } from "@/lib/query-client";

const net = new NetworkError(new TypeError("Failed to fetch"));
const http404 = new ApiError(404, "gone");

describe("queryRetry", () => {
  it("retries network errors up to the cap (~60 attempts ride out a long outage)", () => {
    expect(queryRetry(0, net)).toBe(true);
    expect(queryRetry(59, net)).toBe(true);
    expect(queryRetry(60, net)).toBe(false);
  });
  it("HTTP errors keep failing fast: exactly one retry, as before", () => {
    expect(queryRetry(0, http404)).toBe(true);
    expect(queryRetry(1, http404)).toBe(false);
  });
  it("non-Error throwables are not network errors", () => {
    expect(queryRetry(0, "string failure")).toBe(true); // the single legacy retry
    expect(queryRetry(1, "string failure")).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  it("backs off exponentially for network errors, capped at 15s", () => {
    expect(queryRetryDelay(0, net)).toBe(1000);
    expect(queryRetryDelay(1, net)).toBe(2000);
    expect(queryRetryDelay(4, net)).toBe(15_000); // capped before 16s
    expect(queryRetryDelay(30, net)).toBe(15_000);
  });
  it("HTTP errors retry once, immediately after (the old default shape)", () => {
    expect(queryRetryDelay(0, http404)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd apps/frontend && bun test src/lib/__tests__/query-client.test.ts` (exports missing).

- [ ] **Step 3: Implement in `query-client.ts`:**

```typescript
import { QueryClient } from "@tanstack/react-query";
import { isNetworkError } from "@/lib/api";

/** Cap on network-error retries: ~60 capped-backoff attempts ride out a
 * ~15-minute outage; past that the operator needs more than a retry loop. */
const NETWORK_RETRY_MAX = 60;

/**
 * Query retry rule: a DOWN server (`NetworkError`) retries until the cap so
 * every screen self-heals when the server returns — no manual "Try again".
 * An HTTP answer (the server is up and said no) keeps the historical
 * single-retry behavior so auth failures and 404s still surface fast.
 */
export function queryRetry(failureCount: number, err: unknown): boolean {
  return isNetworkError(err) ? failureCount < NETWORK_RETRY_MAX : failureCount < 1;
}

/** Exponential backoff capped at 15 s while the server is unreachable;
 * HTTP retries keep the default first-retry delay (1 s). */
export function queryRetryDelay(attempt: number, err: unknown): number {
  return isNetworkError(err) ? Math.min(1000 * 2 ** attempt, 15_000) : 1000;
}

/**
 * Shared React Query client. HTTP errors surface quickly (see
 * {@link queryRetry}); only a server that is DOWN keeps retrying, driven
 * visible by the OfflineBanner. Mutations do NOT retry — a lifecycle click
 * into the void fails visibly and the user re-fires it once the banner clears.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: queryRetry,
      retryDelay: queryRetryDelay,
      refetchOnWindowFocus: false,
    },
  },
});
```

- [ ] **Step 4: Run to verify PASS; `bun run test` for the frontend suite to catch any hook test pinned to the old retry count; commit**

```bash
git add apps/frontend/src/lib/query-client.ts apps/frontend/src/lib/__tests__/query-client.test.ts
git commit -m "feat(frontend): query retry policy rides out server downtime and self-heals"
```

---

### Task 7: Derived offline store (test-first)

**Files:**
- Create: `apps/frontend/src/lib/server-status.ts`
- Create: `apps/frontend/src/hooks/use-server-offline.ts`
- Test: Create `apps/frontend/src/lib/__tests__/server-status.test.ts`

**Interfaces:**
- Consumes: `isNetworkError` (Task 5); a TanStack `QueryClient` (any instance — the store is a factory so tests get their own).
- Produces: `createServerStatusStore(client): { subscribe(cb): () => void; getSnapshot(): boolean }`, module-level `serverStatus` bound to the shared client, `subscribeServerStatus` / `getServerSnapshot` stable references; `useServerOffline(): boolean` hook. Task 8's banner consumes the hook.

- [ ] **Step 1: Write the failing tests** — `apps/frontend/src/lib/__tests__/server-status.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { NetworkError } from "@/lib/api";
import { createServerStatusStore } from "@/lib/server-status";

async function settle(qc: QueryClient) {
  await new Promise((r) => setTimeout(r, 0));
  // let any queued cache events flush
  await qc.cancelQueries();
}

describe("createServerStatusStore", () => {
  it("goes offline when an ACTIVE query is stuck on NetworkError, online when it recovers", async () => {
    let fail = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createServerStatusStore(qc);
    const seen: boolean[] = [];
    const unsub = store.subscribe(() => seen.push(store.getSnapshot()));

    const obs = new QueryObserver(qc, {
      queryKey: ["probe"],
      queryFn: async () => {
        if (fail) throw new NetworkError(new TypeError("down"));
        return "up";
      },
    });
    const unsubObs = obs.subscribe(() => {});
    await obs.refetch().catch(() => {});
    await settle(qc);
    expect(store.getSnapshot()).toBe(true);

    fail = false;
    await obs.refetch().catch(() => {});
    await settle(qc);
    expect(store.getSnapshot()).toBe(false);
    expect(seen).toEqual([true, false]); // transitions, not repeats

    unsubObs();
    unsub();
  });

  it("ignores errors from UNMOUNTED queries and non-network errors", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createServerStatusStore(qc);
    const unsub = store.subscribe(() => {});

    await qc
      .fetchQuery({ queryKey: ["inactive-net"], queryFn: async () => { throw new NetworkError(new TypeError("x")); } })
      .catch(() => {});
    await qc.fetchQuery({ queryKey: ["http-500"], queryFn: async () => { throw new Error("API 500: boom"); } }).catch(() => {});
    await settle(qc);
    expect(store.getSnapshot()).toBe(false); // never mounted => not the user's view of reality

    unsub();
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (module missing).

- [ ] **Step 3: Implement `server-status.ts`:**

```typescript
import type { QueryClient } from "@tanstack/react-query";
import { isNetworkError } from "@/lib/api";
import { queryClient } from "@/lib/query-client";

/** What the shell needs: a boolean snapshot + a subscription. */
export interface ServerStatusStore {
  /** Registers a listener; called on every offline↔online transition. Returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** Current truth: true while any ACTIVE query is stuck on a NetworkError. */
  getSnapshot(): boolean;
}

/**
 * Derives "the mote server is unreachable" from the query cache — it never
 * polls. The QueryClient's network-retry loop (query-client.ts) IS the probe:
 * while any active query sits in `NetworkError` the server is down; the first
 * successful retry fires a cache event and the state clears. Factory form so
 * tests bind a store to their own client; the app uses the shared singleton.
 */
export function createServerStatusStore(client: QueryClient): ServerStatusStore {
  let offline = false;
  let watching = false;
  const listeners = new Set<() => void>();

  const compute = () =>
    client
      .getQueryCache()
      .getAll()
      .some((q) => q.isActive() && q.state.status === "error" && isNetworkError(q.state.error));

  const refresh = () => {
    const next = compute();
    if (next === offline) return;
    offline = next;
    for (const l of [...listeners]) l();
  };

  return {
    subscribe(cb) {
      if (!watching) {
        watching = true;
        client.getQueryCache().subscribe(refresh);
      }
      listeners.add(cb);
      if (listeners.size === 1) refresh(); // catch failures predating the first mount
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => offline,
  };
}

/** The app-wide store over the shared client. */
export const serverStatus = createServerStatusStore(queryClient);
/** Stable references for useSyncExternalStore. */
export const subscribeServerStatus = (cb: () => void) => serverStatus.subscribe(cb);
export const getServerSnapshot = () => serverStatus.getSnapshot();
```

And `use-server-offline.ts`:

```typescript
import { useSyncExternalStore } from "react";
import { getServerSnapshot, subscribeServerStatus } from "@/lib/server-status";

/** True while the shared query cache shows any active query stuck on a
 * network error — i.e. the mote server is unreachable and retrying. */
export function useServerOffline(): boolean {
  return useSyncExternalStore(subscribeServerStatus, getServerSnapshot, getServerSnapshot);
}
```

- [ ] **Step 4: Run to verify PASS; commit**

```bash
git add apps/frontend/src/lib/server-status.ts apps/frontend/src/hooks/use-server-offline.ts apps/frontend/src/lib/__tests__/server-status.test.ts
git commit -m "feat(frontend): derived server-offline store (no polling, cache-driven)"
```

---

### Task 8: Banner + the lying-card fixes

**Files:**
- Create: `apps/frontend/src/components/offline-banner.tsx`
- Modify: `apps/frontend/src/routes/__root.tsx` (mount banner; hold the login redirect while offline)
- Modify: `apps/frontend/src/routes/workspaces_.$id.tsx` (~lines 24-59: not-found gated on a real 404)
- Modify: `apps/frontend/src/routes/index.tsx` (~line 104: copy)

**Interfaces:**
- Consumes: `useServerOffline` (Task 7), `isNetworkError`/`ApiError` (Task 5).
- Produces: `<OfflineBanner />` component.

- [ ] **Step 1: `offline-banner.tsx`:**

```tsx
import { StatusPill } from "@/components/status-pill";
import { useServerOffline } from "@/hooks/use-server-offline";

/**
 * App-wide "server unreachable" notice: shown while any active query sits in
 * the NetworkError retry loop (see lib/server-status.ts), and it clears by
 * itself the moment a retry lands — the same transient-state vocabulary as
 * LiveStatus's "Reconnecting…". Fixed to the shell top so every page gets it
 * without owning an offline branch; bare pre-auth pages never mount it (they
 * own their error UX, and a down server there is not a blip to wait out).
 */
export function OfflineBanner() {
  const offline = useServerOffline();
  if (!offline) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center">
      {/* Static positioning overrides: StatusPill's default absolute-centering
          is for a positioned parent; the fixed strip centers us already. */}
      <StatusPill tone="warning" className="relative top-0 left-0 translate-x-0">
        Can&apos;t reach the mote server — retrying…
      </StatusPill>
    </div>
  );
}
```

- [ ] **Step 2: `__root.tsx`.** Import `OfflineBanner` and `isNetworkError`. Pull the error out of the session hook: `const { data: user, isLoading, error: userError } = useCurrentUser();`. The signed-out redirect block gains one guard line (a down server is NOT a sign-out — this is the difference between "reconnecting" and being bounced to a login form whose endpoint is also down):

```typescript
  if (isLoading) return null;
  // A server outage is not a sign-out: while the session query itself is in
  // the network-retry loop, hold the frame (the OfflineBanner explains)
  // instead of bouncing to /login against an unreachable endpoint.
  if (!user && !isNetworkError(userError)) {
    if (setupLoading && !bare) return null;
    if (needsSetup && location.pathname !== "/setup") return <Navigate to="/setup" />;
    if (needsSetup === false && !bare) {
      return <Navigate to="/login" search={{ redirect: location.pathname }} />;
    }
  }
```

Mount the banner as the frame's first child inside the `h-dvh` div: `{!bare && <OfflineBanner />}`.

- [ ] **Step 3: `workspaces_.$id.tsx`.** Import `ApiError` from `@/lib/api`. After the hook:

```typescript
  // "Not found" must be the server's ANSWER (404), never the absence of one:
  // during an outage (NetworkError) or any other first-load failure the
  // query layer retries on its own (query-client.ts), so hold the loading
  // state and let it heal instead of declaring the workspace deleted.
  const notFound = !detail && error instanceof ApiError && error.status === 404;
```

Change the `if (!detail)` card to `if (notFound)`, and make the loading branch cover the still-retrying case: `if (isLoading || !detail) return <loading card>` (placed BEFORE the `notFound` check is wrong — order: `isLoading || (notFound ? false : !detail)` … spell it plainly):

```tsx
  if (isLoading || (!detail && !notFound)) {
    return (
      <main className="mx-auto w-full max-w-2xl p-6">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    );
  }
  if (notFound) {
    /* the existing card, unchanged JSX */
  }
```

Also pull `error` from the existing `useWorkspace(id)` destructure (`const { data: detail, isLoading, error, refetch } = useWorkspace(id);`) and extend the existing `!detail`-keyed comment above it to mention the 404 gate (the comment's existing "background refetch keeps last-good data" point stays true and stays relevant).

- [ ] **Step 4: `index.tsx`** — message-only edit: `message="Couldn't load sessions — retrying…"` and extend the block's existing comment by one sentence: "Network failures now also self-heal via the query retry loop; the button remains for HTTP failures and the impatient."

- [ ] **Step 5: Verify + manual spot check + commit**

Run: `bun run verify-types && bun run lint:check && bun run test` from repo root.
Spot check (dev servers already on their ports per backend/frontend AGENTS.md): with the backend stopped, load `/workspaces/<id>` — must show "Loading…" + the offline pill, NEVER "Workspace not found"; restart the backend — data appears without a click.

```bash
git add apps/frontend/src/components/offline-banner.tsx apps/frontend/src/routes/__root.tsx apps/frontend/src/routes/workspaces_.\$id.tsx apps/frontend/src/routes/index.tsx
git commit -m "feat(frontend): offline banner; downtime no longer reads as deleted data"
```

---

### Task 9: iPhone one-finger touch scroll on the xterm surface

**Files:**
- Create: `apps/frontend/src/lib/terminal-touch-scroll.ts`
- Create: `apps/frontend/src/lib/__tests__/terminal-touch-scroll.test.ts`
- Modify: `apps/frontend/src/components/session-terminal.tsx` (attach after `term.open`, detach in cleanup)

**Interfaces:**
- Consumes: `Terminal.scrollLines` (public xterm API); `.xterm-screen` element inside the terminal container.
- Produces: `attachTouchScroll(term: Terminal, root: HTMLElement, isTouchUi?: () => boolean): () => void` — returns the detach function.

Root cause (for the reviewer): xterm.js's touch handling calls `preventDefault()` on `touchmove` (long-press selection), which cancels the browser's native panning of `.xterm-viewport` — the `touch-action: pan-y` CSS in `styles.css` §4 promises a pan that never happens on iOS Safari. Our listener runs alongside xterm's (`preventDefault` cancels the default action, not sibling listeners) and drives `scrollLines` directly.

- [ ] **Step 1: Write the failing tests** — `apps/frontend/src/lib/__tests__/terminal-touch-scroll.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { attachTouchScroll } from "@/lib/terminal-touch-scroll";

/** Minimal Terminal stand-in: scrollLines spy + a measurable row height. */
function fakeTerm() {
  const scrolled: number[] = [];
  return {
    scrolled,
    scrollLines(n: number) {
      scrolled.push(n);
    },
  };
}

/** Build the touch Event shape the handler reads (happy-dom has no
 * TouchEvent constructor here; the handler only needs `touches` + preventDefault). */
function touchEvent(type: string, clientY: number) {
  const e = new Event(type) as Event & { touches: { clientY: number }[] };
  Object.defineProperty(e, "touches", { value: [{ clientY }] });
  return e;
}

function setup() {
  const root = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  root.append(screen);
  const term = fakeTerm();
  const detach = attachTouchScroll(term as never, root, () => true);
  return { term, screen, detach };
}

describe("attachTouchScroll", () => {
  it("swipe up scrolls down through history, one line per row height, swipe-up positive", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchEvent("touchstart", 300));
    // 60px up at the 18px fallback row height (the fake has no render
    // metrics) = +3 lines (toward the bottom), 6px carried.
    screen.dispatchEvent(touchEvent("touchmove", 240));
    expect(term.scrolled).toEqual([3]);
    detach();
  });

  it("swipe down scrolls up (into scrollback), carrying the sub-line remainder across moves", () => {
    const { term, screen, detach } = setup();
    screen.dispatchEvent(touchEvent("touchstart", 100));
    screen.dispatchEvent(touchEvent("touchmove", 115)); // 15px down => 0 lines at 18px, carry -15
    screen.dispatchEvent(touchEvent("touchmove", 122)); // +7 more => carry -22 => -1 line
    expect(term.scrolled).toEqual([-1]);
    detach();
  });

  it("two-finger moves are ignored (pinch/zoom is nobody's business)", () => {
    const { term, screen, detach } = setup();
    const two = touchEvent("touchstart", 100);
    Object.defineProperty(two, "touches", { value: [{ clientY: 100 }, { clientY: 120 }] });
    screen.dispatchEvent(two);
    screen.dispatchEvent(touchEvent("touchmove", 40));
    expect(term.scrolled).toEqual([]);
    detach();
  });

  it("detaches: moves after detach do nothing", () => {
    const { term, screen, detach } = setup();
    detach();
    screen.dispatchEvent(touchEvent("touchstart", 300));
    screen.dispatchEvent(touchEvent("touchmove", 100));
    expect(term.scrolled).toEqual([]);
  });

  it("no-op on non-touch UIs (desktop stays byte-identical)", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    root.append(screen);
    const term = fakeTerm();
    attachTouchScroll(term as never, root, () => false);
    screen.dispatchEvent(touchEvent("touchstart", 300));
    screen.dispatchEvent(touchEvent("touchmove", 100));
    expect(term.scrolled).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** (module missing).

- [ ] **Step 3: Implement `terminal-touch-scroll.ts`:**

```typescript
import type { Terminal } from "@xterm/xterm";

/** Fallback row height when the renderer's metrics are unreachable. */
const FALLBACK_ROW_PX = 18;
/** Testable override of the styles.css `@media (pointer: coarse)` gate. */
const defaultIsTouchUi = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

/** The renderer's measured CSS row height, private-path-guarded (same
 * tolerated pattern as the rest of our xterm internals poking; falls back
 * rather than throwing so a resize during a swipe can never kill scrolling). */
function rowHeightPx(term: Terminal): number {
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })
    ._core;
  const h = core?._renderService?.dimensions?.css?.cell?.height;
  return h && h > 0 ? h : FALLBACK_ROW_PX;
}

/**
 * One-finger swipe scrolling for touch devices (the iPhone bug).
 *
 * xterm.js calls preventDefault() on touchmove for its long-press text
 * selection, which cancels the browser's native pan of `.xterm-viewport` —
 * the `touch-action: pan-y` block in styles.css promises a gesture iOS never
 * delivers. A listener of our own still runs (preventDefault cancels the
 * DEFAULT action, not sibling listeners), so this module drives the scroll:
 * vertical swipe distance is converted into terminal LINES (xterm's wheel
 * unit, so swipe and wheel feel identical) with the sub-line remainder
 * carried between events. We also preventDefault to keep the shell's scroll
 * container and any late native pan from double-scrolling.
 *
 * Attaches to `.xterm-screen` (the grid body — outside it, the page still
 * scrolls normally: headers, lists, settings). Returns the detach fn.
 */
export function attachTouchScroll(
  term: Terminal,
  root: HTMLElement,
  isTouchUi: () => boolean = defaultIsTouchUi,
): () => void {
  if (!isTouchUi()) return () => {};
  const target = root.querySelector<HTMLElement>(".xterm-screen") ?? root;
  let lastY: number | null = null;
  let carry = 0;

  const onStart = (e: TouchEvent) => {
    // Only single-finger gestures scroll; a second finger (pinch) ends the
    // scroll gesture cleanly so its removal can't cause a jump.
    if (e.touches.length === 1) {
      lastY = e.touches[0]?.clientY ?? null;
      carry = 0;
    } else {
      lastY = null;
    }
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1 || lastY === null) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    const dy = lastY - y; // finger UP => positive => scroll toward the bottom
    lastY = y;
    e.preventDefault();
    const rowPx = rowHeightPx(term);
    carry += dy;
    const lines = Math.trunc(carry / rowPx);
    if (lines !== 0) {
      carry -= lines * rowPx;
      term.scrollLines(lines);
    }
  };
  const onEnd = () => {
    lastY = null;
    carry = 0;
  };

  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchmove", onMove, { passive: false }); // must be able to preventDefault
  target.addEventListener("touchend", onEnd, { passive: true });
  target.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchmove", onMove);
    target.removeEventListener("touchend", onEnd);
    target.removeEventListener("touchcancel", onEnd);
  };
}
```

- [ ] **Step 4: Wire into `session-terminal.tsx`** — in the mount effect, right after `term.open(containerRef.current); fit.fit();` (line ~234-235):

```typescript
    // iPhone/iPad: xterm's own touchmove preventDefault kills the CSS pan
    // (see lib/terminal-touch-scroll.ts); this drives line-scroll instead.
    const detachTouchScroll = attachTouchScroll(term, containerRef.current);
```

and in that effect's cleanup, before `term.dispose()` (line ~275): `detachTouchScroll();`. Import: `import { attachTouchScroll } from "@/lib/terminal-touch-scroll";`. (Workspace panes get it free — they share this component.)

- [ ] **Step 5: Run to verify PASS; commit**

Run: `cd apps/frontend && bun test src/lib/__tests__/terminal-touch-scroll.test.ts`

```bash
git add apps/frontend/src/lib/terminal-touch-scroll.ts apps/frontend/src/lib/__tests__/terminal-touch-scroll.test.ts apps/frontend/src/components/session-terminal.tsx
git commit -m "fix(frontend): one-finger touch scrolling on the xterm surface (iOS)

xterm's touchmove preventDefault (long-press selection) cancelled the
native pan the CSS promised; drive scrollLines from swipe deltas instead,
in line units so swipe and wheel feel identical."
```

---

### Task 10: Full verification + manual probe checklist

- [ ] **Step 1:** From repo root: `bun run verify-types && bun run lint:check && bun run test && turbo build` — all four green. Fix anything red (implementation, not expectations, unless an expectation encodes the old clone contract).
- [ ] **Step 1b:** Confirm the spec's e2e assumption: `grep -rn "restart" e2e/ --include="*.ts" | grep -v playwright-report` must show no assertions on the clone contract (the spec's grep found none — re-verify).
- [ ] **Step 2:** Dev probe (backend on :3080, frontend on :5174; see the "backend single instance" memory — restart via the tracked task, and note the test DB is per-process so nothing collides):
  1. Open a running session page; click Restart → **URL/id unchanged**, terminal briefly re-keys and reattaches, harness conversation resumed (claude `--resume`).
  2. On an exited session's panel click Restart → same id, terminal returns.
  3. Stop the backend: global pill "Can't reach the mote server — retrying…" appears on the sessions list and the workspace page shows Loading (NOT "Workspace not found"); you stay on the page, not bounced to /login. Start the backend: everything heals without clicks.
  4. iPhone (or devtools touch emulation at a coarse pointer + `Cmd-Shift-M`): one-finger swipe on the session terminal scrolls xterm's scrollback; the page around it still scrolls where it should (headers, session list).
- [ ] **Step 3:** If a probe step fails, fix and re-run its task's tests; commit fixes.

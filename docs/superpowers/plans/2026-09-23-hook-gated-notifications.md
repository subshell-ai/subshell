# Hook-gated notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the notification spam — the `turn_complete` push fires only for genuinely-done turns, approval pushes fire only for notification types that need a human, and one pane pushes at most once until its owner opens it (escalations excepted).

**Architecture:** Three gates on the existing push pipeline, no new API surface: (1) the shared `report` binary reads the Stop hook's own stdin payload and stays silent when it names running background work; (2) the claude-code plugin's `Notification` hook gains a matcher; (3) `notifySubshell` gains an unseen-escalation gate backed by a new nullable `subshells.last_push_urgency` column, cleared by owner-cookie reads of the pane (REST detail/log routes and the live-terminal attach).

**Tech Stack:** Bun + TypeScript monorepo, Kysely/SQLite migrations, Elysia routes, `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-23-hook-gated-notifications-design.md` (read it first — every rule below traces to it).

## Global Constraints

- Bun only: `bun test`, `bunx` — never npm/npx/vitest.
- No dynamic imports anywhere; static top-level `import` only.
- The `report` verb contract is absolute: never throws, never prints, every path exits 0. The new gate fails **toward the push** (spec §1's table) — only a parsed payload with a non-empty `background_tasks`/`session_crons` array suppresses.
- `needs_attention` reports must never read stdin.
- The unseen gate lives ONLY in `notifySubshell` (beside bell + master switch); the `waitingSince` chip paths are untouched.
- Clear sites: cookie actor with `viewerId === row.userId`, and on the WS attach an identity with `identity.subshellId === null` (cookie-minted/unbound — every Bearer-key mint is scoped) and `identity.userId === row.userId`. The list route never clears.
- A new migration must be BOTH created in `apps/server/api/src/db/migrations/` AND registered in the provider map in `apps/server/api/src/db/migrate.ts`; file name and map key must match exactly.
- Server tests run from `apps/server/api` (bunfig preloads `src/test-preload.ts`; the per-package `test` script adds the tmux net, which these suites don't need).
- No new dependencies. No `package.json` version changes except changesets (Task 5).
- JSDoc on every new function; comments describe what is NOT obvious (house style).
- Commits: conventional scope, e.g. `fix(mcp-core): …`, from the worktree branch.

---

### Task 1: Stop-payload gating of `turn_complete` (`packages/mcp-core/src/report.ts`)

**Files:**
- Modify: `packages/mcp-core/src/report.ts` (the `attention` branch of `resolveBody`, plus a new helper)
- Modify: `packages/mcp-core/src/__tests__/report.test.ts` (two existing cases get an injected stdin; one new describe)

**Interfaces:**
- Consumes: nothing new — `ReportIo.readStdin` and `readStdinBounded()` already exist (used by the `session` verb).
- Produces: no new exports. Behavior contract for later tasks: `runReport(["attention","turn_complete"], …)` POSTs exactly when the Stop payload does not name running background work or scheduled crons.

- [ ] **Step 1: Write the failing tests**

In `packages/mcp-core/src/__tests__/report.test.ts`:

(a) Update the existing case `"posts the attention kind to the subshell's own attention endpoint"` (line ~30) so it no longer depends on real stdin — replace its call line

```ts
    await runReport(["attention", "turn_complete"], { env: paneEnv, fetch: fetchImpl });
```

with

```ts
    await runReport(["attention", "turn_complete"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => "",
    });
```

(b) Same for `"swallows a failing transport rather than throwing into the hook"` (line ~74):

```ts
    expect(
      await runReport(["attention", "turn_complete"], {
        env: paneEnv,
        fetch: failing,
        readStdin: async () => "",
      }),
    ).toBeUndefined();
```

(c) Append this new describe at the end of the file (it needs no imports beyond what the file already has):

```ts
describe("turn_complete gating on the Stop payload (spec 2026-09-23)", () => {
  const paneEnv = {
    SUBSHELL_API_KEY: "subshell_key123",
    SUBSHELL_BASE_URL: "http://h:3080",
    SUBSHELL_ID: "sub_42",
  } as NodeJS.ProcessEnv;

  /** Runs one report and returns how many POSTs it made. */
  async function posts(argv: string[], stdin: () => Promise<string>): Promise<number> {
    let calls = 0;
    await runReport(argv, {
      env: paneEnv,
      readStdin: stdin,
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    return calls;
  }

  it("reports nothing when the Stop payload names running background work", async () => {
    expect(
      await posts(["attention", "turn_complete"], async () =>
        JSON.stringify({ background_tasks: [{ id: "t1", type: "subagent", status: "running" }] }),
      ),
    ).toBe(0);
  });

  it("reports nothing when a scheduled cron will wake the session", async () => {
    expect(
      await posts(["attention", "turn_complete"], async () =>
        JSON.stringify({ background_tasks: [], session_crons: [{ id: "c1" }] }),
      ),
    ).toBe(0);
  });

  it("reports when both arrays are present and empty (reachable-and-done)", async () => {
    expect(
      await posts(["attention", "turn_complete"], async () =>
        JSON.stringify({ background_tasks: [], session_crons: [] }),
      ),
    ).toBe(1);
  });

  it("reports when the payload predates the fields (older Claude Code)", async () => {
    expect(await posts(["attention", "turn_complete"], async () => JSON.stringify({ session_id: "x" }))).toBe(1);
  });

  it("fails toward the push on empty, malformed, and wrong-typed stdin", async () => {
    for (const raw of ["", "not json at all", JSON.stringify({ background_tasks: {} })]) {
      expect(await posts(["attention", "turn_complete"], async () => raw)).toBe(1);
    }
  });

  it("needs_attention never reads stdin, even one naming a park", async () => {
    expect(
      await posts(["attention", "needs_attention"], async () => {
        throw new Error("stdin must not be read for needs_attention");
      }),
    ).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/mcp-core && bun test src/__tests__/report.test.ts`
Expected: the four suppression rows of the new describe FAIL (`expected 0 to be 1` style — the current code POSTs unconditionally); everything else passes.

- [ ] **Step 3: Implement the gate**

In `packages/mcp-core/src/report.ts`, replace the `attention` branch of `resolveBody` (lines 102-106):

```ts
  if (verb === "attention") {
    const kind = rest[0];
    if (!kind || !(ATTENTION_KINDS as readonly string[]).includes(kind)) return undefined;
    // The Stop hook fires for a session PARKED on background work too, and
    // Claude Code hands the hook the arrays that tell the two apart. A
    // `turn_complete` POSTs only for a genuinely-done turn (spec 2026-09-23);
    // `needs_attention` never reads stdin — the plugin's Notification matcher
    // is its filter.
    if (kind === "turn_complete" && (await parkedOnBackgroundWork(io))) return undefined;
    return { path: "attention", json: { kind } };
  }
```

And add the helper after `resolveBody`:

```ts
/**
 * True when this Stop hook's own stdin payload says the session will wake
 * itself: Claude Code documents `background_tasks` / `session_crons`
 * precisely to distinguish "session is done" from "session is paused waiting
 * for background work to wake it back up" (spec 2026-09-23).
 *
 * Everything the gate cannot read answers false — absent or empty stdin,
 * malformed JSON, an older Claude Code without the fields, and the docs'
 * own caveat that an unreachable registry presents as empty arrays. The
 * gate fails TOWARD the push: a wrong suppression costs silence, a wrong
 * push costs one notification. The outer `runReport` catch must never be
 * what swallows a malformed payload here — its own catch is what turns
 * "unparseable" into "push anyway".
 */
async function parkedOnBackgroundWork(io: ReportIo): Promise<boolean> {
  try {
    const raw = await (io.readStdin ?? readStdinBounded)();
    const parsed = JSON.parse(raw) as { background_tasks?: unknown; session_crons?: unknown };
    return (
      (Array.isArray(parsed.background_tasks) && parsed.background_tasks.length > 0) ||
      (Array.isArray(parsed.session_crons) && parsed.session_crons.length > 0)
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/mcp-core && bun test src/__tests__/report.test.ts`
Expected: all pass, including the pre-existing `session` and `exit` describes.
Also run the package's whole suite: `cd packages/mcp-core && bun test src` → all green.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-core/src/report.ts packages/mcp-core/src/__tests__/report.test.ts
git commit -m "fix(mcp-core): a Stop parked on background work reports no turn_complete"
```

---

### Task 2: Notification matcher on the claude-code plugin

**Files:**
- Modify: `packages/plugins/claude-code/src/index.ts` (`attentionHooks`, ~line 136, and its doc comment ~121-135)
- Modify: `packages/plugins/claude-code/src/__tests__/claude-code.test.ts` (one new case in the `ClaudeCodePlugin attention hooks` describe)

**Interfaces:**
- Consumes: nothing.
- Produces: the emitted `--settings` JSON's `hooks.Notification[0].matcher` is exactly `permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog`. The existing test helper `hooksOf` and fixtures `reporter` / `emptyPreset()` are reused by the new case.

- [ ] **Step 1: Write the failing test**

In `packages/plugins/claude-code/src/__tests__/claude-code.test.ts`, inside `describe("ClaudeCodePlugin attention hooks", …)`, after the case `"emits Stop and Notification hooks that re-enter the reporter binary"` (ends ~line 292), insert:

```ts
  it("narrows the Notification hook to the types that genuinely need a human", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/claude",
      cwd: "/tmp/ws",
      preset: emptyPreset(),
      subshellName: "",
      reporter,
    });
    const idx = cmd.indexOf("--settings");
    expect(idx).toBeGreaterThan(-1);
    const settings = JSON.parse(cmd[idx + 1]) as {
      hooks?: Record<string, [{ matcher?: string; hooks: [{ command: string }] }]>;
    };
    // Without the matcher EVERY notification type rings "Needs your
    // approval": idle_prompt, auth_success, the quota_auto_resume_* family,
    // and elicitation_complete after the human already answered (spec
    // 2026-09-23). This string is the whole filter, so it is pinned exactly.
    expect(settings.hooks?.Notification?.[0]?.matcher).toBe(
      "permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog",
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/plugins/claude-code && bun test src/__tests__/claude-code.test.ts`
Expected: the new case FAILS (`expected undefined to be 'permission_prompt|…'`); all existing cases pass.

- [ ] **Step 3: Implement the matcher**

In `packages/plugins/claude-code/src/index.ts`, replace the `Notification` entry inside `attentionHooks` (lines 138-140):

```ts
  Notification: [
    {
      matcher: "permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog",
      hooks: [{ type: "command", command: reporterHook(host, reporter, "attention", "needs_attention") }],
    },
  ],
```

And extend the `attentionHooks` doc comment: change the first bullet (lines 124-126)

```ts
 * - `Stop` / `Notification` — fire-and-forget attention reporting. The server
 *   gates delivery on the subshell's bell and derives the "waiting for you"
 *   state; a missed event costs one notification, never a broken turn.
```

to

```ts
 * - `Stop` / `Notification` — fire-and-forget attention reporting. The server
 *   gates delivery on the subshell's bell and derives the "waiting for you"
 *   state; a missed event costs one notification, never a broken turn.
 *   `Notification` carries a matcher because the unfiltered hook rang
 *   "Needs your approval" for EVERY notification type — `idle_prompt`,
 *   `auth_success`, `elicitation_complete` after the human had already
 *   answered (spec 2026-09-23). `Stop` reports `turn_complete` blind here:
 *   the reporter reads the hook payload and stays silent for a session
 *   parked on background work (`packages/mcp-core/src/report.ts`).
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/plugins/claude-code && bun test src/__tests__/claude-code.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/claude-code/src/index.ts packages/plugins/claude-code/src/__tests__/claude-code.test.ts
git commit -m "fix(plugin-claude-code): Notification pushes only the types a human must answer"
```

---

### Task 3: The unseen gate in `notifySubshell` (migration + urgency ladder)

**Files:**
- Create: `apps/server/api/src/db/migrations/0035-subshell-push-urgency.ts`
- Modify: `apps/server/api/src/db/migrate.ts` (import + provider-map entry)
- Modify: `apps/server/api/src/db/types/subshells.db-types.ts` (`SubshellTable` + `NewSubshell`)
- Modify: `apps/server/api/src/services/notify.service.ts` (`PUSH_URGENCY`, gate + store in `notifySubshell`, `notifyDevices` returns the live-device count)
- Test: `apps/server/api/src/services/__tests__/notify.service.test.ts` (`freshDb` gains the new migration; one new describe)

**Interfaces:**
- Consumes: `SubshellsRepository.update(id, patch)` (already exists), `NotificationsRepository.upsertForUser` (test-side, already used).
- Produces: `subshells.last_push_urgency` — `number | null` on `SubshellTable`, settable/readable via `SubshellsRepository.findById` / `.update` — Task 4 clears it.

- [ ] **Step 1: Write the failing tests**

In `apps/server/api/src/services/__tests__/notify.service.test.ts`:

(a) Add the imports (alongside the existing migration imports and repository import):

```ts
import * as pushUrgencyMigration from "@/db/migrations/0035-subshell-push-urgency.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
```

(b) In `freshDb()`, after the `presetsMigration.up(...)` line, add:

```ts
  await pushUrgencyMigration.up(db as Kysely<any>); // last_push_urgency (spec 2026-09-23)
```

(c) Append at the end of the file:

```ts
describe("notifySubshell unseen gate (spec 2026-09-23)", () => {
  /** Bell on, one web-push subscription, recording sender. */
  async function gated() {
    const db = await freshDb();
    await (db as Kysely<any>)
      .insertInto("subshells")
      .values({
        id: "s1",
        userId: "u1",
        presetId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
        notify: 1,
      })
      .execute();
    const subs = new NotificationsRepository(db);
    await subs.upsertForUser("u1", "https://push/a", "k", "a");
    const record: { to: string[] } = { to: [] };
    const service = createNotifyService({ subshells: db, subs, sender: sender(record) });
    const urgency = async (): Promise<number | null> =>
      (await new SubshellsRepository(db).findById("s1"))?.lastPushUrgency ?? null;
    return { db, record, service, urgency };
  }

  it("the first turn_complete pushes and marks urgency; its repeat is silent", async () => {
    const { record, service, urgency } = await gated();
    await service.notifySubshell("s1", "turn_complete");
    expect(record.to).toEqual(["https://push/a"]);
    expect(await urgency()).toBe(1);
    await service.notifySubshell("s1", "turn_complete");
    expect(record.to).toHaveLength(1);
  });

  it("needs_attention escalates over an unseen done; its own repeat and a later done do not", async () => {
    const { record, service, urgency } = await gated();
    await service.notifySubshell("s1", "turn_complete");
    await service.notifySubshell("s1", "needs_attention");
    expect(record.to).toHaveLength(2);
    expect(await urgency()).toBe(2);
    await service.notifySubshell("s1", "needs_attention");
    await service.notifySubshell("s1", "turn_complete");
    expect(record.to).toHaveLength(2);
  });

  it("death rings over any unseen state; crashed_final rings over an unseen crashed", async () => {
    const { record, service, urgency } = await gated();
    await service.notifySubshell("s1", "needs_attention");
    await service.notifySubshell("s1", "exited");
    expect(record.to).toHaveLength(2);
    expect(await urgency()).toBe(3);
    // Same-rank repeats are silent: the ladder is strictly-outranks.
    await service.notifySubshell("s1", "crashed");
    expect(record.to).toHaveLength(2);
    await service.notifySubshell("s1", "crashed_final");
    expect(record.to).toHaveLength(3);
    expect(await urgency()).toBe(4);
  });

  it("an undelivered attempt (no subscribers, no devices) marks nothing", async () => {
    const db = await freshDb();
    await (db as Kysely<any>)
      .insertInto("subshells")
      .values({
        id: "s1",
        userId: "u1",
        presetId: "p",
        harnessId: "h",
        name: "n",
        workingDir: "/tmp",
        tmuxSocket: null,
        notify: 1,
      })
      .execute();
    const record: { to: string[] } = { to: [] };
    const service = createNotifyService({
      subshells: db,
      subs: new NotificationsRepository(db),
      sender: sender(record),
    });
    await service.notifySubshell("s1", "turn_complete");
    expect(record.to).toHaveLength(0);
    expect((await new SubshellsRepository(db).findById("s1"))?.lastPushUrgency).toBeNull();
    // And the pane is not silenced by it: with a subscription now present,
    // the event rings.
    await new NotificationsRepository(db).upsertForUser("u1", "https://push/b", "k", "a");
    await service.notifySubshell("s1", "turn_complete");
    expect(record.to).toEqual(["https://push/b"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server/api && bun test src/services/__tests__/notify.service.test.ts`
Expected: FAIL at the new migration import (`Cannot find module '@/db/migrations/0035-…'`).

- [ ] **Step 3: Write the migration**

Create `apps/server/api/src/db/migrations/0035-subshell-push-urgency.ts`:

```ts
import { type Kysely } from "kysely";

/**
 * One notification per unseen interval (spec 2026-09-23).
 *
 * `last_push_urgency` is the urgency of the last DELIVERED push attempt this
 * pane made that its owner has not answered by opening the pane: NULL =
 * nothing unseen. The urgency ladder itself lives beside the gate in
 * `services/notify.service.ts` (only notify.service and the clear sites
 * interpret the number); this column stores it. Nothing here backfills — a
 * row created before the column exists has, correctly, never pushed under
 * the new rule.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").addColumn("last_push_urgency", "integer").execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("subshells").dropColumn("last_push_urgency").execute();
}
```

Register in `apps/server/api/src/db/migrate.ts`: add the import after the 0034 one (line 36):

```ts
import * as pushUrgencyMigration from "@/db/migrations/0035-subshell-push-urgency.js";
```

and the map entry after `"0034-favorites-node-scope": favoritesNodeScopeMigration,`:

```ts
          // One push per unseen interval: the urgency of the last delivered
          // push a pane has not had answered (spec 2026-09-23).
          "0035-subshell-push-urgency": pushUrgencyMigration,
```

- [ ] **Step 4: Extend the DB types**

In `apps/server/api/src/db/types/subshells.db-types.ts`, after the `waitingSince` property (line ~58) in `SubshellTable`:

```ts
  /**
   * Urgency (see notify.service) of the last delivered push attempt the
   * owner has not answered by opening the pane; NULL = nothing unseen.
   * See migration 0035.
   */
  lastPushUrgency: number | null;
```

In the same file's `NewSubshell`: add `"lastPushUrgency"` to the `Omit<…>` union (next to `"waitingSince"`, line ~99) and add to the optional block (next to `waitingSince?: string | null;`):

```ts
  lastPushUrgency?: number | null;
```

- [ ] **Step 5: Implement the gate in `notify.service.ts`**

After the `BODY` constant (line ~44) add:

```ts
/**
 * The unseen gate's ladder (spec 2026-09-23): a delivered push silences its
 * pane's follow-ups until the owner opens the pane, and only an event that
 * strictly OUTRANKS the unseen one rings through. `crashed_final` tops it —
 * the restart loop giving up is news even behind an unseen `crashed`.
 */
const PUSH_URGENCY: Record<NotifyKind, number> = {
  turn_complete: 1,
  needs_attention: 2,
  exited: 3,
  crashed: 3,
  maintenance: 3,
  crashed_final: 4,
};
```

Change `notifyDevices` (line ~123) to report what it actually had to deliver:

```ts
  /** @returns the number of relay-usable device tokens this fan-out targeted */
  async function notifyDevices(row: SubshellTable, kind: NotifyKind): Promise<number> {
    if (!deps.devices) return 0;
```

— and its early returns become `return 0;` (both of them: `if (enrolled.length === 0) return 0;` and `if (live.length === 0) return 0;`), and after the send `try/catch` block, the function's last line before closing brace:

```ts
    return live.length;
```

Replace the body of `notifySubshell` (lines ~180-219) — everything between its `try {` and its `catch` stays byte-identical EXCEPT the three additions marked:

```ts
    async notifySubshell(subshellId: string, kind: NotifyKind): Promise<void> {
      try {
        const row = await subshellsRepo.findById(subshellId);
        if (row?.notify !== 1) return;
        // Per-user master switch (spec 2026-08-31): off ⇒ total silence
        // regardless of any subshell bells. Read of user_meta only; a missing
        // row reads as enabled (getNotifyEnabled defaults to on).
        if (!(await userMetaRepo.getNotifyEnabled(row.userId))) return;
        // The unseen gate (spec 2026-09-23): one push per unseen interval,
        // broken only by an escalation. The waiting chip is deliberately NOT
        // part of this — recordAttention still stamps every event; only the
        // bell waits.
        const urgency = PUSH_URGENCY[kind];
        if ((row.lastPushUrgency ?? 0) >= urgency) return;
        // The transports are independent. Start the device fan-out NOW, before
        // the sequential web-push loop, so a phone never waits behind N HTTPS
        // round-trips to browser push gateways (review, efficiency #6).
        const deviceDelivery = notifyDevices(row, kind);
        const subs = await deps.subs.listByUser(row.userId);
        if (subs.length > 0) {
          const payload = JSON.stringify(buildNotificationPayload(row, kind));
          for (const sub of subs) {
            try {
              await send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
            } catch (err) {
              const status = (err as { statusCode?: number }).statusCode;
              // 404/410 = the endpoint is gone. 403 = the gateway rejects our
              // VAPID JWT for this binding (Apple's BadJwtToken: the
              // subscription was made against a different server key — e.g.
              // after vapid.json rotation). Nothing we sign can ever heal it,
              // so it joins the prune set; the client re-subscribes on its
              // next enablePush (which now re-binds unconditionally).
              if (status === 403 || status === 404 || status === 410) {
                await deps.subs.deleteByEndpoint(sub.endpoint);
              } else {
                logger.withError(err).warn(`push send failed (kept): ${sub.endpoint.slice(0, 60)}…`);
              }
            }
          }
        }
        const liveDevices = await deviceDelivery;
        // The urgency sticks only behind a DELIVERED attempt: an owner with no
        // subscription and no enrolled device received nothing, and an
        // undelivered event must not silence its pane's future escalations.
        if (subs.length > 0 || liveDevices > 0) {
          await subshellsRepo.update(subshellId, { lastPushUrgency: urgency });
        }
      } catch (err) {
        // Notifications must never break the caller (sweep / hook route).
        logger.withError(err).warn(`notifySubshell(${subshellId}, ${kind}) failed`);
      }
    },
```

Update the `notifySubshell` JSDoc: after its existing text append one sentence:

```ts
     * The unseen gate (spec 2026-09-23): with the bell on, an event pushes
     * only if it outranks the pane's last delivered, still-unseen push; the
     * owner opening the pane clears the state (see `#rememberSeen` in
     * `subshells.service.ts` and the attach path in `ws/attach-resolve.ts`).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/server/api && bun test src/services/__tests__/notify.service.test.ts src/services/__tests__/notify-device.test.ts src/services/__tests__/notify-idle.test.ts`
Expected: all pass (the device test keeps passing because `notifyDevices`'s return value is only consumed internally).

- [ ] **Step 7: Commit**

```bash
git add apps/server/api/src/db/migrations/0035-subshell-push-urgency.ts apps/server/api/src/db/migrate.ts apps/server/api/src/db/types/subshells.db-types.ts apps/server/api/src/services/notify.service.ts apps/server/api/src/services/__tests__/notify.service.test.ts
git commit -m "feat(server): one push per unseen interval, escalation excepted"
```

---

### Task 4: Owner-cookie reads clear the unseen state

**Files:**
- Modify: `apps/server/api/src/services/subshells.service.ts` (new `#rememberSeen` + calls in `getSubshell` ~line 557 and `getSubshellLogTail` ~line 585)
- Modify: `apps/server/api/src/ws/attach-resolve.ts` (clear before the `ok: true` return, ~line 177)
- Test: `apps/server/api/src/api/subshells/__tests__/unseen-push-clear.test.ts` (new)
- Test: `apps/server/api/src/ws/__tests__/attach-resolve.test.ts` (one new describe)

**Interfaces:**
- Consumes: `SubshellTable.lastPushUrgency` (Task 3), `SubshellsRepository.update`, `issueWsToken(userId, subshellId = null)` from `@/ws/ws-token.js`, `SubshellSharesRepository.replaceForSubshell(subshellId, entries, createdBy)`.
- Produces: `SubshellsService`'s private `#rememberSeen(actor: GuardActor, viewerId: string, row: SubshellTable): Promise<void>`. No new exports; no wire changes.

- [ ] **Step 1: Write the failing REST tests**

Create `apps/server/api/src/api/subshells/__tests__/unseen-push-clear.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

/**
 * The unseen gate's clearing side (spec 2026-09-23): opening the pane AS
 * ITS OWNER over a cookie session answers the push. Not a share viewer,
 * not the pane's own token (which resolves as the owner — the one path a
 * prompt-injected agent could use to re-arm its own notifications), not the
 * list route the sidebar polls.
 */
describe("owner-cookie pane reads clear the unseen urgency", () => {
  const owner = { email: `unseen-o-${crypto.randomUUID()}@subshell.local`, pw: "unseen-pass-1" };
  const viewer = { email: `unseen-v-${crypto.randomUUID()}@subshell.local`, pw: "unseen-pass-1" };
  let ownerId: string;
  let viewerId: string;
  let ownerCookie: string;
  let viewerCookie: string;
  const created: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: owner.email,
      name: owner.email,
      passwordHash: await hashPassword(owner.pw),
      role: "user",
    });
    viewerId = await new UsersRepository(db).createUser({
      email: viewer.email,
      name: viewer.email,
      passwordHash: await hashPassword(viewer.pw),
      role: "user",
    });
    ownerCookie = await signIn(owner.email, owner.pw);
    viewerCookie = await signIn(viewer.email, viewer.pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const id of created) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await deleteUserByEmailOrId(owner.email);
    await deleteUserByEmailOrId(viewer.email);
  });

  /** A row owned by `ownerId`, unseen urgency 2, with a `view` share to viewer. */
  async function unseen(share = false): Promise<{ id: string; key?: string }> {
    const id = crypto.randomUUID();
    created.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId: ownerId,
      presetId: "p",
      harnessId: "shell",
      name: "unseen-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    await new SubshellsRepository(db).update(id, { lastPushUrgency: 2 });
    if (share) {
      await new SubshellSharesRepository(db).replaceForSubshell(id, [{ granteeUserId: viewerId, permission: "view" }], ownerId);
    }
    return { id };
  }

  const get = (path: string, cookie?: string, bearer?: string) =>
    app.fetch(
      new Request(`http://localhost:3080/api/subshells/${path}`, {
        headers: {
          ...(cookie ? { cookie: `better-auth.session_token=${cookie}` } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      }),
    );

  const urgencyOf = async (id: string) => (await new SubshellsRepository(db).findById(id))?.lastPushUrgency;

  it("the owner's cookie GET /:id answers the unseen push", async () => {
    const { id } = await unseen();
    expect((await get(id, ownerCookie)).status).toBe(200);
    expect(await urgencyOf(id)).toBeNull();
  });

  it("the owner's cookie GET /:id/log answers it too", async () => {
    const { id } = await unseen();
    await get(`${id}/log`, ownerCookie); // status is not the contract — the clear happens after the access gate, before the log read
    expect(await urgencyOf(id)).toBeNull();
  });

  it("the pane's OWN token does not clear, although it resolves as the owner", async () => {
    const { id } = await unseen();
    const key = await issueSubshellToken(id, ownerId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    expect((await get(id, undefined, key)).status).toBe(200);
    expect(await urgencyOf(id)).toBe(2);
  });

  it("a shared viewer's cookie does not clear the owner's state", async () => {
    const { id } = await unseen(true);
    expect((await get(id, viewerCookie)).status).toBe(200);
    expect(await urgencyOf(id)).toBe(2);
  });

  it("the list route the sidebar polls never clears", async () => {
    const { id } = await unseen();
    const res = await app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        headers: { cookie: `better-auth.session_token=${ownerCookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await urgencyOf(id)).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server/api && bun test src/api/subshells/__tests__/unseen-push-clear.test.ts`
Expected: the first two cases FAIL (`expected 2 to be null`); the three negative cases pass trivially today — that is correct and expected.

- [ ] **Step 3: Implement the REST clears**

In `apps/server/api/src/services/subshells.service.ts`, add the private helper right after `#gate` (ends ~line 548):

```ts
  /**
   * Opening the pane as its owner answers the unseen push (spec 2026-09-23):
   * the stored urgency clears, re-arming follow-ups until the next delivered
   * push. Only a cookie session whose user IS the row's owner — a shared
   * viewer saw a pane that was never theirs to be pushed about, and a
   * machine credential resolves as the owner but attended nothing.
   */
  async #rememberSeen(actor: GuardActor, viewerId: string, row: SubshellTable): Promise<void> {
    if (actor !== "cookie" || viewerId !== row.userId || row.lastPushUrgency === null) return;
    await this.repos.subshells.update(row.id, { lastPushUrgency: null });
  }
```

(If `SubshellTable` is not yet imported in this file, add it to the existing `@/db/types/subshells.db-types.js`-style import — the file already references `SubshellTable` as the return type of `#gate`, so the import exists.)

Call it in `getSubshell` (line ~557), right after the `#gate` line:

```ts
    const { row, access } = await this.#gate(viewerId, id, "view", actor);
    await this.#rememberSeen(actor, viewerId, row);
```

and in `getSubshellLogTail` (line ~585), right after its `#gate` line:

```ts
    const { row } = await this.#gate(viewerId, id, "view", actor);
    await this.#rememberSeen(actor, viewerId, row);
```

- [ ] **Step 4: Run the REST tests to verify they pass**

Run: `cd apps/server/api && bun test src/api/subshells/__tests__/unseen-push-clear.test.ts`
Expected: all 5 pass.

- [ ] **Step 5: Write the failing attach tests**

Append to `apps/server/api/src/ws/__tests__/attach-resolve.test.ts`. It already imports `resolveAttach`, `issueWsToken`, `db`, `getRequestlessContext`, `hashPassword`, `signIn`, `setupAuthTables`, `deleteUserByEmailOrId`, and the file-level `request(query)` helper — reuse them. Add ONE import (line 5 area, alphabetical among the repository imports):

```ts
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
```

```ts
describe("resolveAttach clears the unseen push (spec 2026-09-23)", () => {
  const email = `attach-unseen-${crypto.randomUUID()}@subshell.local`;
  const pw = "attach-unseen-pass-1";
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(email);
  });

  /** The owner's running row with unseen urgency 2. */
  async function unseenRow(): Promise<string> {
    const { repos } = getRequestlessContext();
    const row = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId,
      presetId: "p-test",
      harnessId: "shell",
      name: "attach-unseen",
      workingDir: "/tmp",
      tmuxSocket: "subshell-attach-unseen",
    });
    await repos.subshells.update(row.id, { lastPushUrgency: 2, alive: 1, status: "running" });
    return row.id;
  }

  const urgencyOf = async (id: string) => (await new SubshellsRepository(db).findById(id))?.lastPushUrgency;

  it("the cookie-fallback attach clears it", async () => {
    const id = await unseenRow();
    const res = await resolveAttach({
      url: new URL(`ws://localhost/ws?subshell=${id}`),
      cookieHeader: `better-auth.session_token=${cookie}`,
      attachUa: "test-ua",
    });
    expect(res.ok).toBe(true);
    expect(await urgencyOf(id)).toBeNull();
  });

  it("an UNBOUND (cookie-minted) ws-token attach clears it", async () => {
    const id = await unseenRow();
    const token = issueWsToken(userId); // subshellId null = cookie's spelling
    const res = await resolveAttach(request(`subshell=${id}&token=${token}`));
    expect(res.ok).toBe(true);
    expect(await urgencyOf(id)).toBeNull();
  });

  it("a SCOPED (Bearer-minted) token resolves as the owner but attends nothing", async () => {
    const id = await unseenRow();
    const token = issueWsToken(userId, id);
    const res = await resolveAttach(request(`subshell=${id}&token=${token}`));
    expect(res.ok).toBe(true);
    expect(await urgencyOf(id)).toBe(2);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/server/api && bun test src/ws/__tests__/attach-resolve.test.ts`
Expected: the two clearing cases FAIL (urgency still 2); the scoped case passes today already.

- [ ] **Step 7: Implement the attach clear**

In `apps/server/api/src/ws/attach-resolve.ts`, between the `logger.info(attachJournalLine(...))` line (177) and the `return { ok: true, … }` line (178), insert:

```ts
  // Attention answers the unseen push (spec 2026-09-23). The human marker is
  // `identity.subshellId === null`: the cookie fallback and the cookie-minted
  // ws-token are the ONLY unbound identities — every Bearer-key mint is bound
  // at issue, including a system key's — so a machine credential that
  // resolves as the owner still attends nothing, and the owner check is the
  // row itself. Best-effort: an uncleared urgency costs one extra escalation,
  // a throwing update must not refuse an admitted attach.
  if (identity.subshellId === null && identity.userId === row.userId && row.lastPushUrgency !== null) {
    try {
      await repos.subshells.update(row.id, { lastPushUrgency: null });
    } catch {
      logger.warn(`unseen-push clear failed for ${row.id} (escalation may double)`);
    }
  }
```

- [ ] **Step 8: Run all touched server suites to verify green**

Run: `cd apps/server/api && bun test src/ws/__tests__/attach-resolve.test.ts src/api/subshells/__tests__/unseen-push-clear.test.ts src/services/__tests__/notify.service.test.ts src/ws/__tests__/subshell-ws.test.ts`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/server/api/src/services/subshells.service.ts apps/server/api/src/ws/attach-resolve.ts apps/server/api/src/api/subshells/__tests__/unseen-push-clear.test.ts apps/server/api/src/ws/__tests__/attach-resolve.test.ts
git commit -m "feat(server): opening a pane over the owner's cookie answers its unseen push"
```

---

### Task 5: Docs, changesets, full verification

**Files:**
- Modify: `apps/server/api/AGENTS.md`, `apps/node/agent/AGENTS.md` (the `report` verb descriptions)
- Create: `.changeset/hook-gated-notifications.md`

**Interfaces:** none (documentation + release notes + the verification gate).

- [ ] **Step 1: Update the two AGENTS.md `report` descriptions**

In BOTH `apps/server/api/AGENTS.md` (the `report attention …` CLI table row) and `apps/node/agent/AGENTS.md` (the `report` verb section), add this sentence to the paragraph that describes the `attention` reporting:

```
A `turn_complete` report reads the hook's stdin payload and stays silent when it names running background work or scheduled crons — a session parked on a subagent does not claim to be done (spec 2026-09-23).
```

Find the exact anchor with `grep -n "report attention" apps/server/api/AGENTS.md apps/node/agent/AGENTS.md` and append after the sentence that explains the attention kinds.

- [ ] **Step 2: Write the changeset**

Create `.changeset/hook-gated-notifications.md`:

```md
---
"@internal/server": minor
"@internal/node": patch
"@subshell-ai/plugin-claude-code": patch
---

Notifications get quieter. A Stop hook no longer rings "Done, waiting for you" while the session is parked on background work; approval pushes fire only for the notification types that genuinely need a human; and a pane pushes at most once until its owner opens it, escalation excepted.
```

(`mcp-core` is an ignored workspace; it ships inside the two binaries, so the `@internal/server` + `@internal/node` entries carry its change — never write a changeset for `@internal/mcp-core`.)

- [ ] **Step 3: Full verification**

```bash
bunx turbo build
bun run verify-types
bun run lint:check
bun run test
```

Expected: all green. If `lint:check` rewrites nothing and `verify-types` passes, the work is done; fix anything that surfaces (a missed type touchpoint would be in the three files of Tasks 3-4).

- [ ] **Step 4: Commit**

```bash
git add apps/server/api/AGENTS.md apps/node/agent/AGENTS.md .changeset/hook-gated-notifications.md
git commit -m "docs: hook-gated notifications changeset and reporter notes"
```

---

## Out of scope (do not build)

- Any MCP tool, any injected skill or prompt (rejected in the spec).
- `crashed_final` after unseen `exited` special-casing beyond the ladder (the ladder covers it: 4 > 3).
- Per-device unseen state, client-side suppression changes (`sw-handlers.js` untouched), push copy changes.
- The 20 s idle watcher's behavior for hook-less harnesses (only its pushes flow through the new unseen gate, unchanged in code).

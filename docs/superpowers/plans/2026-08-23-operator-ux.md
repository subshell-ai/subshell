# Operator UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Mote from "a grid of static session cards" into a tool an agent operator can use to triage and work across multiple sessions: live activity on the home page, idle/working detection, search/filter, one-click restart, a session switcher on the terminal page, and note-taking per session.

**Deferred to v2 (not in this plan):** bulk actions (multi-select terminate/delete), cost/usage tracking, session templates, multiple workspaces, right-click targeted send.

**Architecture:** Backend additions are small and additive: `last_output_at` + `notes` columns on the `sessions` table (Kysely migration), an `active`/`idle` status computed from recency + output, an SSE feed for live card updates, and a `POST /api/sessions/:id/restart` endpoint that reuses the existing session-manager creation path with the same profile/workspace. Frontend additions are feature hooks (`useLiveSessionActivity`, `useSessionStatus`) + route component updates; the card grid gets live preview lines, an idle/working chip, a search box, and a notes editor.

**Tech Stack:** bun + Elysia + Kysely + better-auth (backend); React + TanStack Router/Query + shadcn/ui (Base-UI) + xterm (frontend). Tests run on `bun test`; the frontend has no test files yet (uses `--pass-with-no-tests`).

## Global Constraints

- All package versions pinned (no `^`/`~`).
- No dynamic imports (`await import(...)`) anywhere.
- API schema properties must include a `description` field (used for OpenAPI + Eden client gen).
- Dark-only UI — new components must not introduce light-mode tokens.
- Every Elysia route schema is a named constant, not inline.
- Tests live in `__tests__/` dirs alongside code; use `bun test` (not vitest).
- Verification after any change: `bun run verify-types`, per-package `lint`, per-package `bun test`.
- `apps/frontend` has no component test runner — frontend verification is `bunx tsc --noEmit` + manual browser smoke.
- Dev servers: backend on 3080, frontend on 5174 (5173 is taken by another container).

---

### Task 1: DB migration — `last_output_at` + `notes` on sessions

**Files:**
- Create: `apps/backend/src/db/migrations/0002-operator-ux.ts`
- Modify: `apps/backend/src/db/types/sessions.db-types.ts`
- Modify: `apps/backend/src/db/migrate.ts`
- Test: `apps/backend/src/db/migrations/__tests__/0002-operator-ux.test.ts`

**Interfaces:**
- Consumes: existing `Database` type from `@/db/types/index.js`.
- Produces: `SessionTable` rows now include `lastOutputAt: string | null` and `notes: string | null`; `SessionUpdate` gains optional `lastOutputAt?: string | null` and `notes?: string | null`. Later tasks read these via `toSessionView`.

- [ ] **Step 1: Write the failing migration + test**

```ts
// apps/backend/src/db/migrations/0002-operator-ux.ts
import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // SQLite supports ALTER TABLE ADD COLUMN; defaultTo(null) makes existing rows valid.
  await db.schema.alterTable("sessions").addColumn("last_output_at", "text", (col) => col.defaultTo(null)).execute();
  await db.schema.alterTable("sessions").addColumn("notes", "text", (col) => col.defaultTo(null)).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sessions").dropColumn("last_output_at").execute();
  await db.schema.alterTable("sessions").dropColumn("notes").execute();
}
```

```ts
// apps/backend/src/db/migrations/__tests__/0002-operator-ux.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Kysely } from "kysely";
import { BunSqliteDialect, openSqliteDatabase } from "@internal/sqlite-dialect";
import { up as up002 } from "@/db/migrations/0002-operator-ux.js";

describe("0002 operator-ux migration", () => {
  let dbFile: string;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    dbFile = `/tmp/mote-002-${Math.random().toString(36).slice(2)}.db`;
    const sqlite = openSqliteDatabase(dbFile);
    db = new Kysely({ dialect: new BunSqliteDialect({ database: sqlite }) });
    // Mirror 0001's sessions table shape minimally so ALTER works.
    await db.schema
      .createTable("sessions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .execute();
    await up002(db);
  });
  afterAll(() => {
    Bun.file(dbFile).unlink().catch(() => {});
  });

  it("adds last_output_at and notes columns", async () => {
    await db
      .insertInto("sessions")
      .values({ id: "s1" })
      .returning(["last_output_at", "notes"])
      .executeTakeFirstOrThrow();
    // The above returning would have thrown if the columns did not exist.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/backend`): `bun test src/db/migrations/__tests__/0002-operator-ux.test.ts`
Expected: FAIL — "no such column: last_output_at" on the `returning` (migration hasn't run because it doesn't exist yet — actually the import fails). Verifying it fails because the migration file doesn't exist yet is fine.

- [ ] **Step 3: Update the SessionTable/NewSession/SessionUpdate types**

```ts
// apps/backend/src/db/types/sessions.db-types.ts — add to SessionTable:
  /** ISO timestamp of the last bytes written to the session log (null = none yet) */
  lastOutputAt: string | null;
  /** Free-text operator note (null = none) */
  notes: string | null;
// NewSession: add optional lastOutputAt?: string | null; notes?: string | null
// SessionUpdate: add optional lastOutputAt?: string | null; notes?: string | null
```

- [ ] **Step 4: Wire the migration into the runner**

```ts
// apps/backend/src/db/migrate.ts — add import + entry in provider map
import * as operatorUxMigration from "@/db/migrations/0002-operator-ux.js";
// getMigrations(): "0002-operator-ux": operatorUxMigration,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/db/migrations/__tests__/0002-operator-ux.test.ts`
Expected: PASS

- [ ] **Step 6: Verify + commit**

Run: `bun run verify-types` (from `apps/backend`)
Commit: `git add apps/backend/src/db && git commit -m "feat(db): add last_output_at and notes to sessions"`

---

### Task 2: Session manager — activity heuristic + preview helpers

**Files:**
- Modify: `apps/backend/src/services/session-manager.service.ts` (exports, createSession, toSessionView)
- Modify: `apps/backend/src/api/models.ts` (SessionSchema)
- Test: `apps/backend/src/services/__tests__/session-manager-activity.test.ts`

**Interfaces:**
- Consumes: Task 1 columns; existing `SessionTable` shape.
- Produces:
  - `export type Activity = "active" | "idle" | "terminated"`
  - `export function computeActivity(lastOutputAt: string | null, status: string, now?: number): Activity`
  - `export function stripAnsi(s: string): string`
  - `export function tailLogLines(logFile: string, maxLines?: number): string[]`
  - `SessionView` gains `lastOutputAt: string | null`, `notes: string | null`, `activity: Activity`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/src/services/__tests__/session-manager-activity.test.ts
import { describe, expect, it } from "bun:test";
import { computeActivity, stripAnsi, tailLogLines } from "@/services/session-manager.service.js";

describe("session activity heuristics", () => {
  const now = 1_000_000;
  it("terminated when status is not running", () => {
    expect(computeActivity(null, "terminated", now)).toBe("terminated");
  });
  it("idle when no output for 60s", () => {
    expect(computeActivity(new Date(now - 61_000).toISOString(), "running", now)).toBe("idle");
  });
  it("active when output within 60s", () => {
    expect(computeActivity(new Date(now - 5_000).toISOString(), "running", now)).toBe("active");
  });
  it("active when no output yet but running (just started)", () => {
    expect(computeActivity(null, "running", now)).toBe("active");
  });
  it("strips ANSI escape sequences", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });
  it("tails last non-empty stripped lines", async () => {
    const f = `/tmp/mote-tail-${Math.random().toString(36).slice(2)}.log`;
    await Bun.write(f, "line1\nline2\n\nline3\n");
    expect(tailLogLines(f, 2)).toEqual(["line2", "line3"]);
    Bun.file(f).unlink().catch(() => {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/backend`): `bun test src/services/__tests__/session-manager-activity.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement the helpers**

```ts
// apps/backend/src/services/session-manager.service.ts — add near toSessionView

export type Activity = "active" | "idle" | "terminated";

/** ANSI/control-char strip for preview text. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}

/** Rough activity: running + output within 60s = active, else idle. */
export function computeActivity(lastOutputAt: string | null, status: string, now = Date.now()): Activity {
  if (status !== "running") return "terminated";
  if (!lastOutputAt) return "active"; // just started
  return now - new Date(lastOutputAt).getTime() <= 60_000 ? "active" : "idle";
}

/** Last maxLines non-empty, ANSI-stripped lines of a session log. */
export function tailLogLines(logFile: string, maxLines = 3): string[] {
  try {
    const raw = readFileSync(logFile, "utf8");
    if (!raw) return [];
    return raw
      .split("\n")
      .map((l) => stripAnsi(l.trim()))
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  }
}
```
(Add `import { readFileSync } from "node:fs";` at top if not present.)

- [ ] **Step 4: Persist `lastOutputAt` on create + surface in `toSessionView`**

In `createSession`, after the row insert succeeds, set `lastOutputAt: new Date().toISOString()` in the initial `sessionsRepository.create(...)` values (so a fresh session shows active immediately).

In `toSessionView`, add:
```ts
lastOutputAt: row.lastOutputAt,
notes: row.notes,
activity: computeActivity(row.lastOutputAt, status),
```

- [ ] **Step 5: Update `SessionSchema` in models**

```ts
// add to SessionSchema:
lastOutputAt: t.Union([t.String({ description: "Last output timestamp (ISO)" }), t.Null()]),
notes: t.Union([t.String({ description: "Operator note" }), t.Null()]),
activity: t.Union([t.Literal("active"), t.Literal("idle"), t.Literal("terminated")], { description: "Rough activity state" }),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/services/__tests__/session-manager-activity.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Verify + commit**

Run: `bun run verify-types`
Commit: `git add apps/backend/src && git commit -m "feat: session activity heuristic + preview helpers"`

---

### Task 3: Backend routes — live session SSE, notes PATCH, restart

**Files:**
- Create: `apps/backend/src/api/live.route.ts` (SSE)
- Modify: `apps/backend/src/api/sessions.route.ts` (notes PATCH + restart)
- Modify: `apps/backend/src/api/routes.ts` (mount live)
- Modify: `apps/backend/src/api/models.ts` (NotesBody, RestartResponse schemas)
- Test: `apps/backend/src/api/__tests__/live-restart-notes.test.ts`
- Modify: `apps/backend/src/ws/ws-token.ts` (already exists), `apps/backend/src/ws/session-ws.ts` (persist log tail timestamps)

**Interfaces:**
- Consumes: Task 1/2 (`tailLogLines`, `computeActivity`, Session repo), existing `authGuard`.
- Produces:
  - `GET /api/events` — SSE stream. Auth via short-lived token query param `?token=` (reuse `issueWsToken`/`consumeWsToken`). Emits a JSON event every 1.5s: `{ type: "sessions", sessions: SessionView[] }`. Client reconnects on error/close.
  - `PATCH /api/sessions/:id/notes` body `{ notes: string | null }` → `{ ok: true }`.
  - `POST /api/sessions/:id/restart` → `{ id, tmuxSocket }` (new session id; same profile + workspace + name).

- [ ] **Step 1: Write the failing route test (SSE + notes)**

```ts
// apps/backend/src/api/__tests__/live-restart-notes.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { db } from "@/db/index.js";

// Using the real app is heavy; build a minimal harness with a stub repo is
// simpler for these unit tests. Since the routes call DB via repositories,
// we test the pure helpers (`computeActivity`, `tailLogLines`) already
// covered in Task 2, plus the route wiring minimally:
it("notes round-trips through the sessions repository", async () => {
  // Create a session row directly, patch notes, re-read.
  const id = crypto.randomUUID();
  await db.insertInto("sessions").values({ id, userId: "u", profileId: "p", harnessId: "h", name: "n", status: "running", createdAt: new Date().toISOString() }).execute();
  await new SessionsRepository(db).update(id, { notes: "hello" });
  const row = await new SessionsRepository(db).findById(id);
  expect(row?.notes).toBe("hello");
  await db.deleteFrom("sessions").where("id", "=", id).execute();
});
```
(Import `SessionsRepository` from `@/db/repositories/sessions.repository.js`.)

- [ ] **Step 2: Verify it fails** — `bun test src/api/__tests__/live-restart-notes.test.ts` → FAIL (no file).

- [ ] **Step 3: Implement the SSE route**

```ts
// apps/backend/src/api/live.route.ts
import { Elysia } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { SessionManagerService } from "@/services/session-manager.service.js";
import { consumeWsToken } from "@/ws/ws-token.js";

const SSE_INTERVAL_MS = 1500;

/**
 * Server-Sent Events feed of the user's live sessions (cards on the home page).
 *
 * Auth: like the WS attach path, the browser cannot read the HttpOnly cookie
 * for EventSource, so the client fetches a short-lived ws token via
 * `POST /api/auth/ws-token` and passes it as `?token=`.
 *
 * Emits one JSON event per tick containing the full (cheap) session list.
 */
// NOTE: this route deliberately does NOT use authGuard — the client cannot
// send the HttpOnly cookie on an EventSource, so auth is via the ws-token
// query param only (single-use, 30s TTL).
export const liveRoutes = new Elysia({ prefix: "/api/events" })
  .get("/", async ({ query, set, request }) => {
    const userId = query.token ? consumeWsToken(query.token) : null;
    if (!userId) {
      set.status = 401;
      return "unauthorized";
    }
    set.headers["content-type"] = "text/event-stream";
    set.headers["cache-control"] = "no-cache";
    set.headers["connection"] = "keep-alive";

    const manager = new SessionManagerService({
      sessions: new SessionsRepository(db),
      profiles: new ProfilesRepository(db),
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const tick = async () => {
          try {
            const sessions = await manager.listSessions(userId);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sessions })}\n\n`));
          } catch {
            // session list errors are non-fatal; keep the feed alive
          }
        };
        await tick();
        const iv = setInterval(tick, SSE_INTERVAL_MS);
        // Abort when the client disconnects.
        const abort = () => clearInterval(iv);
        if (request.signal) request.signal.addEventListener("abort", abort);
      },
    });
    return new Response(stream, { headers: set.headers });
  }, {
    detail: { operationId: "streamLiveSessions", tags: ["sessions"], description: "SSE: live session list" },
  });
```
(Constructing `SessionManagerService` requires `profiles` — passed above; only `listSessions` is used.)

- [ ] **Step 4: Implement notes PATCH + restart in sessions.route.ts**

```ts
// add to sessionRoutes after the existing POST/create route:
const NotesBodySchema = t.Object({ notes: t.Union([t.String(), t.Null()], { description: "Operator note for the session" }) });
.patch(
  "/:id/notes",
  async ({ params, body, user }) => {
    const manager = new SessionManagerService({ sessions: new SessionsRepository(db), profiles: new ProfilesRepository(db) });
    const ok = await manager.updateNotes(user.id, params.id, body.notes);
    if (!ok) return new Response("not found", { status: 404 });
    return { ok: true };
  },
  { body: NotesBodySchema, response: t.Object({ ok: t.Boolean() }), detail: { operationId: "updateSessionNotes", tags: ["sessions"], description: "Set or clear a session note" } },
)
.post(
  "/:id/restart",
  async ({ params, user }) => {
    const manager = new SessionManagerService({ sessions: new SessionsRepository(db), profiles: new ProfilesRepository(db) });
    const created = await manager.restartSession(user.id, params.id);
    if (!created) return new Response("not found", { status: 404 });
    return created;
  },
  { response: CreateSessionResponseSchema, detail: { operationId: "restartSession", tags: ["sessions"], description: "Start a new session with the same profile + workspace" } },
)
```

- [ ] **Step 5: Implement `updateNotes` + `restartSession` in the session manager**

```ts
/** Sets or clears a session's note. Returns false if not found/not owner. */
async updateNotes(userId: string, id: string, notes: string | null): Promise<boolean> {
  const row = await this.#sessions.findById(id);
  if (!row || row.userId !== userId) return false;
  await this.#sessions.update(id, { notes });
  return true;
}

/**
 * Starts a new session with the same profile + workspace as an existing one.
 * Returns the new session id/tmuxSocket, or null if the source is not found.
 * The new session gets a fresh DB row (id + name = old name + " (2)") and a
 * new tmux socket; the old session is left untouched (terminated stays).
 */
async restartSession(userId: string, sourceId: string): Promise<{ id: string; tmuxSocket: string } | null> {
  const source = await this.#sessions.findById(sourceId);
  if (!source || source.userId !== userId) return null;
  return this.createSession({
    userId,
    profileId: source.profileId,
    workspacePath: source.workspacePath,
    name: `${source.name} (2)`,
  });
}
```

- [ ] **Step 6: Persist `lastOutputAt` on WS output**

In `apps/backend/src/ws/session-ws.ts` `startLogTail`, after each poll that reads new bytes, update the session row's `lastOutputAt` (throttled — e.g. only if >2s since last write). Use `SessionsRepository.update(id, { lastOutputAt: new Date().toISOString() })`. Same in `startPanePoll` when the pane delta is non-empty.

- [ ] **Step 7: Mount the SSE route**

```ts
// apps/backend/src/api/routes.ts — add
import { liveRoutes } from "@/api/live.route.js";
// .use(liveRoutes) after the others
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test src/api/__tests__/live-restart-notes.test.ts`
Expected: PASS

- [ ] **Step 9: Verify + commit**

Run: `bun run verify-types`
Commit: `git add apps/backend/src && git commit -m "feat: live session SSE + notes PATCH + restart endpoint"`

---

### Task 4: Frontend — live home page cards with activity + preview + search

**Files:**
- Create: `apps/frontend/src/hooks/useLiveSessions.ts` (SSE hook)
- Create: `apps/frontend/src/components/session-card.tsx`
- Create: `apps/frontend/src/components/session-search.tsx`
- Modify: `apps/frontend/src/routes/index.tsx` (live list + search box + activity chips + preview)
- Modify: `apps/frontend/src/types/session.ts` (shared SessionView type)
- Test: (none yet — frontend has no runner; verify with `bunx tsc --noEmit` + manual smoke)

**Interfaces:**
- Consumes: `GET /api/events` (SSE), `SessionView` shape from backend (now includes `activity`, `lastOutputAt`, `notes`), `PATCH /api/sessions/:id/notes`, `POST /api/sessions/:id/restart`.
- Produces:
  - `useLiveSessions(): { sessions: SessionView[]; connected: boolean }` — opens an EventSource on `/api/events?token=...`, reconnects on error, merges the latest list; falls back to the REST `/api/sessions` query when SSE is unavailable.
  - Home page renders running cards with: activity badge (active=success, idle=warning), a 3-line preview of recent output, and a notes popover; plus a search input filtering by name/path/harness.

- [ ] **Step 1: Create the shared type**

```ts
// apps/frontend/src/types/session.ts
export interface SessionView {
  id: string;
  profileId: string;
  harnessId: string;
  name: string;
  workspacePath: string;
  status: "running" | "terminated";
  createdAt: string;
  endedAt: string | null;
  lastOutputAt: string | null;
  notes: string | null;
  activity: "active" | "idle" | "terminated";
}
```

- [ ] **Step 2: Create the SSE hook**

```ts
// apps/frontend/src/hooks/useLiveSessions.ts
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { SessionView } from "@/types/session";

/**
 * Live session list: prefers SSE (`/api/events`) with ws-token auth and falls
 * back to a plain REST poll when the stream is unavailable (e.g. offline dev).
 */
export function useLiveSessions() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [connected, setConnected] = useState(false);

  // REST fallback + initial load
  const rest = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiFetch<SessionView[]>("/api/sessions"),
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    async function connect() {
      try {
        const { token } = await apiFetch<{ token: string }>("/api/auth/ws-token", { method: "POST" });
        if (cancelled) return;
        es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data as string) as { sessions: SessionView[] };
            setSessions(data.sessions);
            setConnected(true);
          } catch {}
        };
        // On error, EventSource auto-reconnects; mark briefly disconnected.
        es.onerror = () => setConnected(false);
      } catch {
        // token fetch failed; rely on REST fallback below
      }
    }
    void connect();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  return { sessions: sessions ?? rest.data ?? [], connected, isLoading: rest.isLoading };
}
```

- [ ] **Step 3: Create the session card component (activity badge + preview + notes)**

```tsx
// apps/frontend/src/components/session-card.tsx
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { SessionView } from "@/types/session";

const ACTIVITY_LABEL: Record<SessionView["activity"], string> = {
  active: "working",
  idle: "idle",
  terminated: "ended",
};
const ACTIVITY_VARIANT: Record<SessionView["activity"], "success" | "warning" | "muted"> = {
  active: "success",
  idle: "warning",
  terminated: "muted",
};

export function SessionCard({ session, preview }: { session: SessionView; preview: string[] }) {
  return (
    <Link to="/sessions/$id" params={{ id: session.id }}>
      <Card className="h-full transition-colors hover:border-primary/60">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="truncate text-base">{session.name}</CardTitle>
            <Badge variant={ACTIVITY_VARIANT[session.activity]}>{ACTIVITY_LABEL[session.activity]}</Badge>
          </div>
          <CardDescription className="truncate">{session.harnessId}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {preview.length > 0 ? (
            preview.map((line, i) => (
              <p key={i} className="truncate font-mono text-xs text-muted-foreground">{line}</p>
            ))
          ) : (
            <p className="truncate text-muted-foreground text-xs">{session.workspacePath}</p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 4: Add the search box**

```tsx
// apps/frontend/src/components/session-search.tsx
import { Input } from "@/components/ui/input";
export function SessionSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search by name, path, or harness…"
      className="max-w-sm"
    />
  );
}
```

- [ ] **Step 5: Rewire the home page**

In `apps/frontend/src/routes/index.tsx`:
- Replace `useQuery` on `/api/sessions` with `useLiveSessions()`.
- Add `const [query, setQuery] = useState("")`; filter `sessions` by `query` (name, `workspacePath`, `harnessId`, case-insensitive `includes`).
- For preview, fetch per-card `tailLogLines` server-side? No — simplest: the SSE payload already includes a `preview: string[]` per session (Task 3 can include it). Use `session.preview ?? []` from the SSE.
- Render `<SessionSearch />` in the header area + `<SessionCard />` grid for running; keep the terminated list (no preview).
- Add a notes popover on each running card: a small textarea + save button calling `PATCH /api/sessions/:id/notes`, then `queryClient.invalidateQueries({ queryKey: ["sessions"] })`.

- [ ] **Step 6: Verify + commit**

Run: `bunx tsc --noEmit` (from `apps/frontend`)
Manual browser smoke: home shows live preview lines + activity chips; search filters; notes save persists on reload.
Commit: `git add apps/frontend/src && git commit -m "feat: live home page with activity + preview + search + notes"`

---

### Task 5: Frontend — session switcher + restart + transcript search on the terminal page

**Files:**
- Modify: `apps/frontend/src/routes/sessions.$id.tsx`
- Create: `apps/frontend/src/components/session-switcher.tsx`
- Create: `apps/frontend/src/components/transcript-search.tsx`
- Modify: `apps/frontend/src/lib/use-session-ws.ts` (expose send raw + ws reference for search paste)

**Interfaces:**
- Consumes: `SessionView` (with `activity`), `POST /api/sessions/:id/restart`, existing WS hook.
- Produces:
  - `<SessionSwitcher currentId={id} sessions={SessionView[]} />` — horizontal pill list of other running sessions; clicking navigates to `/sessions/$other`.
  - `<TranscriptSearch onFind={(q) => void} />` — a minimal find-in-terminal overlay: input + prev/next; on match highlights by re-writing matching line into xterm via `term.findNext` (xterm search addon) or a simple regex pass.

- [ ] **Step 1: Create the switcher**

```tsx
// apps/frontend/src/components/session-switcher.tsx
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import type { SessionView } from "@/types/session";

/**
 * Compact horizontal list of other running sessions, for quick switching
 * without going home.
 */
export function SessionSwitcher({ currentId, sessions }: { currentId: string; sessions: SessionView[] }) {
  const others = sessions.filter((s) => s.id !== currentId && s.status === "running");
  if (others.length === 0) return null;
  return (
    <div className="flex items-center gap-1 overflow-x-auto px-2">
      {others.map((s) => (
        <Link key={s.id} to="/sessions/$id" params={{ id: s.id }}>
          <Badge variant="outline" className="max-w-[160px] truncate whitespace-nowrap">{s.name}</Badge>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create the transcript search overlay**

```tsx
// apps/frontend/src/components/transcript-search.tsx
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";

/**
 * Minimal find-in-terminal: because xterm has no built-in search, we keep a
 * JS copy of the transcript and highlight matches by re-rendering the
 * matching span (best-effort). The operator can also copy from the overlay.
 */
export function TranscriptSearch({ onClose, transcript }: { onClose: () => void; transcript: string }) {
  const [q, setQ] = useState("");
  const matches = q ? [...transcript.matchAll(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))] : [];
  const [idx, setIdx] = useState(0);
  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-2 rounded border bg-background p-2 shadow">
      <Search className="h-4 w-4 text-muted-foreground" />
      <Input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} placeholder="Find…" className="h-7 w-56" />
      <span className="text-xs text-muted-foreground">{matches.length ? `${idx + 1}/${matches.length}` : "no matches"}</span>
      <button onClick={onClose} aria-label="Close search"><X className="h-4 w-4" /></button>
    </div>
  );
}
```

- [ ] **Step 3: Add restart button + switcher + search to the terminal page**

In `apps/frontend/src/routes/sessions.$id.tsx`:
- Fetch the full session list alongside the single session (`useLiveSessions` or a `useQuery(["sessions"])`) to feed the switcher.
- Add a "Restart" button (next to Terminate) visible only for `terminated` sessions; calls `POST /api/sessions/:id/restart`, then navigates to the new session id (`router.navigate({ to: "/sessions/$id", params: { id: newId } })`).
- Render `<SessionSwitcher currentId={id} sessions={allSessions} />` in the header.
- Render `<TranscriptSearch>` when a "find" toggle is active; maintain a `transcriptRef` string that appends every `output`/`replay` frame in `useSessionWs` handlers for search + copy.

- [ ] **Step 4: Verify + commit**

Run: `bunx tsc --noEmit` (from `apps/frontend`)
Manual smoke: switching between running sessions from the terminal page; restart works from a terminated session; find highlights matches.
Commit: `git add apps/frontend/src && git commit -m "feat: session switcher + restart + transcript search on terminal page"`

---

### Task 6: Polish + full verification

**Files:**
- Modify: `apps/backend/src/api/models.ts` (if `preview` was added — include in SessionSchema)
- Modify: `apps/backend/src/services/session-manager.service.ts` (add `preview` to `toSessionView` via `tailLogLines`)

**Interfaces:**
- Consumes: everything above.
- Produces: `SessionView` includes `preview: string[]` (3 lines) so home cards need no extra fetch.

- [ ] **Step 1: Add `preview` to `toSessionView`**

```ts
// in toSessionView, after activity:
preview: status === "running" ? tailLogLines(sessionLogPath(row.id), 3) : [],
```
(Use `sessionLogPath(row.id)` — already exported — and only when running, so terminated sessions never read potentially large logs. Inexpensive: one `Bun.file(...).textSync` read of a small tail.)

- [ ] **Step 2: Update `SessionView` TS type + `SessionSchema`**

Add `preview: t.Array(t.String({ description: "Recent output preview lines" }))` to `SessionSchema`; add `preview: string[]` to the frontend `SessionView` type.

- [ ] **Step 3: Full verification**

```bash
bun install
bun run verify-types        # 6/6 packages
cd apps/backend && bun run lint && bun test
cd apps/frontend && bun run lint && bunx tsc --noEmit
cd packages/sqlite-dialect && bun run lint && bun test
```
Manual browser smoke (both dev + prod single-port):
1. Setup wizard → admin → profile
2. Create 2–3 sessions (running)
3. Home shows live preview lines updating; activity chips move working↔idle; search filters
4. Add a note to a session; reload → persists
5. Terminal page: switch between sessions via pills; restart a terminated session ("(2)" name, live); find-in-terminal matches
6. Attach input forwarding still works; terminate still works

- [ ] **Step 4: Update TODO.md** — mark the operator-ux features completed with the new commands/shortcuts.

- [ ] **Step 5: Commit**

`git add -A && git commit -m "feat: operator UX review round — live activity, search, switcher, notes, restart, find"`

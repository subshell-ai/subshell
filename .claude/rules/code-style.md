# Code Style

## No Dynamic Imports

Do not use `await import(...)` (dynamic imports) anywhere in the codebase. Always use static
top-level `import` statements instead.

**Do this:**
```typescript
import { runMigrations } from "@/db/migrate.js";
import { getAuth } from "@/auth.js";
```

**Not this:**
```typescript
const { runMigrations } = await import("@/db/migrate.js");
const { getAuth } = await import("@/auth.js");
```

Dynamic imports break `bun build --compile` because the bundler cannot statically analyse
them, so the referenced modules (and their `node_modules` dependencies) are excluded from the
compiled binary and fail at runtime with "Cannot find package" errors.

**One exception, by name.** `packages/pane-runtime/src/plugin-runtime.ts` uses
`await import()` to load an installed plugin. There the bundler's blindness is
the POINT: the target is a plugin the user installed after the binary was
built, and it must not be bundled into it. Measured on bun 1.4.2, a compiled
binary can import an absolute path at runtime, and the loaded module cannot
resolve a bare specifier of ours, which is why plugins receive a host object
instead of importing one. No other file may use it, and a second exception is
a design question rather than a precedent.

## File Size and Organization

Break up large files into smaller, focused modules. When a file grows beyond ~300-400 lines or contains multiple distinct concerns, split it into separate files.

When the split files share a common theme, create a directory to group them:

```
# Before: one flat route module carrying every channel endpoint
src/api/channels.route.ts

# After: a directory, one file per endpoint
src/api/channels/
├── index.ts                       # aggregates the routes for routes.ts
├── create-channel.route.ts
├── join-channel.route.ts
├── list-channels.route.ts
├── list-channel-members.route.ts
├── post-to-channel.route.ts
├── read-channel-posts.route.ts
├── get-channel-cursor.route.ts
└── __tests__/
```

`src/api/subshells/`, `src/api/workspaces/` and `src/api/nodes/` follow the same
shape. A resource stays a single flat `*.route.ts` until it earns the directory.

Guidelines:
- Each file should have a single responsibility
- Keep related tests alongside the code in `__tests__/` directories
- Use an `index.ts` only when you need to aggregate exports for external use
- Do not re-export items that are already accessible from their original location; import directly from the source instead

## React Component Organization

Route files and large components should be thin orchestrators. When a route component grows beyond ~200 lines, extract concerns into separate modules:

- **Data-fetching logic** → custom hooks in `src/hooks/` (e.g. `use-admin-status.ts`,
  `use-nodes.ts`, `use-subshell-data.ts`)
- **Reusable UI blocks** → components in `src/components/`, grouped in a directory
  when a route owns several (e.g. `components/admin-status/`, `components/nodes/`,
  `components/sidebar/`)
- **Shared types and constants** → `src/lib/` (e.g. `subshell-indicator.ts`,
  `workspace-layout.ts`, `device-name.ts`)

`routes/settings_.status.tsx` is the worked example: the route holds its admin gate
and composition, `hooks/use-admin-status.ts` holds the query, and the cards live in
`components/admin-status/`.

Route files should only contain:
- The route definition (`createFileRoute` + `validateSearch`)
- URL state parsing and the `updateSearch` helper
- Event handlers that are tightly coupled to route-level state
- The top-level JSX composition

## Deduplication and Reuse

Avoid duplicating code. When the same logic, type, or utility exists in multiple places, consolidate it into a shared location and import from there.

- Extract shared types to common type files
- Create utility functions for repeated patterns
- Use a single source of truth for constants and configurations
- When adding new code, first check if similar functionality already exists

## Type Discriminants and Enums

Use TypeScript union types or enums for values with a fixed set of options instead of plain strings. Define these in shared type files for reuse.

**Do this:**
```typescript
// src/db/types/subshell-status.ts — one definition, plus the runtime list
/** Lifecycle status of an agent subshell. */
export type SubshellStatus = "running" | "terminated";

export const SUBSHELL_STATUSES: readonly SubshellStatus[] = ["running", "terminated"];

// Use in interfaces
interface SubshellTable {
  status: SubshellStatus;  // Type-safe, autocomplete-friendly
}
```

Export the runtime array beside the type whenever something has to iterate or
validate the values — one edit site instead of two that drift.

**Not this:**
```typescript
interface SubshellTable {
  status: string;  // Any string accepted, no validation
}
```

For Elysia route schemas, create corresponding schema definitions using Elysia's `t` module:
```typescript
// Shape to follow — in src/schema/, or beside the route that owns it
export const SubshellStatusSchema = t.Union([t.Literal("running"), t.Literal("terminated")], {
  description: "Lifecycle status of the subshell",
});
```

For MCP tool schemas, use Zod:
```typescript
// Shape to follow — in packages/mcp-core/src/
export const SubshellStatusSchema = z.enum(["running", "terminated"]);
```

## Schema Definitions

Define all schemas (input, output, internal) as named constants rather than inline definitions. This improves readability, enables reuse, and makes the code structure consistent.

**Do this:**
```typescript
/** Schema for tool input */
const ToolInputSchema = z.object({
  query: z.string().describe("Search query"),
  limit: z.number().default(10).describe("Max results"),
});

/** Schema for tool output */
const ToolOutputSchema = z.object({
  results: z.array(ResultSchema),
});

server.registerTool("my_tool", {
  inputSchema: ToolInputSchema,
  outputSchema: ToolOutputSchema,
}, handler);
```

**Not this:**
```typescript
server.registerTool("my_tool", {
  inputSchema: z.object({  // Inline schema - hard to read and reuse
    query: z.string().describe("Search query"),
    limit: z.number().default(10).describe("Max results"),
  }),
  outputSchema: ToolOutputSchema,
}, handler);
```

## Elysia Schema Descriptions

All Elysia `t` schema properties in API routes must include a `description` field. These descriptions are used to generate OpenAPI documentation and appear in the auto-generated client SDK.

Use `import { t } from "elysia"` for all schema definitions.

```typescript
// src/api/channels/read-channel-posts.route.ts
import { t } from "elysia";

const PostsQuerySchema = t.Object({
  since: t.Optional(t.Numeric({ description: "Return posts with seq > since; defaults to the stored cursor" })),
  wait: t.Optional(t.Numeric({ default: 0, description: "Long-poll budget in seconds (clamped to 600)" })),
  limit: t.Optional(t.Numeric({ default: 100, description: "Max posts to return (cap 500)" })),
  mark: t.Optional(t.Numeric({ default: 0, description: "1 = advance the stored cursor to what was returned" })),
});

const PostsViewSchema = t.Object({
  posts: t.Array(
    t.Object({
      id: t.String({ description: "Post id (uuid)" }),
      seq: t.Number({ description: "Per-channel sequence number" }),
      author: t.String({ description: "Author principal label (token-derived)" }),
      envelope: t.String({ description: "General JWE JSON" }),
      createdAt: t.String({ description: "ISO 8601 timestamp" }),
    }),
    { description: "Posts visible to the caller, seq ascending" },
  ),
  nextSince: t.Number({ description: "Cursor to pass as since on the next read" }),
});
```

This applies to:
- Query parameter schemas (`querystring`)
- Path parameter schemas (`params`)
- Request body schemas (`body`)
- Response schemas (`response`)
- Nested object properties within any schema

## Co-location of Related Definitions

Keep all definitions for a single concept in the same file. When a handler has
associated schemas, types, and metadata, define them in the handler file rather
than spreading them across a parallel "definitions" module — a central registry
that restates what the handler already declares is two things to keep in sync.

**Do this** — a route module owns its schemas, its handler, and its OpenAPI metadata:

```typescript
// src/api/channels/read-channel-posts.route.ts

const PostsQuerySchema = t.Object({ /* … */ });
const PostsViewSchema = t.Object({ /* … */ });

export const readChannelPostsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .get("/:name/posts", handler, {
    query: PostsQuerySchema,
    response: { 200: PostsViewSchema, 400: "ApiErrorResponse", 401: "ApiErrorResponse" },
    detail: { operationId: "readChannelPosts", tags: ["channels"] },
  });
```

Aggregate only for wiring, never to restate:

```typescript
// src/api/channels/index.ts — composition, not a second source of truth
export const channelRoutes = new Elysia({ prefix: "/api/channels" })
  .use(createChannelRoute)
  .use(listChannelsRoute)
  .use(joinChannelRoute)
  .use(postToChannelRoute)
  .use(readChannelPostsRoute);
```

**Not this** — a registry duplicating each handler's own metadata:

```typescript
// definitions.ts — centralized, far from the implementation
export const ROUTE_DEFINITIONS = [
  { name: "readChannelPosts", description: "…" },  // duplicates the route's `detail`
];
```

**Known divergence.** `packages/mcp-core/src/server.ts` registers its 13 tools with
zod schemas written *inline* in the `registerTool` call, against the "Schema
Definitions" rule above. The schemas are one-liners and the file reads fine, so it
has not been worth changing — but it is a divergence, not a second sanctioned
pattern. New tools should follow the named-constant rule; do not cite `server.ts`
as precedent for inline schemas elsewhere.

## JSDoc Comments

All public classes, methods, and functions should have JSDoc comments that describe:
- What the class/function does
- Parameters and their purpose
- Return values
- Example usage (for complex functions)

```typescript
/**
 * Creates a new subshell: validates the harness (+ its optional preset) and the
 * working directory, records the DB row, mints the subshell's MCP token, then
 * spawns the harness under tmux with a curated env (including the injected
 * SUBSHELL_* credentials). When `prompt` is given, it is typed into the pane
 * once the harness has settled.
 */
async createSubshell(input: CreateSubshellInput): Promise<SubshellView> {
  // ...
}
```

Describe what is NOT obvious from the signature. `createSubshell` returning a
subshell needs no `@returns`; the fact that it also mints a credential and types
into a pane does.

## Interface Property Documentation

All interface properties should have JSDoc comments explaining their purpose. This is especially important for:
- Database table schemas
- API request/response types
- Configuration interfaces
- Domain models

```typescript
// src/db/types/channel-posts.db-types.ts
/**
 * A post in a channel's append-only log. The envelope is a jose General JWE
 * JSON string — the server stores and forwards it without ever parsing its
 * ciphertext. Posts are immutable: no UPDATE/DELETE shapes exist by design.
 */
export interface ChannelPostTable {
  /** Unique post id (uuid) */
  id: string;
  /** Owning channel */
  channelId: string;
  /** Per-channel monotonic sequence number (the read cursor) */
  seq: number;
  /** Author principal label, derived from the caller's token — never self-declared */
  author: string;
  /** General JWE JSON (opaque to the server) */
  envelope: string;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
}
```

For simple, self-explanatory properties (like `id`, `name`, `createdAt`), a brief comment is sufficient. For complex or non-obvious properties, provide more context about the expected format, constraints, or usage.

## Singleton Pattern for Expensive Resources

For expensive resources that should only be created once (servers, database connections, etc.), use a module-level singleton pattern with a factory function:

```typescript
// src/auth.ts — the better-auth handle, built once, lazily
let instance: Auth | undefined;

/**
 * Returns the better-auth instance, constructing it on FIRST USE rather than at
 * import. Nothing needs auth during module evaluation, so the laziness is
 * invisible in behavior and visible only in the absence of import-time side
 * effects — which is what lets `subshell-server mcp` run without opening SQLite.
 */
export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
}

/**
 * Drops the memoized instance. Only for tests that need a fresh build.
 * @internal
 */
export function resetAuthForTests(): void {
  instance = undefined;
}
```

Key points:
- The accessor checks for an existing instance before creating
- Provide a reset function for test isolation (marked `@internal`)
- Tests should call reset in `beforeEach`/`afterEach` to ensure isolation
- **Construct lazily, never at import.** A module that opens a database or binds
  a port merely by being evaluated breaks the compiled binary's non-boot
  subcommands. Import purity is pinned by test — see `apps/server/api/AGENTS.md`.

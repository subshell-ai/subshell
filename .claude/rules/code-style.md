# Code Style

## No Dynamic Imports

Do not use `await import(...)` (dynamic imports) anywhere in the codebase. Always use static
top-level `import` statements instead.

**Do this:**
```typescript
import { setConfig, getConfig } from "@/config/index.js";
import { runMigrations } from "@/db/migrate.js";
```

**Not this:**
```typescript
const { setConfig } = await import("@/config/index.js");
const { runMigrations } = await import("@/db/migrate.js");
```

Dynamic imports break `bun build --compile` because the bundler cannot statically analyse
them, so the referenced modules (and their `node_modules` dependencies) are excluded from the
compiled binary and fail at runtime with "Cannot find package" errors.

## File Size and Organization

Break up large files into smaller, focused modules. When a file grows beyond ~300-400 lines or contains multiple distinct concerns, split it into separate files.

When the split files share a common theme, create a directory to group them:

```
# Before: One large file
src/services/mcp.service.ts  (700+ lines)

# After: Directory with focused modules
src/services/
├── mcp.service.ts              # Main service class (thin wrapper)
└── mcp/
    ├── server.ts               # Server factory
    ├── tools.ts                # Tool handlers
    ├── resources.ts            # Resource handlers
    ├── schemas.ts              # Validation schemas
    ├── types.ts                # TypeScript interfaces
    ├── definitions.ts          # Constants and definitions
    └── __tests__/
        └── server.test.ts
```

Guidelines:
- Each file should have a single responsibility
- Keep related tests alongside the code in `__tests__/` directories
- Use an `index.ts` only when you need to aggregate exports for external use
- Do not re-export items that are already accessible from their original location; import directly from the source instead

## React Component Organization

Route files and large components should be thin orchestrators. When a route component grows beyond ~200 lines, extract concerns into separate modules:

- **Data-fetching logic** → custom hooks in `src/hooks/` (e.g., `useLogsData.ts`)
- **Reusable UI blocks** → components in `src/components/` (e.g., `LogsToolbar.tsx`)
- **Shared types and constants** → `src/lib/` (e.g., `logs-search.ts`)

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
// Define shared types in api-lib/types/
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "live";

// Use in interfaces
interface LogInput {
  level?: LogLevel;  // Type-safe, autocomplete-friendly
}
```

**Not this:**
```typescript
interface LogInput {
  level?: string;  // Any string accepted, no validation
}
```

For Elysia route schemas, create corresponding schema definitions using Elysia's `t` module:
```typescript
// In src/api-lib/types/log.type.ts
export const LogLevelSchema = t.Union([
  t.Literal("fatal"),
  t.Literal("error"),
  // ...
]);
```

For MCP tool schemas, use Zod:
```typescript
// In src/mcp/schemas.ts
export const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
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
import { t } from "elysia";

const QueryParamsSchema = t.Object({
  limit: t.Optional(t.Number({
    default: 100,
    description: "Maximum number of logs to return"
  })),
  offset: t.Optional(t.Number({
    default: 0,
    description: "Number of logs to skip for pagination"
  })),
  timeframe: t.Optional(TimeframeSchema),
});

const ResponseSchema = t.Object({
  logs: t.Array(LogSchema, { description: "List of log entries" }),
  total: t.Number({ description: "Total count of matching logs" }),
});
```

This applies to:
- Query parameter schemas (`querystring`)
- Path parameter schemas (`params`)
- Request body schemas (`body`)
- Response schemas (`response`)
- Nested object properties within any schema

## Co-location of Related Definitions

Keep all definitions for a single concept in the same file. When a handler/tool has associated schemas, types, and metadata definitions, define them all in the handler file rather than spreading across multiple files.

**Do this:**
```typescript
// tools/query-logs.ts - everything for this tool in one place

/** Tool definition for external discovery */
export const QUERY_LOGS_DEFINITION: McpToolDefinition = {
  name: "query_logs",
  title: "Query Logs",
  description: "Query logs with filtering options.",
  parameters: [...],
};

/** Schema for input */
const QueryLogsInputSchema = z.object({...});

/** Schema for output */
const QueryLogsOutputSchema = z.object({...});

export function registerQueryLogsTool(server: McpServer): void {
  server.registerTool("query_logs", {
    title: QUERY_LOGS_DEFINITION.title,
    description: QUERY_LOGS_DEFINITION.description,
    inputSchema: QueryLogsInputSchema,
    outputSchema: QueryLogsOutputSchema,
  }, handler);
}
```

Aggregate exports in an index file when needed for external consumption:
```typescript
// tools/index.ts
export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  QUERY_LOGS_DEFINITION,
  GET_LOG_DEFINITION,
  // ...
];
```

**Not this:**
```typescript
// definitions.ts - centralized definitions far from implementation
export const MCP_TOOL_DEFINITIONS = [
  { name: "query_logs", ... },  // Duplicates info in handler file
  { name: "get_log", ... },
];

// tools/query-logs.ts
export function registerQueryLogsTool() {
  server.registerTool("query_logs", {
    title: "Query Logs",  // Duplicated from definitions.ts
    ...
  });
}
```

## JSDoc Comments

All public classes, methods, and functions should have JSDoc comments that describe:
- What the class/function does
- Parameters and their purpose
- Return values
- Example usage (for complex functions)

```typescript
/**
 * Ingests a single log entry into the database.
 * @param input - The log entry data to ingest
 * @returns The created log record with generated ID and timestamp
 */
async ingestLog(input: LogInput): Promise<LogDb> {
  // ...
}
```

## Interface Property Documentation

All interface properties should have JSDoc comments explaining their purpose. This is especially important for:
- Database table schemas
- API request/response types
- Configuration interfaces
- Domain models

```typescript
/**
 * Database table schema for log entries.
 */
export interface LogsTable {
  /** Unique identifier (UUID v4) */
  id: string;
  /** ISO 8601 timestamp when the log event occurred */
  timestamp: string;
  /** Name of the service that generated the log */
  service: string;
  /** JSON-serialized arbitrary metadata attached to the log */
  metadata: string | null;
}
```

For simple, self-explanatory properties (like `id`, `name`, `createdAt`), a brief comment is sufficient. For complex or non-obvious properties, provide more context about the expected format, constraints, or usage.

## Singleton Pattern for Expensive Resources

For expensive resources that should only be created once (servers, database connections, etc.), use a module-level singleton pattern with a factory function:

```typescript
let instance: ExpensiveResource | null = null;

/**
 * Returns the singleton instance, creating it on first call.
 */
export function createExpensiveResource(deps: Dependencies): ExpensiveResource {
  if (instance) {
    return instance;
  }

  instance = new ExpensiveResource(deps);
  // ... initialization ...

  return instance;
}

/**
 * Resets the singleton. Only use in tests.
 * @internal
 */
export function resetExpensiveResource(): void {
  instance = null;
}
```

Key points:
- The factory function checks for an existing instance before creating
- Provide a reset function for test isolation (marked `@internal`)
- Tests should call reset in `beforeEach`/`afterEach` to ensure isolation

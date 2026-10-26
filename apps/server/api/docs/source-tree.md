# Source organization

The API groups reusable behavior by capability. HTTP and CLI code adapt that
behavior to their callers; repositories keep persistence in one place.

| Location | What belongs here |
| --- | --- |
| `src/app/` | `ApiContext`, the service dependency map, `BaseService`, and the live event bus |
| `src/api/` | HTTP routes, request validation, response schemas, and transport-specific guards |
| `src/api/middleware/` | Elysia integration, including auth, errors, static assets, and OpenAPI |
| `src/api/ws/` | Browser terminal/dashboard and node WebSocket adapters |
| `src/api/previews/` | Preview HTTP and WebSocket endpoints |
| `src/cli/` | Dispatch, command arguments, terminal prompts, and output formatting |
| `src/db/` | Connections, repositories, table types, and statically registered migrations |
| `src/modules/` | Business workflows, capability-specific helpers, policies, and runtime state |
| `src/shared/` | Capability-independent errors, logging, and small filesystem, path, number, and search helpers |
| `src/testing/` | Fixtures used by multiple test suites; excluded from production emit |
| `src/scripts/`, `src/generated/` | Build/release tools and their generated assets |

`index.ts` remains the boot entrypoint, and `server.ts` composes the application.
`constants.ts`, `version.ts`, and the test preload stay at the source root.
Keep the CLI bootstrap import first: subcommands must not boot the server, and
loading modules must not open SQLite or bind a port.

## Capability owners

All paths below are relative to `src/modules/`.

| Owner | Responsibilities |
| --- | --- |
| `auth/` | Better Auth, providers, credential storage, actor types, session cookies, registration policy, and public-key validation |
| `users/` | Account status, roles, display names, and pending approvals |
| `subshells/` | Resource service, lifecycle manager, MCP launch, tokens, subagents, execution, pane logs, and saved services |
| `nodes/` | Access, enrollment, encrypted links, registry, launchers, inventory, RPC, and node settings synchronization |
| `ssh/` | Launch, relay broker, identities, trust pins, destination verification, setup, SSH presets, and pane-input policy |
| `backups/` | Archives, capture locks, catalog, staging, downloads, recovery, and restore execution/jobs |
| `updates/` | Release discovery, verified downloads, artifact serving decisions, update transactions, and node update tracking/tokens |
| `server/` | Configuration, status, deployment, OS service supervision, installed binaries, restart/reset policies, instance settings, and tmux prerequisites |
| `network/` | Network lifecycle, processes, status caching, access-guard state, trusted origins, and LAN origins |
| `plugins/` | The instance plugin store/overlay, enabled-plugin selection, harness availability, and agent installation |
| `previews/` | Preview broker, local runtime, lane transports, caches, and refusals |
| `files/` | Browsing, path policy, uploads, and transfers |
| `notifications/` | Notification orchestration, idle watching, and push delivery |
| `presets/` | Agent preset parsing and the access/sharing rules common to agent and SSH presets |
| `channels/` | Channel service, post bus, nudges, and read waits |
| `workspaces/` | Workspace service and layout rules |
| `audit.ts` | Audit writing; a single module does not need a directory |

Node-specific synchronization stays in `nodes/`, even when it controls SSH or
previews. Those protocols share the node connection lifecycle. HTTP handlers
stay in `api/`, including the preview endpoints and the node socket adapter.
Subshell plugins belong to `modules/plugins/`; Elysia middleware belongs to
`api/middleware/`.

## Placement and dependencies

- Keep a helper with the capability whose rules it implements. Small or pure
  does not mean shared: preset parsing and node access policy have clear owners.
- Use `.service.ts` for business orchestration, whether implemented as a class
  or functions. Name policies, paths, brokers, and validation for their actual
  responsibilities. Keep existing service lifetimes; placement does not change
  whether something is request-scoped or a process singleton.
- Capability modules must not import HTTP or CLI adapters, including their
  types. Extract reusable input types, policies, status collection, and runtime
  state into the capability. Schemas and presentation remain with the adapter.
- `shared/` must not import capabilities, application wiring, repositories, or
  transport adapters. Keep business knowledge out of it.
- Capabilities may call other capabilities directly. Composition supplies
  transport callbacks where needed, such as closing browser sockets on restart.
- Keep route-specific schemas beside the route. Schemas shared by routes live in
  `api/schemas/`; preserve separate input/output shapes where inference requires
  them. `api/schemas/index.ts` registers Elysia models rather than forwarding exports.
- Import directly from the owning module. Use `index.ts` for real composition,
  such as a resource router, not for forwarding exports already available elsewhere.

`app/__tests__/import-boundaries.test.ts` checks the transport and shared-module
boundaries, including type-only imports.

## Tests and moves

Tests live in `__tests__/` beside their owner. Keep suite-local fixtures there;
put fixtures shared across suites in `testing/`. Follow the
[testing policy](../../../../docs/testing.md) when selecting checks.

Moving a module requires updating imports, mocks, source-reading tests,
subprocess paths, package exports, change-selection rules, and maintained docs.
Relative paths derived from `import.meta.url` need explicit review. The
`@internal/server`, `@internal/server/backup-types`, and
`@internal/server/config-values` package interfaces remain stable even when their
implementation files move. Keep implementation within `apps/server/` so a source
move does not cross the license boundary.

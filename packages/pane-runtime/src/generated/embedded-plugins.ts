import type { EmbeddedPluginSource } from "../builtin-source.js";

/**
 * The built-in plugins, as bytes, for a build with no checkout beside it.
 *
 * **GENERATED. This tracked copy is an empty STUB and must stay that way.**
 * `scripts/embed-plugins.ts` fills it during the release pipelines only, and
 * the result is never committed: it is ~84 KB that would churn on every plugin
 * change. Same shape and same reasoning as `apps/server/api`'s
 * `embedded-web.ts`, whose stub is tracked for the same reason: the import has
 * to be legal on a fresh clone.
 *
 * Running from a checkout, this is not consulted at all. See
 * `builtin-source.ts`, which prefers `packages/plugins/<id>` on disk.
 */
export const EMBEDDED_PLUGINS: Record<string, EmbeddedPluginSource> = {};

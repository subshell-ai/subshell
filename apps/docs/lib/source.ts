import type { LoaderOutput, Meta, Page } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { z } from "zod";

/**
 * The frontmatter contract, pinned by the docs conventions: `title` and
 * `description` are REQUIRED (the default `pageSchema` only requires
 * `title`); `icon` stays optional. Written as a standalone `looseObject`
 * rather than `pageSchema.extend(...)` on purpose — the extend chain on
 * top of fumadocs' schema types trips TS 7.0.2's instantiation-depth limit
 * (TS2589), while this shape typechecks and still satisfies `PageData`.
 * `loose` so future frontmatter keys pass through instead of being stripped.
 *
 * `lastModified: true` resolves each page's last-modified date from git;
 * the page footer renders it as `DocsPage`'s `lastUpdate`.
 */
const frontmatterSchema = z.looseObject({
  title: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  full: z.boolean().optional(),
});

/** The docs content collection (macro API — no `.source` codegen import). */
export const docs = defineDocs({
  dir: "content/docs",
  docs: { schema: frontmatterSchema, lastModified: true },
});

// The concrete entry types ARE correctly inferred at this level...
type DocsPageData = (typeof docs.docs)[number];
type DocsMetaData = (typeof docs.meta)[number];

/**
 * ...but TS 7.0.2 (tsgo) cannot evaluate fumadocs-core's `GeneratePage<I>`
 * conditional through `loader()`'s inference: `pageData` silently collapses
 * to bare `PageData`, losing `body`/`toc`/frontmatter (explicit type
 * arguments and the positional overload collapse the same way — the
 * evaluator, not the inference, is the limit). This re-annotation restates
 * the precise output type the runtime already produces; it changes no
 * behavior and is the narrowest possible hole-plug, confined to this line.
 */
type DocsLoader = LoaderOutput<{
  page: Page<undefined, DocsPageData>;
  meta: Meta<undefined, DocsMetaData>;
  i18n: undefined;
}>;

/**
 * The docs source. `baseUrl: '/'` because the (docs) route group mounts the
 * whole site at the root — there is no `/docs` prefix on docs.subshell.sh.
 */
export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
}) as unknown as DocsLoader;

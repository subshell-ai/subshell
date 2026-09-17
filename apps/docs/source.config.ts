import { defineConfig } from 'fumadocs-mdx/config';
import { remarkGithubAlerts } from './lib/remark-github-alerts';

/**
 * Global Fumadocs MDX configuration.
 *
 * The docs collection itself lives in `lib/source.ts` — fumadocs-mdx 15's
 * macro API (`fumadocs-mdx/macro`) defines collections at their import site
 * and the bundler plugin inlines the compiled content there, so no
 * code-generated `.source` import is needed. This file carries the global
 * config the `createMDX()` wrapper in `next.config.mjs` reads.
 *
 * `remarkPlugins` is given a function so the GitHub-alert converter is
 * APPENDED to the default `fumadocs` preset rather than replacing it — that
 * preset provides GFM, code blocks and heading anchors every page relies on.
 */
export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [...plugins, remarkGithubAlerts],
  },
});

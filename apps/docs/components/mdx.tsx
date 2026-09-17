import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

/**
 * The component map every MDX page renders with: Fumadocs' defaults
 * (callouts, code blocks, anchors) plus anything the caller layers on top.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;

declare global {
  // Types MDX content for `tsc --noEmit`; consumed by the MDX compiler.
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

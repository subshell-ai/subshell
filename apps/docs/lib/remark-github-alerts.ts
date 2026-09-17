/**
 * GitHub-alert → Fumadocs `Callout` conversion.
 *
 * The docs conventions pin GitHub alert syntax (`> [!warning] Draft`) for
 * stub/notice blocks, but Fumadocs' default MDX pipeline renders blockquotes
 * verbatim — its built-in admonition plugin speaks `:::warning` only. This
 * plugin rewrites the GitHub form into the `Callout` component (already in
 * the default MDX component map), preserving the inline title:
 *
 *     > [!warning] Draft
 *     > body...            →  <Callout type="warning" title="Draft">body...</Callout>
 *
 * Raw sources keep the GitHub syntax (`getText('raw')`/llms-full are
 * unaffected), so the tree stays readable on GitHub too.
 *
 * Typed structurally instead of importing `mdast`/`unist-util-visit` —
 * those are not (and need not be) dependencies of this workspace.
 */

interface JsxAttribute {
  type: "mdxJsxAttribute";
  name: string;
  value: string;
}

interface MdastishNode {
  type: string;
  children?: MdastishNode[];
  value?: string;
  name?: string;
  attributes?: JsxAttribute[];
}

/** GitHub alert types → Fumadocs `CalloutType`. */
const ALERT_TYPES: Record<string, string> = {
  note: "info",
  tip: "idea",
  important: "warn",
  warning: "warning",
  caution: "error",
};

const MARKER = /^\[!(note|tip|important|warning|caution)\]\s*(.*)$/i;

/**
 * Convert one blockquote if its first text node is an alert marker.
 * Returns undefined when the blockquote is an ordinary quote.
 */
function tryConvertBlockquote(node: MdastishNode): MdastishNode | undefined {
  const first = node.children?.[0];
  const text = first?.type === "text" ? first : first?.children?.[0];
  if (!text || typeof text.value !== "string") return undefined;

  const lineEnd = text.value.indexOf("\n");
  const firstLine = lineEnd === -1 ? text.value : text.value.slice(0, lineEnd);
  const marker = MARKER.exec(firstLine.trim());
  if (!marker) return undefined;

  const children: MdastishNode[] = node.children ?? [];
  const rest = lineEnd === -1 ? "" : text.value.slice(lineEnd + 1);
  if (rest.trim() === "") {
    children.shift();
  } else {
    text.value = rest.replace(/^[ \t]+/, "");
  }

  const attributes: JsxAttribute[] = [
    { type: "mdxJsxAttribute", name: "type", value: ALERT_TYPES[marker[1].toLowerCase()] },
  ];
  if (marker[2].trim() !== "") {
    attributes.push({ type: "mdxJsxAttribute", name: "title", value: marker[2].trim() });
  }

  return { type: "mdxJsxFlowElement", name: "Callout", attributes, children };
}

function walk(node: MdastishNode): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "blockquote") {
      const converted = tryConvertBlockquote(child);
      if (converted) {
        children[i] = converted;
        walk(converted);
        continue;
      }
    }
    walk(child);
  }
}

/** Remark plugin: rewrite every GitHub-alert blockquote in the tree. */
export function remarkGithubAlerts() {
  return (tree: MdastishNode): void => {
    walk(tree);
  };
}

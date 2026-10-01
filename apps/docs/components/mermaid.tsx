import { renderMermaidSVG } from "beautiful-mermaid";

/** Render trusted, repository-authored diagrams into the static export. */
export function Mermaid({ chart }: { chart: string }) {
  const description = /^%%\s+(.+)$/m.exec(chart)?.[1];
  if (!description) throw new Error("Mermaid diagrams need a %% description for accessible labeling.");
  const svg = renderMermaidSVG(chart.replace(/^%%.*$/gm, "").trim(), {
    bg: "var(--color-fd-background)",
    fg: "var(--color-fd-foreground)",
    line: "var(--color-fd-muted-foreground)",
    accent: "var(--docs-link)",
    surface: "var(--color-fd-card)",
    border: "var(--color-fd-border)",
    transparent: true,
    padding: 12,
    layerSpacing: 20,
    font: "system-ui, sans-serif",
  });
  return (
    <div
      className="docs-diagram"
      role="img"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable diagrams need keyboard access on narrow screens.
      tabIndex={0}
      aria-label={description}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderer escapes labels in trusted repository-authored Mermaid source.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

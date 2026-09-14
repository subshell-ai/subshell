import { type JSX, useMemo } from "react";
import { type AnsiSpan, parseAnsi } from "@/lib/ansi";

/**
 * A non-interactive rendering of a subshell's current screen.
 *
 * Deliberately not a terminal: it renders a server-captured snapshot as
 * styled text, so a page can show many at once. A real xterm per card would
 * cost a WebSocket and a WebGL context each, and browsers cap the latter at
 * around a dozen — the wall of cards would start failing to render at exactly
 * the point it became useful.
 *
 * `pointer-events-none` keeps clicks falling through to whatever wraps this
 * (on a subshell card, the link to the subshell itself), and no text is
 * selectable, so it reads as a picture of the subshell rather than something
 * to type into.
 */
export function TerminalPreview({ lines }: { lines: string[] }): JSX.Element {
  // Parsed as one screen rather than line by line: styling carries across
  // lines, since tmux emits an escape only when something changes.
  const rows = useMemo(() => parseAnsi(lines.join("\n")), [lines]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none select-none overflow-hidden font-mono text-detail leading-[1.35]"
    >
      {rows.map((spans, i) => (
        // Index keys: rows are an anonymous, wholesale-replaced snapshot of a
        // screen, and row N is always the same position on that screen.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional screen rows
        <div key={i} className="whitespace-pre">
          {/* A blank row renders a non-breaking space: an empty div would
              collapse to zero height and shift the rows below it out of
              alignment with the screen they mirror. */}
          {spans.length === 0
            ? "\u00a0"
            : spans.map((span, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a run's position in its row is its identity
                <Span key={j} span={span} />
              ))}
        </div>
      ))}
    </div>
  );
}

/** One styled run within a row. */
function Span({ span }: { span: AnsiSpan }): JSX.Element {
  return (
    <span
      style={{
        color: span.color,
        backgroundColor: span.background,
        fontWeight: span.bold ? 600 : undefined,
        opacity: span.dim ? 0.6 : undefined,
        fontStyle: span.italic ? "italic" : undefined,
        textDecoration: span.underline ? "underline" : undefined,
      }}
    >
      {span.text}
    </span>
  );
}

import { findUrlsInLine } from "@internal/subshell-protocol";

/** A run of text within one Log-tab line, carrying the URL when it is one. */
export interface LogSegment {
  /** The source text to render. */
  text: string;
  /** The URL to open when the run is tapped; absent for plain text. */
  url?: string;
}

/**
 * Split one raw Log line into plain runs and URL runs. The scan is the
 * shared one (`findUrlsInLine` in @internal/subshell-protocol) — the same
 * trim and scheme rules the Live tab's xterm taps apply — so a URL is a URL
 * in both mobile views, and in the web terminal too. The Log has no grid and
 * no wrap seams: the program's own line is the whole story here.
 */
export function logSegments(line: string): LogSegment[] {
  const spans = findUrlsInLine(line);
  if (!spans.length) return [{ text: line }];
  const segments: LogSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ text: line.slice(cursor, span.start) });
    segments.push({ text: line.slice(span.start, span.end), url: span.url });
    cursor = span.end;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor) });
  return segments;
}

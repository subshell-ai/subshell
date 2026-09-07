/**
 * Minimal ANSI SGR parser for terminal previews.
 *
 * Scoped deliberately to SGR (colour and attribute) sequences, because that
 * is all the server sends: previews come from `tmux capture-pane -p -e`,
 * which renders the pane's *current screen* and emits styling only — never
 * cursor movement, scroll regions or erases. A general terminal emulator
 * would be the wrong tool here; xterm already fills that role on the pages
 * that need a real terminal, at a cost (a socket and a WebGL context each)
 * that a wall of preview cards cannot pay.
 */

/** One run of text sharing the same styling. */
export interface AnsiSpan {
  text: string;
  /** Foreground colour as a CSS colour, or undefined for the default. */
  color?: string;
  /** Background colour as a CSS colour, or undefined for the default. */
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * The 16 base colours, matching the palette xterm renders in the real
 * terminal views, so a preview and its subshell don't disagree about what
 * "red" looks like.
 */
const BASE_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

/** Resolves one of the 256 indexed colours to a CSS colour. */
export function indexedColor(index: number): string | undefined {
  if (index < 0 || index > 255) return undefined;
  if (index < 16) return BASE_COLORS[index];
  if (index < 232) {
    // 6x6x6 colour cube; each axis uses xterm's non-linear ramp.
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    const c = index - 16;
    return `rgb(${level(Math.floor(c / 36))}, ${level(Math.floor(c / 6) % 6)}, ${level(c % 6)})`;
  }
  // 24-step grayscale ramp.
  const v = 8 + (index - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

/** Mutable styling state while scanning a screen. */
interface SgrState {
  color?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

/**
 * The default styling.
 *
 * `color` and `background` are spelled out as explicit `undefined` rather
 * than left off: a reset applies this via `Object.assign`, which only copies
 * keys that are present, so omitting them would leave a previously-set colour
 * in place and a reset would silently fail to clear it.
 */
function emptyState(): SgrState {
  return {
    color: undefined,
    background: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

/**
 * Applies one SGR parameter list to `state`.
 *
 * Unknown parameters are skipped rather than treated as an error: a preview
 * that drops an attribute it doesn't model still reads correctly, whereas one
 * that bailed on the first surprise would show raw escape bytes.
 */
function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    switch (p) {
      case 0:
        Object.assign(state, emptyState());
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.dim = true;
        break;
      case 3:
        state.italic = true;
        break;
      case 4:
        state.underline = true;
        break;
      case 7:
        state.inverse = true;
        break;
      case 22:
        state.bold = false;
        state.dim = false;
        break;
      case 23:
        state.italic = false;
        break;
      case 24:
        state.underline = false;
        break;
      case 27:
        state.inverse = false;
        break;
      case 39:
        state.color = undefined;
        break;
      case 49:
        state.background = undefined;
        break;
      case 38:
      case 48: {
        // Extended colour: `38;5;n` (indexed) or `38;2;r;g;b` (truecolour).
        // The consumed parameters are skipped via `i` so they are never read
        // back as attributes of their own.
        const mode = params[i + 1];
        if (mode === 5) {
          const resolved = indexedColor(params[i + 2] ?? -1);
          if (p === 38) state.color = resolved;
          else state.background = resolved;
          i += 2;
        } else if (mode === 2) {
          const r = params[i + 2] ?? 0;
          const g = params[i + 3] ?? 0;
          const b = params[i + 4] ?? 0;
          const css = `rgb(${r}, ${g}, ${b})`;
          if (p === 38) state.color = css;
          else state.background = css;
          i += 4;
        }
        break;
      }
      default:
        if (p >= 30 && p <= 37) state.color = BASE_COLORS[p - 30];
        else if (p >= 90 && p <= 97) state.color = BASE_COLORS[p - 90 + 8];
        else if (p >= 40 && p <= 47) state.background = BASE_COLORS[p - 40];
        else if (p >= 100 && p <= 107) state.background = BASE_COLORS[p - 100 + 8];
        break;
    }
  }
}

/**
 * Snapshots the current state as a span's styling.
 *
 * Only the properties that actually apply are set, rather than every property
 * with `undefined` for the unset ones: a plain run of text is then just
 * `{ text }`, which keeps the common case cheap to render and compare.
 */
function spanFrom(state: SgrState, text: string): AnsiSpan {
  const span: AnsiSpan = { text };
  const color = state.inverse ? state.background : state.color;
  const background = state.inverse ? state.color : state.background;
  if (color) span.color = color;
  if (background) span.background = background;
  if (state.bold) span.bold = true;
  if (state.dim) span.dim = true;
  if (state.italic) span.italic = true;
  if (state.underline) span.underline = true;
  return span;
}

/**
 * Matches any CSI sequence. Only the SGR ones (final byte `m`) change
 * styling; the rest are dropped so their bytes never reach the page.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the sequence being matched, not a stray byte
const CSI = /\x1b\[([0-9;]*)([a-zA-Z])/g;

/**
 * Parses a captured screen into styled spans, one array per line.
 *
 * Styling carries across lines, because tmux emits an escape only when
 * something changes: a colour set at the end of one line is still in effect
 * at the start of the next.
 */
export function parseAnsi(screen: string): AnsiSpan[][] {
  const state = emptyState();
  return screen.split("\n").map((line) => {
    const spans: AnsiSpan[] = [];
    let last = 0;
    CSI.lastIndex = 0;
    let match = CSI.exec(line);
    while (match !== null) {
      if (match.index > last) spans.push(spanFrom(state, line.slice(last, match.index)));
      if (match[2] === "m") {
        // An empty parameter list means SGR 0 (`ESC[m` is a reset).
        const params = match[1] === "" ? [0] : match[1].split(";").map((n) => Number.parseInt(n, 10) || 0);
        applySgr(state, params);
      }
      last = match.index + match[0].length;
      match = CSI.exec(line);
    }
    if (last < line.length) spans.push(spanFrom(state, line.slice(last)));
    return spans;
  });
}

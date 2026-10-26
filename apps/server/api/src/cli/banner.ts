/**
 * The boot banner: `/subshell` as a block wordmark.
 *
 * Two earlier attempts, recorded so neither is retried by accident:
 *
 * 1. RASTERIZING `brand/src/wordmark.svg` would have kept the banner sourced
 *    from the master, but Acherus is a hairline face and at the ~12 pixel rows
 *    a banner can afford EVERY weight in the family thresholds into uneven,
 *    broken strokes. It reads as wrong rather than as small — the
 *    16px-favicon problem, with the usual answer: below a certain size a mark
 *    is redrawn for the grid, not resampled onto it.
 * 2. HALF-BLOCK glyphs (U+2580 and friends) packed more detail per row but
 *    depend on the font rendering block elements at exactly the cell box; the
 *    seams show in a lot of terminals.
 *
 * Plain ASCII avoids both. `#` draws `/sub` and `+` draws `shell`, so the
 * two-tone split of the real wordmark survives even where colour does not —
 * a journal, a piped log, a terminal with no truecolor. The slash travels
 * exactly one column per row, which is what keeps it reading as a straight
 * stroke rather than a staircase.
 */
const WORDMARK = [
  "       ##                    ##                ++                ++ ++",
  "      ##                     ##                ++                ++ ++",
  "     ##     ######  ##    ## #######   ++++++  +++++++   ++++++  ++ ++",
  "    ##     ##       ##    ## ##    ## ++       ++    ++ ++    ++ ++ ++",
  "   ##       ######  ##    ## ##    ##  ++++++  ++    ++ ++++++++ ++ ++",
  "  ##             ## ##    ## ##    ##       ++ ++    ++ ++       ++ ++",
  " ##         ######   ######  #######   ++++++  ++    ++  ++++++  ++ ++",
] as const;

/**
 * Column boundaries of the three brand-coloured runs. The rows are aligned, so
 * these are plain string offsets: the slash, then `sub`, then `shell` — the
 * same split the `#`/`+` characters already draw.
 */
const SLASH_END = 11;
const SUB_END = 38;

/** brand/src/wordmark.svg — the slash's gradient stops, top to bottom. */
const SLASH_GRADIENT: readonly (readonly [number, number, number])[] = [
  [0x74, 0x4b, 0x8d],
  [0xa6, 0x78, 0xbd],
  [0xd9, 0xc6, 0xe8],
];
/** brand/src/wordmark.svg — the fills for `sub` and `shell`. */
const SUB_RGB = [0x9c, 0x71, 0xae] as const;
const SHELL_RGB = [0xe6, 0xdb, 0xef] as const;

const RESET = "\u001b[0m";

/** Wraps text in a 24-bit foreground colour; whitespace-only runs are left bare. */
function paint(text: string, [r, g, b]: readonly [number, number, number]): string {
  return text.trim() === "" ? text : `\u001b[38;2;${r};${g};${b}m${text}${RESET}`;
}

/**
 * The gradient colour at `t` (0 at the top of the mark, 1 at the bottom),
 * interpolated between {@link SLASH_GRADIENT}'s stops — spaced evenly here
 * rather than at the SVG's 0/0.62/1, which seven rows cannot resolve.
 */
function gradientAt(t: number): readonly [number, number, number] {
  const span = 1 / (SLASH_GRADIENT.length - 1);
  const i = Math.min(Math.floor(t / span), SLASH_GRADIENT.length - 2);
  const local = (t - i * span) / span;
  const [a, b] = [SLASH_GRADIENT[i], SLASH_GRADIENT[i + 1]];
  return [
    Math.round(a[0] + (b[0] - a[0]) * local),
    Math.round(a[1] + (b[1] - a[1]) * local),
    Math.round(a[2] + (b[2] - a[2]) * local),
  ] as const;
}

/**
 * The banner, as one string ready to log.
 *
 * @param colour - whether to emit 24-bit ANSI colour. Defaults to "is stdout a
 *   terminal": under systemd or launchd it is not, and escape codes written
 *   into a journal are something an operator has to read around forever.
 * @returns The rows joined by newlines, with no trailing newline
 */
export function banner(colour: boolean = process.stdout.isTTY === true): string {
  if (!colour) return WORDMARK.join("\n");
  return WORDMARK.map((line, i) => {
    const t = i / (WORDMARK.length - 1);
    return (
      paint(line.slice(0, SLASH_END), gradientAt(t)) +
      paint(line.slice(SLASH_END, SUB_END), SUB_RGB) +
      paint(line.slice(SUB_END), SHELL_RGB)
    );
  }).join("\n");
}

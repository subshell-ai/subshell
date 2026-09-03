/** Brand asset generator — the ONLY way brand PNGs are produced.
 *
 * Rasterizes the text-SVG masters in brand/src/ with @resvg/resvg-js against the
 * operator-held licensed font (never committed, never served). Outputs are
 * committed PNGs; CI never runs this script. See the branding spec:
 * docs/superpowers/specs/2026-09-02-subshell-branding-design.md
 *
 * Run: bun run brand:generate   (optionally SUBSHELL_BRAND_FONTS_DIR=/path)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { buildIco } from "./ico";

const BRAND_DIR = import.meta.dir;
const SRC_DIR = path.join(BRAND_DIR, "src");
const ICONS_DIR = path.join(BRAND_DIR, "../apps/frontend/public/icons");
const DOCS_DIR = path.join(BRAND_DIR, "../docs/assets");

// brand:generate is a root script, not a turbo task — no cache key to declare for.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: maintainer-local font path, outside turbo
const fontDir = process.env.SUBSHELL_BRAND_FONTS_DIR ?? path.join(homedir(), "fonts", "acherus");
/** Everything — wordmark and mark — is Light 300 (operator choice 2026-09-03: Thin read too weak beside the UI's label weights). */
const fontFiles = ["Acherus-Grotesque-Light.otf"].map((f) => path.join(fontDir, f));
for (const f of fontFiles) {
  if (!existsSync(f)) {
    console.error(
      `Licensed font not found: ${f}\n` +
        "Place the Acherus Grotesque OTFs there (or set SUBSHELL_BRAND_FONTS_DIR).\n" +
        "The font CANNOT be vendored into this repo — see the branding spec §2.",
    );
    process.exit(1);
  }
}

type Mode = "width" | "height";

/** Job list = the single source of truth for every output (spec §3.1). */
const JOBS: { master: string; mode: Mode; size: number; out: string }[] = [
  { master: "tile-rounded.svg", mode: "width", size: 16, out: "icons/favicon-16.png" },
  { master: "tile-rounded.svg", mode: "width", size: 32, out: "icons/favicon-32.png" },
  { master: "tile-rounded.svg", mode: "width", size: 48, out: "icons/favicon-48.png" },
  { master: "tile-square.svg", mode: "width", size: 180, out: "icons/apple-touch-icon.png" },
  { master: "tile-square.svg", mode: "width", size: 192, out: "icons/icon-192.png" },
  { master: "tile-square.svg", mode: "width", size: 512, out: "icons/icon-512.png" },
  { master: "wordmark.svg", mode: "height", size: 40, out: "icons/wordmark-40.png" },
  { master: "wordmark.svg", mode: "height", size: 80, out: "icons/wordmark-80.png" },
  { master: "wordmark.svg", mode: "height", size: 120, out: "icons/wordmark-120.png" },
  { master: "wordmark.svg", mode: "height", size: 96, out: "icons/wordmark-96.png" },
  { master: "wordmark.svg", mode: "height", size: 192, out: "icons/wordmark-192.png" },
  { master: "mark-glyph.svg", mode: "height", size: 40, out: "icons/mark-40.png" },
  { master: "mark-glyph.svg", mode: "height", size: 80, out: "icons/mark-80.png" },
  { master: "mark-glyph.svg", mode: "height", size: 120, out: "icons/mark-120.png" },
  { master: "wordmark-plate.svg", mode: "width", size: 640, out: "docs/subshell-wordmark.png" },
  { master: "wordmark-plate.svg", mode: "width", size: 1280, out: "docs/subshell-wordmark@2x.png" },
];

/** Rasterizes one master at the requested pixel size (deterministic). */
function render(master: string, mode: Mode, size: number): Buffer {
  const svg = readFileSync(path.join(SRC_DIR, master), "utf8");
  const resvg = new Resvg(svg, {
    fitTo: { mode, value: size },
    font: {
      fontFiles,
      loadSystemFonts: false, // deterministic: only the licensed faces exist here
      defaultFontFamily: "Acherus Grotesque Light",
    },
  });
  return Buffer.from(resvg.render().asPng());
}

const outputs = new Map<string, Buffer>();
for (const job of JOBS) outputs.set(job.out, render(job.master, job.mode, job.size));
outputs.set(
  "icons/favicon.ico",
  buildIco([
    { size: 16, png: outputs.get("icons/favicon-16.png") as Buffer },
    { size: 32, png: outputs.get("icons/favicon-32.png") as Buffer },
    { size: 48, png: outputs.get("icons/favicon-48.png") as Buffer },
  ]),
);

mkdirSync(ICONS_DIR, { recursive: true });
mkdirSync(DOCS_DIR, { recursive: true });
for (const [out, bytes] of outputs) {
  const file = out.startsWith("icons/")
    ? path.join(ICONS_DIR, out.slice("icons/".length))
    : path.join(DOCS_DIR, out.slice("docs/".length));
  writeFileSync(file, bytes);
  console.log(`wrote ${out} (${bytes.length} B)`);
}
console.log(
  "\nCommit the regenerated PNGs. Never hand-edit them; change brand/src/*.svg or the JOBS table and re-run.",
);

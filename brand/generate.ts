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
const ICONS_DIR = path.join(BRAND_DIR, "../apps/server/web/public/icons");
const DOCS_DIR = path.join(BRAND_DIR, "../docs/assets");
/** The docs SITE's asset root: header lockups the Next app serves directly. */
const DOCS_SITE_DIR = path.join(BRAND_DIR, "../apps/docs/public");
/**
 * The two sites' icon roots (docs, marketing). They are their own static
 * servers and cannot reach the SPA's `public/icons`, so the generated set is
 * written into each, byte-identical to the SPA's — the same multi-root rule
 * `desktop-ui/` follows for the Tauri pages, and for the same reason: a
 * hand-copied PNG is exactly what this script forbids.
 */
const SITE_ICON_DIRS = [
  path.join(BRAND_DIR, "../apps/docs/public/icons"),
  path.join(BRAND_DIR, "../apps/website/public/icons"),
];
/** The favicon set both sites declare in their metadata (the 192/512 PWICONS,
 * the standalone marks and the wordmarks are the SPA's own concern). */
const SITE_ICON_FILES = [
  "favicon-16.png",
  "favicon-32.png",
  "favicon-48.png",
  "favicon.ico",
  "apple-touch-icon.png",
];
/**
 * The Subshell Server desktop app's bundled pages (the setup assistant and the
 * console) serve their own static files — they are a separate Vite build from
 * the SPA and cannot reach into `apps/server/web/public`. The wordmark the
 * assistant's Welcome screen shows is therefore GENERATED into both places
 * rather than copied between them: a hand-copied PNG is exactly what this
 * script's closing line forbids, and it would silently keep an old mark after
 * the master changed.
 */
/**
 * The two Tauri apps' bundled pages. Each has its OWN Vite build with its own
 * asset root, so neither can reach the SPA's `public/icons` and neither can
 * reach the other's — a wordmark on a bundled page is a copy per app, and this
 * is where those copies come from rather than being carried across by hand.
 */
const DESKTOP_UI_DIRS = [
  path.join(BRAND_DIR, "../apps/server/desktop/ui/public"),
  path.join(BRAND_DIR, "../apps/client/desktop/ui/public"),
];
const APPS_DIR = path.join(BRAND_DIR, "../apps");

/** Everything — wordmark and mark — is Light 300 (operator choice 2026-09-03: Thin read too weak beside the UI's label weights). */
const FONT_FILE = "Acherus-Grotesque-Light.otf";

/**
 * Where the licensed OTF might live, most specific first.
 *
 * The original single default (`~/fonts/acherus`) was one maintainer's Linux
 * layout, so the pipeline simply refused to run for anyone who had installed
 * the family the normal way for their OS. The font is INSTALLED, not vendored,
 * so the honest thing is to look where each platform actually installs fonts —
 * `SUBSHELL_BRAND_FONTS_DIR` remains the override for anything unusual.
 *
 * `loadSystemFonts` stays false in {@link render}: finding the file by
 * convention is not the same as letting resvg pick a substitute, and a silent
 * fallback face would produce PNGs that look almost right.
 */
function fontSearchPath(): string[] {
  const home = homedir();
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: maintainer-local font path, outside turbo
  const override = process.env.SUBSHELL_BRAND_FONTS_DIR;
  if (override) return [override];
  const shared = [path.join(home, "fonts", "acherus"), path.join(home, "fonts")];
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Fonts"), "/Library/Fonts", ...shared];
  }
  if (process.platform === "win32") {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Windows-only font root
    const windir = process.env.WINDIR ?? "C:\\Windows";
    return [path.join(home, "AppData", "Local", "Microsoft", "Windows", "Fonts"), path.join(windir, "Fonts"), ...shared];
  }
  return [
    path.join(home, ".local", "share", "fonts"),
    path.join(home, ".fonts"),
    "/usr/local/share/fonts",
    "/usr/share/fonts",
    ...shared,
  ];
}

const searched = fontSearchPath();
const fontDir = searched.find((dir) => existsSync(path.join(dir, FONT_FILE)));
if (!fontDir) {
  console.error(
    `Licensed font ${FONT_FILE} not found. Searched:\n` +
      searched.map((d) => `  ${d}`).join("\n") +
      "\n\nInstall the Acherus Grotesque OTFs (or set SUBSHELL_BRAND_FONTS_DIR).\n" +
      "The font CANNOT be vendored into this repo — see the branding spec §2.",
  );
  process.exit(1);
}
const fontFiles = [path.join(fontDir, FONT_FILE)];

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
  // The desktop pages that show the wordmark — the server app's setup-assistant
  // Welcome screen and both apps' About surfaces — at 1x and 2x. Written into
  // EVERY entry of DESKTOP_UI_DIRS.
  { master: "wordmark.svg", mode: "height", size: 96, out: "desktop-ui/wordmark-96.png" },
  { master: "wordmark.svg", mode: "height", size: 192, out: "desktop-ui/wordmark-192.png" },
  { master: "mark-glyph.svg", mode: "height", size: 40, out: "icons/mark-40.png" },
  { master: "mark-glyph.svg", mode: "height", size: 80, out: "icons/mark-80.png" },
  { master: "mark-glyph.svg", mode: "height", size: 120, out: "icons/mark-120.png" },
  { master: "wordmark-plate.svg", mode: "width", size: 640, out: "docs/subshell-wordmark.png" },
  { master: "wordmark-plate.svg", mode: "width", size: 1280, out: "docs/subshell-wordmark@2x.png" },
  // The docs site's header lockup: the wordmark with the suite word "docs"
  // after it (the site is dark-only, so transparent-on-void is the only
  // ground it ever sits on).
  { master: "wordmark-docs.svg", mode: "height", size: 96, out: "docs-site/wordmark-docs-96.png" },
  { master: "wordmark-docs.svg", mode: "height", size: 192, out: "docs-site/wordmark-docs-192.png" },
];

/**
 * The desktop apps' icon backgrounds — the ONE thing that differs between them.
 *
 * Two Tauri apps ship side by side (`apps/server/desktop` = Subshell Server,
 * `apps/client/desktop` = Subshell Client) and they used to carry byte-identical
 * icons, which made them indistinguishable in a Dock, a launcher and a menu
 * bar. The mark stays the same — it is one product — so the background carries
 * the difference.
 *
 * Both colours come off the UI palette in `apps/server/web/src/styles.css` rather
 * than being picked by eye: the server takes `--background` (the product
 * ground, oklch 0.224 0.035 296) and the client app the accent hue at a mid
 * lightness (oklch 0.38 0.13 322). They differ in BOTH hue and lightness,
 * which is what survives being scaled to a 22pt menu-bar icon, and each keeps
 * the `#e6dbef` glyph above 8:1 contrast.
 *
 * The output is a 1024px master only. The platform icon SET (`.icns`, the
 * sized PNGs) is cut from it by `tauri icon`, which each app runs through its
 * own `bun run icons` — see the note printed at the end of this script.
 */
const DESKTOP_ICON_SIZE = 1024;
/** Keyed by `apps/`-relative directory — used both as a path and as a `--cwd`. */
const DESKTOP_APPS: { app: string; background: string }[] = [
  { app: "server/desktop", background: "#1d182a" },
  { app: "client/desktop", background: "#61246a" },
];

/**
 * Swap the tile's background fill.
 *
 * Deliberately narrow: it matches the ONE rect carrying `id="bg"` and throws
 * rather than guessing, so a master edited to move that id fails the build
 * instead of silently emitting two icons the same colour — which is the exact
 * bug this whole table exists to fix.
 */
function recolorBackground(svg: string, background: string): string {
  const rect = /<rect id="bg"([^>]*?)fill="#[0-9a-fA-F]{3,8}"/;
  if (!rect.test(svg)) {
    throw new Error('tile master has no <rect id="bg" … fill="#…"> to recolour');
  }
  return svg.replace(rect, `<rect id="bg"$1fill="${background}"`);
}

/** Rasterizes one master at the requested pixel size (deterministic). */
function render(master: string, mode: Mode, size: number, edit?: (svg: string) => string): Buffer {
  const raw = readFileSync(path.join(SRC_DIR, master), "utf8");
  const svg = edit ? edit(raw) : raw;
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

/** The desktop app masters, keyed by their absolute destination. */
const appIcons = new Map<string, Buffer>();
for (const { app, background } of DESKTOP_APPS) {
  appIcons.set(
    path.join(APPS_DIR, app, "src-tauri/icons/app-icon.png"),
    // The ROUNDED tile, not the square one the web favicons use: macOS does
    // not round an app icon for you, so a square master ships as a hard-edged
    // square among rounded Dock neighbours.
    render("tile-rounded.svg", "width", DESKTOP_ICON_SIZE, (svg) => recolorBackground(svg, background)),
  );
}

mkdirSync(ICONS_DIR, { recursive: true });
mkdirSync(DOCS_DIR, { recursive: true });
mkdirSync(DOCS_SITE_DIR, { recursive: true });
for (const dir of SITE_ICON_DIRS) mkdirSync(dir, { recursive: true });
for (const dir of DESKTOP_UI_DIRS) mkdirSync(dir, { recursive: true });
for (const [out, bytes] of outputs) {
  // A `desktop-ui/` job writes the same bytes into every bundled page's asset
  // root; everything else has one destination.
  if (out.startsWith("desktop-ui/")) {
    for (const dir of DESKTOP_UI_DIRS) {
      writeFileSync(path.join(dir, out.slice("desktop-ui/".length)), bytes);
    }
    console.log(`wrote ${out} \u00d7${DESKTOP_UI_DIRS.length} (${bytes.length} B)`);
    continue;
  }
  const file = out.startsWith("icons/")
    ? path.join(ICONS_DIR, out.slice("icons/".length))
    : out.startsWith("docs-site/")
      ? path.join(DOCS_SITE_DIR, out.slice("docs-site/".length))
      : path.join(DOCS_DIR, out.slice("docs/".length));
  writeFileSync(file, bytes);
  console.log(`wrote ${out} (${bytes.length} B)`);
}
// The two sites' favicon sets are the SPA's bytes, mirrored from the same
// `outputs` map (never a re-render, never a hand-copy): one source, three
// static roots, byte-identical.
for (const name of SITE_ICON_FILES) {
  const bytes = outputs.get(`icons/${name}`) as Buffer;
  for (const dir of SITE_ICON_DIRS) writeFileSync(path.join(dir, name), bytes);
  console.log(`wrote ${name} to ${SITE_ICON_DIRS.length} site icon roots (${bytes.length} B)`);
}
for (const [file, bytes] of appIcons) {
  writeFileSync(file, bytes);
  console.log(`wrote ${path.relative(path.join(BRAND_DIR, ".."), file)} (${bytes.length} B)`);
}

console.log(
  "\nCommit the regenerated PNGs. Never hand-edit them; change brand/src/*.svg or the JOBS table and re-run.",
);
console.log(
  "\nThe desktop app-icon SETS are cut from those masters by tauri, not by this script:\n" +
    DESKTOP_APPS.map(({ app }) => `  bun run --cwd apps/${app} icons`).join("\n"),
);

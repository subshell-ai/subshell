# Subshell Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the approved brand assets (wordmark `/subshell` + `/s` mark) as committed PNGs via a deterministic generator, and wire them into the frontend, index.html, and README.

**Architecture:** `brand/` holds text-SVG masters (font referenced by family name only — no font data, never served) and a bun script that rasterizes them with `@resvg/resvg-js` against the operator-held licensed font. PNG outputs land in `apps/frontend/public/icons/` (served) and `docs/assets/` (README). App code just references the committed PNGs.

**Tech Stack:** Bun, `@resvg/resvg-js` 2.6.2 (root devDependency), React/TanStack frontend, zero new runtime deps.

**Spec:** `docs/superpowers/specs/2026-09-02-subshell-branding-design.md` — canonical colors, scale table, license rules. Read it first.

## Global Constraints

- Never commit font binaries (OTF/WOFF/TTF) or outlined-glyph logo SVGs; shipped brand artifacts are **PNG only** (license).
- Licensed font lives outside the repo: `~/fonts/acherus/Acherus-Grotesque-Thin.otf`, overridable via `SUBSHELL_BRAND_FONTS_DIR`. Generator must fail fast if absent.
- `@resvg/resvg-js` pinned exact: `2.6.2`. All `package.json` versions pinned (no `^`/`~`).
- No dynamic imports anywhere. Static `import` only.
- Colors (verbatim from spec §1.1): bg `#0a0a0a`, slash gradient `#744b8d` → `#a678bd` (62%) → `#d9c6e8`, `sub` `#9c71ae`, `shell` `#e6dbef`, dust orchid `#c39bd9`, lavender `#e6dbef`, plum `#9c71ae`, deep `#744b8d`.
- Font facts (measured from the OTF): family name **`Acherus Grotesque Thin`**, upem 1000, advances em: `/`=0.351 `s`=0.514 `u`=0.621 `b`=0.655 `h`=0.624 `e`=0.606 `l`=0.243; letter-spacing 0.011em; hhea ascent 1.00 / descent −0.40.
- `bun run verify-types && bun run lint:check && bun run test` must pass at the end of every task that touches code.

## Pre-flight (do once, not a repo change)

The licensed font must be staged where the generator looks. Run:

```bash
mkdir -p ~/fonts/acherus
cp /tmp/subshell-font/T6861-OT/Acherus-Grotesque-Thin.otf ~/fonts/acherus/
```

(If `/tmp/subshell-font` is gone, the OTF comes from the operator's original download — ask, don't hunt the internet.)

---

### Task 1: Brand pipeline — masters + generator + committed PNGs

**Files:**
- Modify: `package.json` (root: devDependency + `brand:generate` script)
- Create: `brand/src/wordmark.svg`, `brand/src/wordmark-plate.svg`, `brand/src/mark-glyph.svg`, `brand/src/tile-rounded.svg`, `brand/src/tile-square.svg`
- Create: `brand/generate.ts`
- Create: `brand/ico.ts`, `brand/__tests__/ico.test.ts`
- Create (generated, committed): `apps/frontend/public/icons/{favicon-16,favicon-32,favicon-48,apple-touch-icon,icon-192,icon-512}.png`, `apps/frontend/public/icons/favicon.ico`, `apps/frontend/public/icons/wordmark-{40,80,120,96,192}.png`, `apps/frontend/public/icons/mark-{40,80,120}.png`, `docs/assets/subshell-wordmark.png`, `docs/assets/subshell-wordmark@2x.png`
- Create: `brand/README.md` (how to regenerate)

**Interfaces:**
- Produces: PNG files listed above at the exact filenames/paths §3.1 of the spec; `bun run brand:generate`; `buildIco(entries: {size:number; png:Buffer}[]): Buffer` exported from `brand/ico.ts`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add the pinned devDependency and script**

In root `package.json`: add to `"devDependencies"` → `"@resvg/resvg-js": "2.6.2"` (keep alphabetical), and to `"scripts"` → `"brand:generate": "bun brand/generate.ts"`. Then `bun install`. Verify: `bunx --bun node -e "import('@resvg/resvg-js').then(m => console.log(typeof m.Resvg))"` prints `function`.

- [ ] **Step 2: Write the failing ICO test**

Create `brand/__tests__/ico.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildIco } from "../ico";

const png16 = Buffer.alloc(8, 1); // payload content irrelevant; only framing is tested
const png32 = Buffer.alloc(12, 2);

describe("buildIco", () => {
  test("header counts images and directory offsets are correct", () => {
    const ico = buildIco([
      { size: 16, png: png16 },
      { size: 32, png: png32 },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(2); // count
    expect(ico[6]).toBe(16); // entry0 width
    expect(ico[7]).toBe(16); // entry0 height
    expect(ico.readUInt32LE(12)).toBe(8); // entry0 payload size
    expect(ico.readUInt32LE(16)).toBe(6 + 16); // entry1 offset = header + one entry
    expect(ico.subarray(22, 30)).toEqual(png32.subarray(0, 8));
    expect(ico.length).toBe(6 + 32 + 8 + 12);
  });

  test("256px encodes as 0 bytes", () => {
    const ico = buildIco([{ size: 256, png: png16 }]);
    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd brand && bun test __tests__/ico.test.ts` (or from root: `bun test brand/__tests__/ico.test.ts`)
Expected: FAIL — cannot resolve `../ico`.

- [ ] **Step 4: Implement `brand/ico.ts`**

```ts
/** Minimal ICO container writer: PNG-compressed entries, one per size.
 * Kept in-repo so icon generation needs no extra dependency. */
export interface IcoEntry {
  /** Edge length in px (16..256). */
  size: number;
  /** Complete PNG file bytes for this size. */
  png: Buffer;
}

/** Builds an .ico file from PNG entries (Vista+ PNG-compressed format). */
export function buildIco(entries: IcoEntry[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icons
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = Buffer.alloc(entries.length * 16);
  entries.forEach((e, i) => {
    const p = i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size; // width  (0 means 256)
    dir[p + 1] = e.size >= 256 ? 0 : e.size; // height (ICO squares use square art)
    dir[p + 2] = 0; // palette count
    dir[p + 3] = 0; // reserved
    dir.writeUInt16LE(1, p + 4); // color planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}
```

Run the test again — expected PASS both cases.

- [ ] **Step 5: Create the four masters (geometry below is precomputed from the measured advances; baseline y=100, font-size 100)**

`brand/src/wordmark.svg` — full lockup, transparent. Text x-positions: slash at 0 (advance 35.1 + 1.1 ls → next at 36.2), `sub` at 36.2 (181.2 wide incl. inner ls → next at 218.5), `shell` at 218.5 (227.4 wide → text ends ≈446). Dust rects follow spec §1.2.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 12 584 126">
  <defs>
    <linearGradient id="slash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#744b8d"/>
      <stop offset="0.62" stop-color="#a678bd"/>
      <stop offset="1" stop-color="#d9c6e8"/>
    </linearGradient>
  </defs>
  <g font-family="Acherus Grotesque Thin" font-size="100" letter-spacing="1.1">
    <text x="0" y="100" fill="url(#slash)">/</text>
    <text x="36.2" y="100" fill="#9c71ae">sub</text>
    <text x="218.5" y="100" fill="#e6dbef">shell</text>
  </g>
  <rect x="468" y="54" width="11" height="11" rx="2" fill="#c39bd9"/>
  <rect x="488" y="24" width="9" height="9" rx="2" fill="#e6dbef"/>
  <rect x="507" y="58" width="5" height="5" rx="1.5" fill="#9c71ae"/>
  <rect x="525" y="37" width="7" height="7" rx="1.5" fill="#c39bd9"/>
  <rect x="542" y="67" width="3" height="3" rx="1" fill="#e6dbef"/>
  <rect x="564" y="47" width="3" height="3" rx="1" fill="#744b8d"/>
</svg>
```

`brand/src/wordmark-plate.svg` — README banner: same lockup centered on a `#0a0a0a` plate (lockup translated by 30,7 and viewBox grown by that padding):

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-32 -12 648 166">
  <defs>
    <linearGradient id="slash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#744b8d"/>
      <stop offset="0.62" stop-color="#a678bd"/>
      <stop offset="1" stop-color="#d9c6e8"/>
    </linearGradient>
  </defs>
  <rect x="-32" y="-12" width="648" height="166" fill="#0a0a0a"/>
  <g transform="translate(30,8)">
    <g font-family="Acherus Grotesque Thin" font-size="100" letter-spacing="1.1">
      <text x="0" y="100" fill="url(#slash)">/</text>
      <text x="36.2" y="100" fill="#9c71ae">sub</text>
      <text x="218.5" y="100" fill="#e6dbef">shell</text>
    </g>
    <rect x="468" y="54" width="11" height="11" rx="2" fill="#c39bd9"/>
    <rect x="488" y="24" width="9" height="9" rx="2" fill="#e6dbef"/>
    <rect x="507" y="58" width="5" height="5" rx="1.5" fill="#9c71ae"/>
    <rect x="525" y="37" width="7" height="7" rx="1.5" fill="#c39bd9"/>
    <rect x="542" y="67" width="3" height="3" rx="1" fill="#e6dbef"/>
    <rect x="564" y="47" width="3" height="3" rx="1" fill="#744b8d"/>
  </g>
</svg>
```

`brand/src/mark-glyph.svg` — transparent `/s` (glyph width: 35.1 + 1.1 + 51.4 = 87.6):

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 12 94 126">
  <defs>
    <linearGradient id="slash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#744b8d"/>
      <stop offset="0.62" stop-color="#a678bd"/>
      <stop offset="1" stop-color="#d9c6e8"/>
    </linearGradient>
  </defs>
  <g font-family="Acherus Grotesque Thin" font-size="100" letter-spacing="1.1">
    <text x="0" y="100" fill="url(#slash)">/</text>
    <text x="36.2" y="100" fill="#e6dbef">s</text>
  </g>
</svg>
```

`brand/src/tile-rounded.svg` — favicon tile: 512×512, rx 113 (≈22%), mark at font-size 210 centered (cluster width 184 → x 164 +4 optical nudge; baseline 319 = center + 0.3em):

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="slash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#744b8d"/>
      <stop offset="0.62" stop-color="#a678bd"/>
      <stop offset="1" stop-color="#d9c6e8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="113" fill="#0a0a0a"/>
  <g font-family="Acherus Grotesque Thin" font-size="210" letter-spacing="2.31">
    <text x="168" y="319" fill="url(#slash)">/</text>
    <text x="244" y="319" fill="#e6dbef">s</text>
  </g>
</svg>
```

`brand/src/tile-square.svg` — identical but the rect has **no** `rx` (apple-touch, PWA maskable-safe, `icon-192/512`). Glyph cluster (~184×~210 in a 512 box) is already inside the central 80% safe zone.

- [ ] **Step 6: Implement `brand/generate.ts`**

```ts
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

const fontDir = process.env.SUBSHELL_BRAND_FONTS_DIR ?? path.join(homedir(), "fonts", "acherus");
const fontFile = path.join(fontDir, "Acherus-Grotesque-Thin.otf");
if (!existsSync(fontFile)) {
  console.error(
    `Licensed font not found: ${fontFile}\n` +
      "Place Acherus-Grotesque-Thin.otf there (or set SUBSHELL_BRAND_FONTS_DIR).\n" +
      "The font CANNOT be vendored into this repo — see the branding spec §2.",
  );
  process.exit(1);
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

function render(master: string, mode: Mode, size: number): Buffer {
  const svg = readFileSync(path.join(SRC_DIR, master), "utf8");
  const resvg = new Resvg(svg, {
    fitTo: { mode, value: size },
    font: {
      fontFiles: [fontFile],
      loadSystemFonts: false, // deterministic: only the licensed face exists here
      defaultFontFamily: "Acherus Grotesque Thin",
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
console.log("\nCommit the regenerated PNGs. Never hand-edit them; change brand/src/*.svg or the JOBS table and re-run.");

- [ ] **Step 7: Generate, then check determinism**

```bash
bun run brand:generate
cp -r apps/frontend/public/icons /tmp/icons-run1
bun run brand:generate
diff -r /tmp/icons-run1 apps/frontend/public/icons && echo DETERMINISTIC
```

Expected: 16 PNGs + 1 ICO written; `DETERMINISTIC`.

- [ ] **Step 8: Visual QA (this is the geometry fudge valve — do not skip)**

Open `docs/assets/subshell-wordmark@2x.png`, `apps/frontend/public/icons/icon-512.png` and `favicon-32.png` (Read the images). Check: slash gradient visible; "sub"/"shell" colors correct; dust sits off the tail of "shell" rising rightward; `/s` cluster optically centered (adjust tile x +/− px in tile masters if not); no fallback-font shapes (Acherus has a distinctive flat-topped lowercase; if it looks like Helvetica, the font family string didn't match — fix `font-family` to exactly `Acherus Grotesque Thin`). Re-run Step 7 after any master edit.

- [ ] **Step 9: brand/README.md**

```markdown
# Brand assets

`bun run brand:generate` rasterizes `src/*.svg` masters into the committed PNGs
(`apps/frontend/public/icons/`, `docs/assets/`). Requires the licensed font at
`~/fonts/acherus/Acherus-Grotesque-Thin.otf` (or `SUBSHELL_BRAND_FONTS_DIR`).

- The masters contain live `<text>` (family name only). **Never** commit the OTF,
  never ship it as a webfont, never produce outlined SVGs — license forbids it.
- Never hand-edit the PNGs; edit masters or the `JOBS` table and regenerate.
- Scale/step-down rules and exact colors: docs/superpowers/specs/2026-09-02-subshell-branding-design.md
```

- [ ] **Step 10: Run repo checks and commit**

```bash
bun run verify-types && bun run lint:check && bun test brand/__tests__/ico.test.ts
git add package.json bun.lock brand/ apps/frontend/public/icons docs/assets
git commit -m "feat(brand): identity pipeline — Acherus Thin masters, resvg generator, committed PNG set

Wordmark /subshell (gradient slash, two-tone word, dust tail) and /s tile mark
rasterized from brand/src; favicon.ico built in-script. Font stays out of the
repo per license; generator fail-fasts without SUBSHELL_BRAND_FONTS_DIR."
```

---

### Task 2: Wire the frontend; retire the diamond pipeline

**Files:**
- Modify: `apps/frontend/index.html:11-15` (head)
- Modify: `apps/frontend/src/components/app-sidebar.tsx` (brand block ~127-160)
- Modify: `apps/frontend/src/routes/login.tsx:69-71` (main wrapper)
- Delete: `apps/frontend/public/icons/subshell-source.svg`, `apps/frontend/public/icons/subshell-maskable.svg`, `apps/frontend/scripts/gen-icons.ts`
- Modify: `apps/frontend/package.json` (remove `gen:icons` script, remove now-unused `sharp` devDep **only if** nothing else imports it — check `rg -l "from \"sharp\"" apps/frontend`)

**Interfaces:**
- Consumes: Task 1's PNG filenames exactly.
- Produces: rendered `<img>` brand in sidebar/login; favicon links in HTML.

- [ ] **Step 1: index.html favicon block**

After the `<title>Subshell</title>` line, before the manifest link, insert:

```html
    <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
    <link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48.png" />
    <link rel="icon" href="/icons/favicon.ico" sizes="any" />
```

- [ ] **Step 2: Sidebar brand**

In `app-sidebar.tsx` replace the collapsed button content and the expanded Link (the `◆` occurrences — the only two in the app):

Collapsed button inner glyph →
```tsx
            <img
              src="/icons/mark-40.png"
              srcSet="/icons/mark-80.png 2x, /icons/mark-120.png 3x"
              alt=""
              className="h-6 w-auto"
            />
```
Expanded Link →
```tsx
            <Link to="/" className="flex items-center gap-2" aria-label="Subshell">
              <img
                src="/icons/wordmark-40.png"
                srcSet="/icons/wordmark-80.png 2x, /icons/wordmark-120.png 3x"
                alt="Subshell"
                className="h-5 w-auto"
              />
            </Link>
```
Keep the collapse chevron Button exactly as-is.

- [ ] **Step 3: Login hero**

In `login.tsx` change the `<main>` opening to a column and put the hero above the Card:

```tsx
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <img
        src="/icons/wordmark-96.png"
        srcSet="/icons/wordmark-192.png 2x"
        alt="Subshell"
        className="h-14 w-auto"
      />
      <Card className="w-full max-w-sm">
```

(The `</main>`/closing structure is unchanged; CardTitle text stays — `e2e/tests/02-auth-guard.spec.ts` asserts it.)

- [ ] **Step 4: Delete the old pipeline**

```bash
git rm apps/frontend/public/icons/subshell-source.svg apps/frontend/public/icons/subshell-maskable.svg apps/frontend/scripts/gen-icons.ts
```
Remove the `"gen:icons"` line from `apps/frontend/package.json`. Run `rg -l "from \"sharp\"" apps/frontend/scripts apps/frontend/src` — if empty, also remove the `sharp` devDependency line, then `bun install`.

- [ ] **Step 5: Verify + commit**

```bash
bun run verify-types && bun run lint:check && bun run test
```
Expected: all green. Then:
```bash
git add -A
git commit -m "feat(frontend): wire raster brand — favicon links, sidebar wordmark/mark, login hero

Replaces the diamond placeholder (◆) and the sharp gen-icons pipeline;
manifest keeps its existing icon filenames (refreshed contents)."
```

---

### Task 3: README banner + guard sweep + full verification

**Files:**
- Modify: `README.md:1` (image above H1)
- (verification only) `docs/superpowers/specs/2026-09-02-subshell-branding-design.md`

- [ ] **Step 1: README hero**

Above the `# Subshell` line insert:

```markdown
<div align="center">
  <img src="docs/assets/subshell-wordmark@2x.png" width="640" alt="Subshell" />
</div>

```

(On a `#0a0a0a` plate, so it survives GitHub's light theme.)

- [ ] **Step 2: License guard checks (spec §4.4)**

```bash
rg -l "Acherus" --glob '!docs/**' --glob '!brand/**' --glob '!bun.lock' && echo "FAIL: brand-font reference outside build inputs"
find apps/frontend/public -name "*.svg" | grep -i "subshell\|mark\|wordmark" && echo "FAIL: served brand SVG"
find . -path ./node_modules -prune -o -name "*.otf" -print -o -name "*.woff*" -print | grep . && echo "FAIL: font binary in repo"
```
Expected: all three print nothing (nonzero exit from grep is fine/success here — the FAIL lines must be absent).

- [ ] **Step 3: Manual visual pass (spec §4.3)**

Boot the dev server (`bun run dev`, http://localhost:5174 — NetBird-proxied hosts work too): browser tab shows the `/s` favicon at 100% and 200% zoom; collapsed rail shows the mark, expanded shows the wordmark; `/login` shows the hero; README renders on github.com (check light + dark theme) after push, or eyeball `docs/assets/*.png`.

- [ ] **Step 4: Final verification and commit**

```bash
bun run verify-types && bun run lint:check && bun run test
git add README.md
git commit -m "docs(readme): brand banner — wordmark plate above the H1"
```

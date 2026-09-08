# Subshell Branding — Logo, Favicon & Asset Pipeline

**Date:** 2026-09-02 · **Status:** approved design, pending implementation plan
**Scope:** favicon + PWA icons, in-app sidebar brand, login hero, README banner.
**Out of scope:** mobile app icon (Expo asset regeneration — follow-up), restyling the app's
Tailwind theme, adopting Acherus as a UI font (UI stays on the system stack).

## 1. The identity

Wordmark `/subshell` set in **Acherus Grotesque Light (weight 300)**, styled as a directory
path with a terminal "bitcrash" dust tail. Favicon/app mark is the derived glyph **`/s`**.

### 1.1 Color tokens

| Token | Hex | Role |
|---|---|---|
| `brand.bg` | `#0a0a0a` | Tile background (matches existing app ink) |
| `brand.slash.top` | `#744b8d` | Slash gradient start (top) |
| `brand.slash.mid` | `#a678bd` @ 62% | Slash gradient midpoint |
| `brand.slash.bottom` | `#d9c6e8` | Slash gradient end (baseline) |
| `brand.sub` | `#9c71ae` | "sub" — deep orchid |
| `brand.shell` | `#e6dbef` | "shell" — pale lavender |
| `brand.dust.orchid` | `#c39bd9` | Dust bits (primary) |
| `brand.dust.lavender` | `#e6dbef` | Dust bits |
| `brand.dust.plum` | `#9c71ae` | Dust bits |
| `brand.dust.deep` | `#744b8d` | Dust bits (final) |

These values are canonical for brand output only; changing the app's UI accent from
`#67c3ec` to the brand purple is **not** part of this spec — it landed one day later in
`2026-09-03-dreamframe-theme-design.md`.

Contrast on `#0a0a0a`: `shell` ≈ 14:1, `sub`/slash-mid ≈ 5.3:1, smallest dust bits are
decorative (exempt). All text-bearing elements clear WCAG AA for large text.

### 1.2 Wordmark anatomy

Single line, left to right: gradient slash, `sub` in `brand.sub`, `shell` in `brand.shell`,
dust tail off the final "ll".

- **Type:** Acherus Grotesque Light (300), letter-spacing ≈ `0.011em`, lowercase. (The lockup
  was first approved in Thin 100; the operator moved it to Light on 2026-09-03 because Thin
  read too weak beside the UI's label weights.)
- **Slash:** the font's own `/`, filled by a vertical `linearGradient`
  (`top→bottom`, stops per §1.1). No other element carries a gradient.
- **Dust:** six squares (≈ 2px corner rounding at 48px wordmark height) trailing off the
  final "ll" — drifting right along a gently rising line, alternating just above and just
  below it, shrinking as they go, so the tail fades from a solid 0.11em orchid bit to two
  0.03em specks (lavender, then deep plum last). Colors cycle orchid → lavender → plum →
  orchid → lavender → deep. The approved proportions carry over from the mock
  (`slash-gradient-v2` dust, em-relative offsets 0.20/0.39/0.57/0.74/0.96em rightward with
  ±0.04–0.30em vertical jitter); exact coordinates are drawn once in
  `brand/src/wordmark.svg` during implementation — that file is the geometry source of truth.

- **The dust is never dropped** (operator decision, 2026-09-02: it is part of the brand).
  Below the legibility floor the step-down is to the `/s` mark, not to a dustless wordmark;
  no dustless variant is produced at all.

### 1.3 Mark (favicon / app icon)

`/s` — gradient slash + `s` in `brand.shell`, on an `#0a0a0a` tile with ~22% corner radius.
**The mark never carries dust** — the dust tail belongs to the wordmark only (operator
decision, 2026-09-02). The mark follows the wordmark's weight — Light 300 since
2026-09-03 (originally Thin 100, revised as too weak beside the UI); the glyph fills ≈⅔ of
the tile and is centered optically (the slash leans left; ~1% right nudge). For maskable PWA and apple-touch variants the tile is
full-bleed square and the glyph is kept inside the central 80% safe zone.

### 1.4 Scale rules

| Rendered height | Lockup |
|---|---|
| ≥ 20px | Full wordmark — always with dust |
| < 20px | Mark `/s` only (tile or transparent) |
| Icons ≤ 32px | Mark only, rasterized at exact pixel sizes |

The dust at sidebar height (~20px) is a knowingly accepted tradeoff: rasterized hairline
strokes may shimmer on 1× displays — the operator chose brand completeness over crispness
(2026-09-02). Mitigations within the rules: sidebar renders at exactly a 2×-exported height
(40px PNG at 20 CSS px), and the dust coordinates are locked to the pixel grid at export
sizes. The mock's collapsed-rail diamond becomes the transparent mark at ~24px.

## 2. License constraint — rasterize, never embed

The font license we hold **prohibits embedding/distributing the font file**. Therefore:

1. **No font binaries in the repo** (OTF/WOFF/TTF), and **no webfont** is shipped or linked.
2. **No outlined-glyph SVGs are shipped either** — the raster-only reading is the conservative
   one; outlines are not produced as a workaround.
3. `brand/src/*.svg` masters contain **live `<text>` referencing the font family by name** —
   they carry no font data and are build inputs, never served. They live **outside**
   `public/`, so nothing text-based reaches a client.
4. **Every shipped brand artifact is a PNG** produced by the generator (§3). The licensed
   fonts stay on the operator's machine (default lookup `~/fonts/acherus/` (currently `Acherus-Grotesque-Light.otf`), overridable with
   `SUBSHELL_BRAND_FONTS_DIR`). Regeneration is a maintainer act; CI and consumers only ever
   see committed PNGs.
5. `apps/frontend/public/icons/` previously held served SVG brand files
   (`subshell-source.svg`, `subshell-maskable.svg`) — these are deleted; the pipeline outputs
   PNGs exclusively.

## 3. Generator script

`brand/generate.ts`, run as `bun run brand:generate` (root `package.json` script).

- **Renderer:** `@resvg/resvg-js` (devDependency, pinned). Deterministic rasterizer, proper
  `linearGradient` and text support; fonts supplied explicitly per-run via
  `fontFiles: [Acherus-Grotesque-Light.otf]` resolved from `SUBSHELL_BRAND_FONTS_DIR`.
- **Fail-fast:** if the font dir or the Light OTF is missing, exit non-zero with a clear
  message — never emit fallback-font PNGs.
- **Single source of truth for sizes:** a `SIZES` table in the script drives every output.

### 3.1 Outputs (into `apps/frontend/public/icons/`, plus the README plate into `docs/assets/`)

| File | Size (px) | Content |
|---|---|---|
| `favicon-16.png`, `favicon-32.png`, `favicon-48.png` | exact | Rounded `#0a0a0a` tile mark |
| `favicon.ico` | 16+32+48 embedded | Same mark, legacy browsers |
| `apple-touch-icon.png` | 180 | Full-bleed square tile mark, glyph in 80% safe zone |
| `icon-192.png` | 192 | Tile mark (manifest `any`) |
| `icon-512.png` | 512 | Tile mark (manifest `maskable`, 80% safe zone) |
| `wordmark-{40,80,120}.png` | @1/2/3 of 40 | Full lockup incl. dust, transparent bg |
| `wordmark-{96,192}.png` | @1/2 of 96 | Same lockup, login-hero scale |
| `mark-{40,80,120}.png` | @1/2/3 of 40 | Transparent-bg `/s`, no tile |
| `docs/assets/subshell-wordmark.png` (+ `-1280` @2x) | 640 wide | Full lockup on `#0a0a0a` plate, README |

`.ico` writing: a tiny hand-rolled ICO container (PNG-compressed entries) in the script —
no extra dependency.

### 3.2 Repo consumption points

- `apps/frontend/index.html`: add `<link rel="icon" href="/icons/favicon-32.png" sizes="32x32">`
  (plus 16/48 lines) — there is currently **no favicon link at all**.
- `apps/frontend/public/manifest.webmanifest`: unchanged structure (same filenames/purposes);
  icons are refreshed contents.
- `app-sidebar.tsx`: expanded brand → `<img src="/icons/wordmark-40.png"
  srcSet="/icons/wordmark-80.png 2x, /icons/wordmark-120.png 3x"
  alt="Subshell" class="h-5">`; collapsed rail → `mark-40` with the same srcSet pattern
  (replaces the `◆` character, the only one in the app).
- `routes/login.tsx`: hero wordmark `wordmark-96` + `wordmark-192` @2x, `alt="Subshell"`.
- `README.md`: full lockup on a `#0a0a0a` plate (`docs/assets/subshell-wordmark.png`,
  640px @2x 1280px, emitted by the same script with a `--readme` output group) above the H1.
- Tests/e2e that assert on the `◆`/text brand string get updated to the new `alt`/img.

## 4. Verification

1. `bun run brand:generate` twice → byte-identical outputs (determinism check).
2. `bun run verify-types && bun run lint:check && bun run test`.
3. Manual visual pass: browser tab at 100% and 200% zoom, collapsed + expanded sidebar,
   login page, README render on GitHub (light *and* dark theme), PWA install → home-screen
   icon (maskable safe zone).
4. Confirm no font binaries and no served SVGs remain: `rg -l "Acherus" --glob
   '!docs/**' --glob '!brand/**'` is empty; `public/` contains only PNGs for brand files.

## 5. Do / Don't (future contributors)

- **Don't** commit font files, webfont builds, or outlined logo SVGs (license).
- **Don't** hand-edit PNGs; change a master SVG or the `SIZES` table and regenerate.
- **Don't** recolor, stretch, rotate, add shadows, or reflow the wordmark; new sizes go
  through `SIZES`.
- **Don't** drop the dust or stretch the wordmark — below 20px use the `/s` mark, per the
  step-down table.
- **Do** treat §1.1 as the brand palette source of truth if/when the UI accent moves to purple.

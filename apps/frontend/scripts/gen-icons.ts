import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/** Rasterizes the committed SVG sources to the PWA icon set. Run manually
 * after changing the art: `bun run gen:icons` (apps/frontend). The PNGs are
 * committed so builds never need sharp. */
const out = new URL("../public/icons/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

await sharp(join(out, "mote-source.svg")).resize(192, 192).png().toFile(join(out, "icon-192.png"));
await sharp(join(out, "mote-maskable.svg")).resize(512, 512).png().toFile(join(out, "icon-512.png"));
await sharp(join(out, "mote-source.svg")).resize(180, 180).png().toFile(join(out, "apple-touch-icon.png"));
console.log("icons written to", out);

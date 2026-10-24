import type { Locator, Page } from "@playwright/test";

/** Keep real UI surfaces, with one page-colored margin and no unrelated modal backdrop. */
export async function captureScreenshot(
  page: Page,
  file: string,
  first: Locator,
  last = first,
  contentHeight?: number,
) {
  await first.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  // Let opening and scrolling transitions settle before measuring the crop.
  await page.waitForTimeout(250);
  const a = await first.boundingBox();
  const b = await last.boundingBox();
  if (!a || !b) throw new Error(`Missing screenshot bounds: ${file}`);
  const lastElement = await last.elementHandle();
  await first.evaluate((element, end) => {
    let surface = element;
    while (end && !surface.contains(end) && surface.parentElement) surface = surface.parentElement;
    surface.setAttribute("data-docs-capture", "");
  }, lastElement);
  const margin = 12;
  const x = Math.max(0, Math.floor(Math.min(a.x, b.x) - margin));
  const y = Math.max(0, Math.floor(Math.min(a.y, b.y) - margin));
  const width = Math.ceil(Math.max(a.x + a.width, b.x + b.width) - x + margin);
  const height = contentHeight
    ? contentHeight + 2 * margin
    : Math.ceil(Math.max(a.y + a.height, b.y + b.height) - y + margin);
  let pixels: { width: number; height: number } | undefined;
  try {
    const png = await page.screenshot({
      path: file,
      clip: { x, y, width, height },
      animations: "disabled",
      scale: "device",
      // This only isolates the photographed surface; its controls and content
      // are untouched. Every capture retains the application's page background.
      style: `body *:not([data-docs-capture]):not([data-docs-capture] *):not(:has([data-docs-capture])) { visibility: hidden !important; }
        ${contentHeight ? `[data-docs-capture] { clip-path: inset(0 0 calc(100% - ${contentHeight}px) 0); }` : ""}`,
    });
    // Chromium clips captures at viewport edges. Report the bytes actually
    // written, rather than dimensions that include an out-of-viewport margin.
    pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  } finally {
    await page.locator("[data-docs-capture]").evaluateAll((elements) => {
      for (const element of elements) element.removeAttribute("data-docs-capture");
    });
    await lastElement?.dispose();
  }
  const scale = await page.evaluate(() => window.devicePixelRatio);
  if (!pixels) throw new Error(`Screenshot produced no image: ${file}`);
  console.log(
    `${file}: ${pixels.width} x ${pixels.height} pixels (${pixels.width / scale} x ${pixels.height / scale} CSS)`,
  );
  return pixels;
}

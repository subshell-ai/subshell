import { describe, expect, it } from "bun:test";
import { needsStandaloneDragStrip } from "@/components/desktop/drag-strip";

/**
 * The desktop shell drops the native title bar on EVERY route (`shell_ready`
 * in `windows.rs` says so, naming /login and /setup). Whatever replaces it has
 * to be there on every route too — the rail's strip where there is a rail, a
 * standalone one where there is not.
 *
 * It was not: the strip lived only inside `DesktopSidebar`, and /login and
 * /setup render no sidebar, so the first window a person ever sees could not
 * be dragged by its top edge.
 */
describe("the window always has exactly one drag surface", () => {
  /** What `__root.tsx` uses to decide whether to render the rail. */
  const railRenders = (hasSidebar: boolean, bare: boolean) => hasSidebar && !bare;

  it("is the rail's complement — never both, never neither", () => {
    for (const hasSidebar of [true, false]) {
      for (const bare of [true, false]) {
        const surfaces = [railRenders(hasSidebar, bare), needsStandaloneDragStrip(hasSidebar, bare)].filter(Boolean);
        expect(surfaces.length, `hasSidebar=${hasSidebar} bare=${bare}`).toBe(1);
      }
    }
  });

  it("covers the two routes that had none: /login and /setup", () => {
    // `bare` is exactly those two, and a wide window still reports a sidebar
    // it is not allowed to render there — which is how the gap arose.
    expect(needsStandaloneDragStrip(true, true)).toBe(true);
  });

  it("stays out of the way where the rail carries it", () => {
    expect(needsStandaloneDragStrip(true, false)).toBe(false);
  });

  it("covers a window too narrow for a rail", () => {
    // Below SIDEBAR_MIN_WIDTH the rail gives way to MobileTopBar, which is not
    // a drag surface either.
    expect(needsStandaloneDragStrip(false, false)).toBe(true);
  });
});

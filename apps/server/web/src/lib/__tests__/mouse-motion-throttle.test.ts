import { describe, expect, it } from "bun:test";
import { createMotionThrottle, isMotionReport } from "@/lib/mouse-motion-throttle";

const ESC = "\x1b";
const report = (button: number, col = 10, row = 5, final = "M") => `${ESC}[<${button};${col};${row}${final}`;

describe("isMotionReport", () => {
  it("recognises drag and bare movement, which carry the motion bit", () => {
    expect(isMotionReport(report(32))).toBe(true); // drag with button 0
    expect(isMotionReport(report(35))).toBe(true); // movement, no button (mode 1003)
  });

  it("never claims a press, a release or a wheel notch", () => {
    expect(isMotionReport(report(0))).toBe(false); // press
    expect(isMotionReport(report(0, 10, 5, "m"))).toBe(false); // release
    expect(isMotionReport(report(64))).toBe(false); // wheel up
    expect(isMotionReport(report(65))).toBe(false); // wheel down
  });

  it("never claims a keystroke, or a chunk carrying more than the report", () => {
    expect(isMotionReport("a")).toBe(false);
    expect(isMotionReport("\r")).toBe(false);
    expect(isMotionReport(`${report(35)}x`)).toBe(false);
    expect(isMotionReport(`x${report(35)}`)).toBe(false);
  });
});

describe("createMotionThrottle", () => {
  const collect = () => {
    const sent: string[] = [];
    return { sent, send: (d: string) => sent.push(d) };
  };

  it("collapses a burst of motion into ONE send, carrying the latest position", async () => {
    const { sent, send } = collect();
    const t = createMotionThrottle(send, 20);
    for (let col = 1; col <= 25; col++) t.push(report(35, col));
    expect(sent).toEqual([]); // nothing yet — sampled, not forwarded
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toEqual([report(35, 25)]); // the position actually reached
    t.dispose();
  });

  it("forwards a keystroke IMMEDIATELY, and never after the motion it followed", () => {
    const { sent, send } = collect();
    const t = createMotionThrottle(send, 1000);
    t.push(report(35, 7));
    t.push("a");
    // The pending motion goes first, then the keystroke — order preserved, and
    // the keystroke waited for nothing.
    expect(sent).toEqual([report(35, 7), "a"]);
    t.dispose();
  });

  it("never delays a press, a release or a wheel notch", () => {
    const { sent, send } = collect();
    const t = createMotionThrottle(send, 1000);
    t.push(report(0));
    t.push(report(0, 10, 5, "m"));
    t.push(report(64));
    expect(sent).toEqual([report(0), report(0, 10, 5, "m"), report(64)]);
    t.dispose();
  });

  it("sends the last motion on dispose rather than dropping it", () => {
    const { sent, send } = collect();
    const t = createMotionThrottle(send, 1000);
    t.push(report(35, 3));
    expect(sent).toEqual([]);
    t.dispose();
    expect(sent).toEqual([report(35, 3)]);
  });

  it("samples steadily rather than postponing forever while the pointer keeps moving", async () => {
    const { sent, send } = collect();
    const t = createMotionThrottle(send, 15);
    for (let i = 0; i < 6; i++) {
      t.push(report(35, i + 1));
      await new Promise((r) => setTimeout(r, 10));
    }
    // A trailing-edge debounce would have sent nothing at all by now.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    t.dispose();
  });
});

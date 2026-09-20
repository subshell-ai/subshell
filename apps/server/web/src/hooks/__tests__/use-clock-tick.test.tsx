import { describe, expect, it } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useClockTick } from "@/hooks/use-clock-tick";

describe("useClockTick", () => {
  it("re-renders the caller on the interval, and stops on unmount", async () => {
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      useClockTick(10);
    });
    await waitFor(() => expect(renders).toBeGreaterThanOrEqual(3), { timeout: 1000 });
    const at = renders;
    unmount();
    await new Promise((r) => setTimeout(r, 50));
    expect(renders).toBe(at);
  });
});

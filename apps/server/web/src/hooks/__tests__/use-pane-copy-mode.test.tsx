import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { paneCopyModeIds, resetPaneCopyModePrefForTests, setPaneCopyModeIds } from "@/lib/pane-copy-mode-pref";
import { usePaneCopyMode } from "../use-pane-copy-mode";

afterEach(() => {
  cleanup();
  setPaneCopyModeIds([]);
  // A refused write in one test would otherwise answer for the next file that
  // reads this module in the same worker.
  resetPaneCopyModePrefForTests();
});

test("the shared toggle persists each mode and confirms both transitions", () => {
  setPaneCopyModeIds(["other"]);
  const confirmation = spyOn(toast, "success").mockImplementation(() => "toast");
  try {
    const { result } = renderHook(() => usePaneCopyMode("pane"));
    act(() => result.current.onToggle());
    expect(result.current.on).toBe(true);
    expect(paneCopyModeIds()).toEqual(["other", "pane"]);
    expect(confirmation).toHaveBeenLastCalledWith("Text copying enabled");
    act(() => result.current.onToggle());
    expect(result.current.on).toBe(false);
    expect(paneCopyModeIds()).toEqual(["other"]);
    expect(confirmation).toHaveBeenLastCalledWith("Text input enabled");
    expect(confirmation).toHaveBeenCalledTimes(2);
  } finally {
    confirmation.mockRestore();
  }
});

test("two presses in one batch report what the store ended up holding", () => {
  // The menu and the touch bar both mount for one pane. Pressed in the same
  // batch, the second handler still holds the `on` the first press replaced, so
  // deciding the confirmation from that value tells the person "Text copying
  // enabled" about a mode that has just been switched off - and the button and
  // the toast then disagree with each other about the same pane.
  setPaneCopyModeIds([]);
  const confirmation = spyOn(toast, "success").mockImplementation(() => "toast");
  try {
    const { result: menu } = renderHook(() => usePaneCopyMode("pane"));
    const { result: bar } = renderHook(() => usePaneCopyMode("pane"));
    act(() => {
      menu.current.onToggle();
      bar.current.onToggle();
    });
    expect(paneCopyModeIds()).toEqual([]); // added, then removed
    expect(bar.current.on).toBe(false);
    expect(confirmation).toHaveBeenLastCalledWith("Text input enabled");
  } finally {
    confirmation.mockRestore();
  }
});

test("loads the persisted mode on navigation without displaying a swap toast", () => {
  setPaneCopyModeIds(["copy-pane"]);
  const confirmation = spyOn(toast, "success").mockImplementation(() => "toast");
  try {
    const { result, rerender } = renderHook(({ id }) => usePaneCopyMode(id), { initialProps: { id: "copy-pane" } });
    expect(result.current.on).toBe(true);
    rerender({ id: "input-pane" });
    expect(result.current.on).toBe(false);
    expect(confirmation).not.toHaveBeenCalled();
  } finally {
    confirmation.mockRestore();
  }
});

test("separate views of the same subshell synchronize mode changes", () => {
  const first = renderHook(() => usePaneCopyMode("shared"));
  const second = renderHook(() => usePaneCopyMode("shared"));
  act(() => first.result.current.onToggle());
  expect(second.result.current.on).toBe(true);
  act(() => second.result.current.onToggle());
  expect(first.result.current.on).toBe(false);
});

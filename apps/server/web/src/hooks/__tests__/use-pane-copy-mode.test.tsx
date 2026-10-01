import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { paneCopyModeIds, setPaneCopyModeIds } from "@/lib/pane-copy-mode-pref";
import { usePaneCopyMode } from "../use-pane-copy-mode";

afterEach(() => {
  cleanup();
  setPaneCopyModeIds([]);
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

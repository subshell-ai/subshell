import { afterEach, expect, it } from "bun:test";
import type { ViewersState } from "@internal/subshell-protocol";
import { cleanup, renderHook } from "@testing-library/react";
import { usePaneDevices, usePublishPaneDevices } from "../use-pane-devices";

afterEach(cleanup);
const state: ViewersState = { you: "me", viewers: [], sizing: { mode: "auto", pinnedViewerId: null } };

it("routes sizing to the focused pane and clears disconnected or unmounted presence", () => {
  const calls: string[] = [];
  const first = (mode: string) => {
    calls.push(`first:${mode}`);
  };
  const second = (mode: string) => {
    calls.push(`second:${mode}`);
  };
  const publisher = renderHook(
    ({ connected }) => {
      usePublishPaneDevices("first", connected ? state : null, first);
      usePublishPaneDevices("second", state, second);
    },
    { initialProps: { connected: true } },
  );
  const header = renderHook(({ id }) => usePaneDevices(id), { initialProps: { id: "first" } });
  header.result.current?.onSizing("auto");
  header.rerender({ id: "second" });
  header.result.current?.onSizing("pinned", "me");
  expect(calls).toEqual(["first:auto", "second:pinned"]);
  publisher.rerender({ connected: false });
  header.rerender({ id: "first" });
  expect(header.result.current).toBeNull();
  header.rerender({ id: "second" });
  expect(header.result.current?.state).toBe(state);
  publisher.unmount();
  expect(header.result.current).toBeNull();
});

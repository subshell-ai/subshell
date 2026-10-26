import { afterEach, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { setFetchRouter } from "@/test-setup";
import { useHarnessSubagents } from "../use-harness-subagents";

// The fetch router is a PROCESS global (see harness-subagents.test.tsx): clear
// it, and the mounted watchers, or this file's snapshot answers a later file.
afterEach(() => {
  setFetchRouter(null);
  cleanup();
});

function Probe({ id, enabled }: { id: string; enabled: boolean }) {
  const { data } = useHarnessSubagents(id, enabled);
  return <span>{data ? "ready" : "waiting"}</span>;
}

test("one batch fetch per tick serves every watching row, and hidden tabs stop watching", async () => {
  let gets = 0;
  setFetchRouter(async (url) => {
    if (String(url).endsWith("/api/subshells/subagents")) gets += 1;
    return Response.json({});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const show = (state: string) =>
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  // Drive only interval ticks. Fetch promises and React Query notifications
  // still run normally; waiting through production polling adds no coverage.
  const schedule = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: TimerHandler,
    _delay?: number,
    ...args: unknown[]
  ) => {
    if (typeof callback !== "function") throw new Error("Expected an interval callback");
    const timer = realSetInterval(() => {}, 86_400_000);
    callbacks.set(timer, () => callback(...args));
    return timer;
  }) as unknown as typeof setInterval);
  const cancel = spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
    if (timer !== undefined) callbacks.delete(timer as ReturnType<typeof setInterval>);
    realClearInterval(timer);
  });
  const settled = () =>
    act(async () => {
      await Promise.all(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.promise),
      );
    });
  const tick = async () => {
    await act(async () => {
      for (const callback of [...callbacks.values()]) callback();
    });
    await settled();
  };
  try {
    show("visible");
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <Probe id="a" enabled />
        <Probe id="b" enabled />
        <Probe id="c" enabled />
        <Probe id="dead" enabled={false} />
      </QueryClientProvider>,
    );
    await settled();
    expect(gets).toBe(1);
    expect(callbacks.size).toBe(1);
    await tick();
    await tick();
    expect(gets).toBe(3);

    show("hidden");
    await tick();
    await tick();
    expect(gets).toBe(3);
    show("visible");
    await tick();
    expect(gets).toBe(4);

    // An inactive observer must not keep the shared ticker alive.
    rerender(
      <QueryClientProvider client={client}>
        <Probe id="dead" enabled={false} />
      </QueryClientProvider>,
    );
    expect(callbacks.size).toBe(0);
    await tick();
    expect(gets).toBe(4);
  } finally {
    cleanup();
    for (const timer of callbacks.keys()) realClearInterval(timer);
    cancel.mockRestore();
    schedule.mockRestore();
    client.clear();
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

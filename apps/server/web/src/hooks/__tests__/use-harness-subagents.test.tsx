import { afterEach, expect, test } from "bun:test";
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

/**
 * The budget here rides the REAL poll interval (2 s), not faked timers: each
 * two-settle window straddles exactly the ticks that should fire, with 600 ms
 * of slack per side. `bun test`'s 5 s default is outgrown on purpose.
 */
test("one batch fetch per tick serves every watching row, and hidden tabs stop watching", async () => {
  let gets = 0;
  setFetchRouter(async (url) => {
    if (String(url).endsWith("/api/subshells/subagents")) gets += 1;
    return Response.json({});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Probe id="a" enabled />
      <Probe id="b" enabled />
      <Probe id="c" enabled />
      <Probe id="dead" enabled={false} />
    </QueryClientProvider>,
  );
  // The window sleeps inside `act`, so refetch-driven observer notifications
  // land in a wrapped flush instead of the "not wrapped in act" warning, and
  // a rejection surfaces at its await rather than as an unhandled error.
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 2600)));
  // The mount fetch plus the two ticks inside the window: three active
  // observers collapsed to one request each, and the inactive row
  // registered nothing extra.
  await settle();
  await settle();
  expect(gets, `gets=${gets}`).toBe(3);
  // A backgrounded tab pauses the ticker, which is the whole point of the
  // shared interval being ours rather than TanStack's per-observer
  // `refetchInterval`.
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  await settle();
  await settle();
  expect(gets, `gets=${gets}`).toBe(3);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  await settle();
  expect(gets, `gets=${gets}`).toBe(4);
  await act(async () => cleanup());
  await settle();
  // With no watchers left the interval is gone, not merely skipped.
  expect(gets, `gets=${gets}`).toBe(4);
  client.clear();
}, 30_000);

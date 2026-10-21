import { expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useSubshellDrop } from "@/hooks/use-subshell-drop";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import { SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";

it("rejects helper drops using the latest cache while allowing parent rows", () => {
  const client = new QueryClient();
  const { result, unmount } = renderHook(() => useSubshellDrop(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const transfer = (id: string) => ({ types: [SUBSHELL_DND_TYPE], getData: () => id });
  client.setQueryData(SUBSHELLS_QUERY_KEY, [{ id: "parent" }, { id: "helper", crossAgent: true }]);
  expect(result.current(transfer("parent"))).toBe("parent");
  expect(result.current(transfer("helper"))).toBeNull();
  expect(result.current({ types: ["Files"], getData: () => "parent" })).toBeNull();
  unmount();
  client.clear();
});

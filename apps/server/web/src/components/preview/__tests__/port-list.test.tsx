import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import { PortList } from "../port-list";

afterEach(cleanup);
it("finds a specific port in a large list and keeps display choices reachable", () => {
  const ports = Array.from({ length: 25 }, (_, index) => ({ port: 10025 - index, proto: "tcp" as const, pid: 1 }));
  const info: PreviewInfo = {
    nodeEnabled: true,
    ports: [...ports, { ...ports[0], proto: "tcp6" }],
    cdpPort: null,
    screen: { display: ":90", rfbPort: 5910 },
  };
  const opened: number[] = [];
  let screens = 0;
  render(
    <PortList
      compact
      info={info}
      access="owner"
      watching={false}
      onOpen={(port) => opened.push(port)}
      onWatch={() => {}}
      onScreen={() => {
        screens += 1;
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("25 web previews");
  expect(screen.getAllByRole("button", { name: /^Open web preview/ })[0].getAttribute("aria-label")).toBe(
    "Open web preview on port 10001",
  );
  fireEvent.click(screen.getByRole("button", { name: "View screen" }));
  expect(screens).toBe(1);
  const search = screen.getByRole("searchbox", { name: "Find a web preview or screen" });
  fireEvent.change(search, { target: { value: "10021" } });
  expect(screen.getAllByRole("button", { name: /^Open web preview/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open web preview on port 10021" }));
  expect(opened).toEqual([10021]);
  fireEvent.change(search, { target: { value: "missing" } });
  expect(screen.getByText("No matching web previews or screens.")).toBeTruthy();
  fireEvent.change(search, { target: { value: "screen" } });
  expect(screen.getByRole("button", { name: "View screen" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getAllByRole("button", { name: /^Open web preview/ })).toHaveLength(25);
});

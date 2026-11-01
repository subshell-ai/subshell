import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpCard } from "@/components/mcp-card";

/**
 * The account-wide MCP switch. Same one-boolean read/write cycle as the
 * notifications master card it clones, but the two default-on fallbacks are
 * its OWN: this switch's safe state is ON, because wiring predates it, so a
 * probe that fails must not answer "off" (that would silently strip tools
 * from panes nobody opted out of). These cells pin that polarity, the inert
 * unknown state, and the write-failure rollback.
 */

const switch_ = () => screen.getByRole("switch", { name: "Wire the subshell MCP into my panes" });

afterEach(() => cleanup());

describe("McpCard", () => {
  it("is inert and labelled Unknown until the server has answered", async () => {
    let resolve: (on: boolean) => void = () => {};
    render(<McpCard getEnabled={() => new Promise<boolean>((r) => (resolve = r))} setEnabled={async (on) => on} />);
    expect(screen.getByText("Unknown")).toBeDefined();
    expect(switch_().hasAttribute("data-disabled")).toBe(true);
    resolve(true);
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("On")).toBeDefined();
  });

  it("clicking an on switch writes false and the server echo lands 'Off'", async () => {
    const writes: boolean[] = [];
    render(
      <McpCard
        getEnabled={async () => true}
        setEnabled={async (on) => {
          writes.push(on);
          return on;
        }}
      />,
    );
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(switch_());
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("false"));
    expect(writes).toEqual([false]);
    expect(screen.getByText("Off")).toBeDefined();
  });

  it("a failing probe falls back to the safe default: on", async () => {
    render(
      <McpCard
        getEnabled={async () => {
          throw new Error("offline");
        }}
        setEnabled={async (on) => on}
      />,
    );
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
  });

  it("a failing write rolls the switch back and shows an alert", async () => {
    render(
      <McpCard
        getEnabled={async () => true}
        setEnabled={async () => {
          throw new Error("API 500: boom");
        }}
      />,
    );
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(switch_());
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});

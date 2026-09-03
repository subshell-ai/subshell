import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotificationsMasterCard } from "@/components/notifications-master-card";

/**
 * The account-wide master switch (spec 2026-08-31). It is a read/write cycle
 * over one boolean, so the tests pin the states the switch can show and the
 * two failure paths (probe fails → default on; write fails → roll back + alert).
 * The lib hooks come in through props, so no fetch stubbing is needed here.
 */

const switch_ = () => screen.getByRole("switch", { name: "Receive subshell notifications" });

afterEach(() => cleanup());

describe("NotificationsMasterCard", () => {
  it("renders the switch 'on' from a reported true and labels it On", async () => {
    render(<NotificationsMasterCard getEnabled={async () => true} setEnabled={async (on) => on} />);
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText("On")).toBeDefined();
  });

  it("clicking an on switch writes false and the server echo lands 'Off'", async () => {
    const writes: boolean[] = [];
    render(
      <NotificationsMasterCard
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
      <NotificationsMasterCard
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
      <NotificationsMasterCard
        getEnabled={async () => true}
        setEnabled={async () => {
          throw new Error("API 500: boom");
        }}
      />,
    );
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(switch_());
    // Optimistically flips off, then the rejection restores it to on.
    await waitFor(() => expect(switch_().getAttribute("aria-checked")).toBe("true"));
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});

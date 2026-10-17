import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeviceNameCard } from "@/components/device-name-card";
import { DEVICE_NAME_KEY, deviceName } from "@/lib/device-name";

describe("DeviceNameCard", () => {
  beforeEach(() => window.localStorage.removeItem(DEVICE_NAME_KEY));
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(DEVICE_NAME_KEY);
  });

  it("stores a chosen name so later attachments carry it", () => {
    // The default derives from the User-Agent, so two windows on one machine
    // read identically — which makes the Devices list, and the pin beside it,
    // meaningless exactly when someone has two differently-sized windows open.
    render(<DeviceNameCard />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kitchen iPad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(deviceName()).toBe("Kitchen iPad");
  });

  it("saves on Enter as well as the button", () => {
    render(<DeviceNameCard />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Desk" } });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    expect(deviceName()).toBe("Desk");
  });

  it("treats a blank as restoring the default, not as storing an empty label", () => {
    window.localStorage.setItem(DEVICE_NAME_KEY, "Old name");
    render(<DeviceNameCard />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(window.localStorage.getItem(DEVICE_NAME_KEY)).toBeNull();
    expect(deviceName()).toBeTruthy(); // the derived one
  });

  it("shows what others will actually see, normalization included", () => {
    render(<DeviceNameCard />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Two   spaces  " } });
    expect(screen.getByText("Two spaces")).toBeDefined();
  });

  it("starts from the name already stored on this device", () => {
    window.localStorage.setItem(DEVICE_NAME_KEY, "Laptop");
    render(<DeviceNameCard />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Laptop");
  });

  it("disables Save when the field still holds the stored name", () => {
    // The unchanged-draft rule: the button is dead at rest, lights for a real
    // edit, and goes dead again when the edit is put back — a keypress is not
    // a change. The stored-name path also proves the compare is against what
    // was saved, not against a blank.
    window.localStorage.setItem(DEVICE_NAME_KEY, "Laptop");
    render(<DeviceNameCard />);
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(save().getAttribute("aria-description")).toBe("No device name changes to save.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kitchen display" } });
    expect(save().matches(":disabled, [aria-disabled=true]")).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Laptop" } });
    expect(save().matches(":disabled, [aria-disabled=true]")).toBe(true);
  });
});

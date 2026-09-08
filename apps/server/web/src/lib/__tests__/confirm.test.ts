import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type ConfirmOptions, confirmAction, setConfirmHandler } from "../confirm";

describe("confirmAction", () => {
  afterEach(() => setConfirmHandler(null));

  it("resolves false and warns when no provider is mounted", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(await confirmAction({ title: "Do it?" })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("passes the options through to the registered handler", async () => {
    // An array, not a let-bound variable: TS flow-narrowing loses assignments
    // made from inside a callback.
    const seen: ConfirmOptions[] = [];
    setConfirmHandler((options) => {
      seen.push(options);
      return Promise.resolve(true);
    });
    const options: ConfirmOptions = { title: "Delete?", description: "forever", danger: true };
    expect(await confirmAction(options)).toBe(true);
    expect(seen).toEqual([options]);
  });

  it("hands back the previous handler so an unmount can restore it", () => {
    const first = () => Promise.resolve(true);
    const second = () => Promise.resolve(false);
    setConfirmHandler(first);
    expect(setConfirmHandler(second)).toBe(first);
  });
});

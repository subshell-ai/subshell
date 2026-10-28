import { beforeEach, expect, spyOn, test } from "bun:test";
import "../main";
import { EMPTY_STATE, type PanelMessage } from "../state";

const messages: PanelMessage[] = [];
beforeEach(() => {
  window.webkit = { messageHandlers: { subshell: { postMessage: (message) => messages.push(message) } } };
  messages.length = 0;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  window.subshellSetState?.(EMPTY_STATE);
});
function press(label: string) {
  const button = [...document.querySelectorAll("button")].find((el) => el.textContent === label);
  if (!button) throw new Error(`No button: ${label}`);
  button.click();
}
test("state pushes preserve quit confirmation focus and update its consequences", async () => {
  press("Quit helper");
  await Promise.resolve();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Cancel");
  const confirm = dialog?.querySelectorAll("button")[1];
  confirm?.focus();
  window.subshellSetState?.({ ...EMPTY_STATE, enabled: true, viewers: 1 });
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(document.activeElement).toBe(confirm ?? null);
  expect(dialog?.textContent).toContain("stops capture and input");
  confirm?.click();
  expect(messages).toContainEqual({ action: "quit" });
});
test("Tab stays inside the confirmation and Escape dismisses it", async () => {
  press("Quit helper");
  await Promise.resolve();
  const scrim = document.querySelector(".scrim");
  scrim?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  expect(document.activeElement?.textContent).toBe("Quit helper");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("hiding and reopening settings discards its transient quit confirmation", () => {
  press("Quit helper");
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.subshellSetState?.(EMPTY_STATE);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("each render sends finite document dimensions to the native bridge", () => {
  const resize = messages.find((message) => message.action === "resize");
  expect(resize?.action).toBe("resize");
  if (resize?.action === "resize") {
    expect(Number.isFinite(resize.width)).toBe(true);
    expect(Number.isFinite(resize.height)).toBe(true);
  }
});

test("native reactivation clears the dialog even without a state change", () => {
  press("Quit helper");
  window.subshellPanelShown?.();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("non-finite layout dimensions are replaced before crossing the bridge", () => {
  const layout = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: Number.NaN,
    height: Number.NaN,
  } as DOMRect);
  try {
    messages.length = 0;
    window.subshellSetState?.(EMPTY_STATE);
    expect(messages).toContainEqual({ action: "resize", width: 0, height: 0 });
  } finally {
    layout.mockRestore();
  }
});

test("Confirm dismisses the quit dialog even without a native bridge", () => {
  press("Quit helper");
  window.webkit = undefined;
  document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')[1]?.click();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

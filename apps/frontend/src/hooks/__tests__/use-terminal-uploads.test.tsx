import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useTerminalUploads } from "@/hooks/use-terminal-uploads";

/**
 * openImagePicker is the touch stand-in for drag-and-drop/paste: it must open
 * an images-only file picker and feed the picks through the SAME upload
 * function the desktop gestures use. The picker element itself is disposable,
 * so the assertions spy on what gets built and clicked.
 */
describe("useTerminalUploads.openImagePicker", () => {
  afterEach(() => {
    cleanup();
  });

  it("builds an image-only multi-select picker and clicks it", () => {
    const created: HTMLInputElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useTerminalUploads({
        sessionId: "s1",
        wsRef: { current: null },
        termRef: { current: null },
      }),
    );
    result.current.openImagePicker();

    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("file");
    expect(created[0].accept).toBe("image/*");
    expect(created[0].multiple).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    createSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("routes picked files through the shared upload path", () => {
    const actual = require("@/lib/session-uploads");
    const uploadSpy = mock(() => Promise.resolve("/tmp/pic.png"));
    mock.module("@/lib/session-uploads", () => ({ ...actual, uploadSessionFile: uploadSpy }));
    const realCreate = document.createElement.bind(document);
    let input: HTMLInputElement | null = null;
    const createSpy = spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "input") input = el as HTMLInputElement;
      return el;
    });
    const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useTerminalUploads({ sessionId: "s1", wsRef: { current: null }, termRef: { current: null } }),
    );
    result.current.openImagePicker();

    // `input` is assigned inside the createElement closure, which TS control
    // flow cannot see — snapshot it through its declared type instead.
    const picked = input as HTMLInputElement | null;
    if (!picked) throw new Error("openImagePicker never built an input");
    const file = new File(["x"], "pic.png", { type: "image/png" });
    Object.defineProperty(picked, "files", { value: [file] });
    picked.dispatchEvent(new Event("change"));

    expect(uploadSpy).toHaveBeenCalledWith("s1", file);

    createSpy.mockRestore();
    clickSpy.mockRestore();
    mock.module("@/lib/session-uploads", () => actual);
  });
});

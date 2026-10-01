import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ProductDemo } from "../product-demo";

afterEach(cleanup);

test("loads and plays a visible clip automatically, pauses offscreen, and allows manual pause", async () => {
  let visibility: IntersectionObserverCallback = () => {};
  const originalObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) {
      visibility = callback;
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  const motion = spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  const load = spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const play = spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
  });
  const pause = spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  try {
    const { container, getByRole } = render(
      <ProductDemo name="desktop" width={1280} height={800} label="Demo" webm={false} />,
    );
    expect(container.querySelector("source")).toBeNull();
    await act(async () =>
      visibility([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector("source")?.getAttribute("src")).toBe("/demos/desktop.mp4");
    fireEvent.click(getByRole("button"));
    expect(container.querySelector("video")?.autoplay).toBe(false);
    expect(pause).toHaveBeenCalled();
    // The browser emits pause when playback stops.
    fireEvent.pause(getByRole("button").querySelector("video") as HTMLVideoElement);
    fireEvent.click(getByRole("button"));
    await act(async () =>
      visibility([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    expect(container.querySelector("video")?.autoplay).toBe(false);
  } finally {
    cleanup();
    globalThis.IntersectionObserver = originalObserver;
    motion.mockRestore();
    load.mockRestore();
    play.mockRestore();
    pause.mockRestore();
  }
});

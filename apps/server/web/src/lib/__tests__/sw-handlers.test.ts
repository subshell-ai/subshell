import { describe, expect, it } from "bun:test";

/**
 * The service worker's decision logic lives in `public/sw-handlers.js`, a
 * plain <script> (no modules — classic SW runtimes have no import graph to
 * lean on). These tests load that file's text and eval it against a fake
 * `self`, which is exactly how the real worker will see it after
 * `importScripts`.
 */

type SwHandlers = {
  shouldShow: (data: { url?: string }, focusedClientUrl: string | null) => boolean;
  noteOptions: (data: Record<string, unknown>) => Record<string, unknown>;
  noteArgs: (data: Record<string, unknown>) => [string, Record<string, unknown>];
  clickTarget: (data: { url: string }) => string;
};

async function loadHandlers(): Promise<SwHandlers> {
  const src = await Bun.file(new URL("../../../public/sw-handlers.js", import.meta.url)).text();
  const scope: { self: Record<string, unknown> } = { self: { location: { origin: "https://subshell.test" } } };
  new Function("self", src)(scope.self);
  return scope.self.SubshellSw as SwHandlers;
}

describe("sw-handlers", () => {
  it("shouldShow is false when the focused client is already looking at the target", async () => {
    const { shouldShow } = await loadHandlers();
    expect(shouldShow({ url: "/subshells/x" }, "https://subshell.test/subshells/x")).toBe(false);
  });

  it("shouldShow is true with no focused client", async () => {
    const { shouldShow } = await loadHandlers();
    expect(shouldShow({ url: "/subshells/x" }, null)).toBe(true);
  });

  it("shouldShow is true when the focused client is somewhere else", async () => {
    const { shouldShow } = await loadHandlers();
    expect(shouldShow({ url: "/subshells/x" }, "https://subshell.test/settings")).toBe(true);
  });

  it("noteOptions carries title, body, tag and the raw data", async () => {
    const { noteOptions } = await loadHandlers();
    const data = { title: "Subshell done", body: "pi finished", tag: "subshell:abc", url: "/subshells/x" };
    expect(noteOptions(data)).toEqual({
      title: "Subshell done",
      body: "pi finished",
      tag: "subshell:abc",
      data,
    });
  });

  it("noteArgs splits into the showNotification(title, options) pair", async () => {
    const { noteArgs } = await loadHandlers();
    const data = { title: "Subshell done", body: "pi finished", tag: "subshell:abc", url: "/subshells/x" };
    const [title, options] = noteArgs(data);
    expect(title).toBe("Subshell done");
    expect(options).toEqual({ body: "pi finished", tag: "subshell:abc", data });
  });

  it("clickTarget resolves a relative payload url against the worker origin", async () => {
    const { clickTarget } = await loadHandlers();
    expect(clickTarget({ url: "/subshells/x" })).toBe("https://subshell.test/subshells/x");
  });

  it("clickTarget passes an absolute url through", async () => {
    const { clickTarget } = await loadHandlers();
    expect(clickTarget({ url: "https://other.test/a" })).toBe("https://other.test/a");
  });
});

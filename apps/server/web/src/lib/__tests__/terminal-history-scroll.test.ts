import { expect, it } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { type HistoryScrollAction, scrollTerminalHistory } from "../terminal-history-scroll";

it("scrolls local shell history and routes alternate-screen navigation through guarded input", () => {
  const calls: unknown[] = [];
  const term = {
    buffer: { active: { type: "normal" } },
    scrollToTop: () => calls.push("top"),
    scrollToBottom: () => calls.push("bottom"),
    scrollPages: (pages: number) => calls.push(pages),
    input: (data: string) => calls.push(data),
  };
  const actions: HistoryScrollAction[] = ["top", "page-up", "page-down", "bottom"];
  const scroll = (allowed: boolean) => {
    for (const action of actions) scrollTerminalHistory(term as unknown as Terminal, action, allowed);
  };
  scroll(false);
  expect(calls).toEqual(["top", -1, 1, "bottom"]);
  calls.length = 0;
  term.buffer.active.type = "alternate";
  scroll(false);
  expect(calls).toEqual([]);
  scroll(true);
  expect(calls).toEqual(["\x1b[H", "\x1b[5~", "\x1b[6~", "\x1b[F"]);
  calls.length = 0;
  term.buffer.active.type = "normal";
  scroll(true);
  expect(calls).toEqual(["top", -1, 1, "bottom"]);
});

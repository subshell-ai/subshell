import { describe, expect, it } from "bun:test";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin from "../index.js";

const plugin = createPlugin(createTestHost());
const DOWN = "\u001b[B";
const ESC = "\u001b";

const inspector = (selected: string) =>
  [
    "subagents fleet",
    `${selected === "scout" ? ">" : " "} scout · running    12s`,
    `${selected === "reviewer" ? ">" : " "} reviewer · running  8s`,
    "↑/↓ select · enter inspect · esc close",
  ].join("\n");

describe("PiPlugin.subagents.select", () => {
  it("opens the fleet inspector and selects the child by the roster name", async () => {
    let screen = "❯ ";
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: "call:1",
      agents: [
        { id: "call:0", name: "scout", status: "running", startedAt: 1 },
        { id: "call:1", name: "reviewer", status: "running", startedAt: 2 },
      ],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === "/subagents-fleet") screen = "❯ /subagents-fleet";
          else if (text === "\r" && screen.includes("/subagents-fleet")) screen = inspector("scout");
          else if (text === DOWN && screen.includes("subagents fleet")) screen = inspector("reviewer");
          else if (text === ESC) screen = "❯ ";
        },
      },
    });
    expect(result).toEqual({ selectedId: "call:1" });
    expect(typed).toEqual(["/subagents-fleet", "\r", DOWN]);
  });

  it("closes the inspector when returning to the main agent", async () => {
    let screen = inspector("reviewer");
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: null,
      agents: [{ id: "call:1", name: "reviewer", status: "running", startedAt: 2 }],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === ESC) screen = "❯ ";
        },
      },
    });
    expect(result).toEqual({ selectedId: null });
    expect(typed).toEqual([ESC]);
  });
  it("reads the live fleet inspector's boxed roster", async () => {
    const boxed = (selected: string) =>
      [
        "╭──────────────────────────────────┬─────────────────────────────╮",
        "│     Subagent fleet inspector · live controls      ● worker · running │",
        "├──────────────────────────────────┼─────────────────────────────┤",
        `│${selected === "worker" ? "›" : " "} ● worker [fres... running│`,
        `│${selected === "scout" ? "›" : " "} ● scout · Audit the parser        running │`,
        "├──────────────────────────────────┴─────────────────────────────┤",
        "│ ↑/↓ agent · p Prompt Audit · Enter Inspect · esc close · 1/2    │",
        "╰────────────────────────────────────────────────────────────────╯",
      ].join("\n");
    let screen = boxed("worker");
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: "call:1",
      agents: [
        { id: "call:0", name: "worker", status: "running", startedAt: 1 },
        { id: "call:1", name: "scout", status: "running", startedAt: 2 },
      ],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === DOWN) screen = boxed("scout");
        },
      },
    });
    expect(result).toEqual({ selectedId: "call:1" });
    expect(typed).toEqual([DOWN]);
  });
});

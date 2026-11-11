import { describe, expect, it } from "bun:test";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin from "../index.js";

const plugin = createPlugin(createTestHost());
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESC = "\u001b";
const ENTER = "\r";

const panel = (selected: "main" | "general-purpose") =>
  [
    "❯ ",
    `${selected === "main" ? ">" : " "} main`,
    `${selected === "general-purpose" ? ">" : " "} general-purpose · running  1m`,
    "Esc to deselect",
  ].join("\n");

describe("ClaudeCodePlugin.subagents.select", () => {
  it("opens the selected child transcript from the agent panel", async () => {
    let screen = panel("main");
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: "agent-1",
      agents: [{ id: "agent-1", name: "general-purpose", status: "running", startedAt: 1 }],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === DOWN && screen.includes("> main")) screen = panel("general-purpose");
          else if (text === ENTER) screen = "general-purpose\nmain > general-purpose";
          else if (text === ESC) screen = panel("general-purpose");
        },
      },
    });
    expect(result).toEqual({ selectedId: "agent-1" });
    expect(typed).toEqual([DOWN, ENTER]);
  });

  it("returns to the main agent row", async () => {
    let screen = "general-purpose\nmain > general-purpose";
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: null,
      agents: [{ id: "agent-1", name: "general-purpose", status: "running", startedAt: 1 }],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === ESC) screen = panel("general-purpose");
          else if (text === UP) screen = panel("main");
          else if (text === ENTER) screen = panel("main");
        },
      },
    });
    expect(result).toEqual({ selectedId: null });
    expect(typed).toEqual([ESC, UP, ENTER]);
  });
  it("uses the roster order when two children share a name", async () => {
    const duplicate = (selected: number) =>
      [
        "❯ ",
        `${selected === 0 ? ">" : " "} main`,
        `${selected === 1 ? ">" : " "} general-purpose · running  2m`,
        `${selected === 2 ? ">" : " "} general-purpose · running  1m`,
        "Esc to deselect",
      ].join("\n");
    let screen = duplicate(0);
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: "agent-2",
      agents: [
        { id: "agent-1", name: "general-purpose", status: "running", startedAt: 1 },
        { id: "agent-2", name: "general-purpose", status: "running", startedAt: 2 },
      ],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === DOWN) screen = duplicate(screen.includes("> main") ? 1 : 2);
          else if (text === ENTER) screen = "general-purpose\nmain > general-purpose";
        },
      },
    });
    expect(result).toEqual({ selectedId: "agent-2" });
    expect(typed).toEqual([DOWN, DOWN, ENTER]);
  });
  it("selects a child from the live panel's glyph rows", async () => {
    const live = (state: "unfocused" | "focused-main" | "child") =>
      [
        "❯ Say hello and stop.",
        "",
        state === "focused-main" ? "❯ ● main" : "  ● main",
        `${state === "child" ? "❯ ◯" : "  ◯"} general-purpose  nav test child  8s`,
      ].join("\n");
    let screen = live("unfocused");
    const typed: string[] = [];
    const result = await plugin.subagents?.select?.({
      agentId: "agent-1",
      agents: [{ id: "agent-1", name: "general-purpose", status: "running", startedAt: 1 }],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed.push(text);
          if (text === DOWN) screen = live(screen.includes("❯ ● main") ? "child" : "focused-main");
          else if (text === ENTER) screen = "general-purpose\nmain > general-purpose";
        },
      },
    });
    expect(result).toEqual({ selectedId: "agent-1" });
    expect(typed).toEqual([DOWN, DOWN, ENTER]);
  });
});

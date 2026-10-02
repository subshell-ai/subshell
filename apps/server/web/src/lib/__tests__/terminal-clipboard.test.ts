import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { attachTerminalClipboard, decodeClipboardRequest, MAX_CLIPBOARD_BYTES } from "../terminal-clipboard";

afterEach(() => mock.restore());

function terminal() {
  let callback: (data: string) => boolean | Promise<boolean> = () => false;
  const dispose = mock(() => {});
  const registerOscHandler = mock((code: number, handler: typeof callback) => {
    expect(code).toBe(52);
    callback = handler;
    return { dispose };
  });
  return {
    term: { parser: { registerOscHandler } } as unknown as Pick<Terminal, "parser">,
    receive: (text: string) => callback(text),
    dispose,
  };
}

describe("remote terminal clipboard", () => {
  it("decodes multiline Unicode text and supported selection targets", () => {
    const text = "hello 🌎\nnext line";
    const encoded = Buffer.from(text).toString("base64");
    for (const target of ["", "c", "p", "cp", "s0"]) {
      expect(decodeClipboardRequest(`${target};${encoded}`)).toBe(text);
    }
  });

  it("ignores reads, clearing, malformed payloads, invalid UTF-8 and oversized text", () => {
    for (const data of ["c;?", "c;", "missing delimiter", "bad;aGVsbG8=", "c;!!!!", "c;/w==", "c;a==="]) {
      expect(decodeClipboardRequest(data)).toBeNull();
    }
    expect(decodeClipboardRequest(`c;${Buffer.alloc(MAX_CLIPBOARD_BYTES + 1).toString("base64")}`)).toBeNull();
  });

  it("writes only after the browser Copy action and reports success", async () => {
    const messages = spyOn(toast, "message").mockReturnValue("pane-copy");
    const success = spyOn(toast, "success").mockReturnValue(1);
    const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const t = terminal();
    const detach = attachTerminalClipboard(t.term);
    expect(t.receive("c;aGVsbG8=")).toBe(true);
    expect(write).not.toHaveBeenCalled();
    const action = messages.mock.calls[0]?.[1]?.action;
    if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Expected Copy action");
    action.onClick({} as never);
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith("hello");
    expect(success).toHaveBeenCalled();
    detach();
  });

  it("replaces prior prompts and retires stale actions on detach", () => {
    const messages = spyOn(toast, "message").mockReturnValue("pane-copy");
    const dismiss = spyOn(toast, "dismiss").mockReturnValue(1);
    const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const t = terminal();
    const detach = attachTerminalClipboard(t.term);
    t.receive("c;?");
    expect(messages).not.toHaveBeenCalled();
    t.receive("c;aGVsbG8=");
    t.receive("c;bmV3");
    expect(messages.mock.calls[1]?.[1]?.id).toBe("pane-copy");
    const action = messages.mock.calls[1]?.[1]?.action;
    detach();
    if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Expected Copy action");
    action.onClick({} as never);
    expect(write).not.toHaveBeenCalled();
    expect(t.dispose).toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledWith("pane-copy");
  });

  it("handles OSC 52 split across terminal writes with BEL and ST terminators", async () => {
    const messages = spyOn(toast, "message").mockReturnValue(1);
    const term = new Terminal({ allowProposedApi: true });
    const detach = attachTerminalClipboard(term);
    const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve));
    await write("\x1b]52;c;aGV");
    expect(messages).not.toHaveBeenCalled();
    await write("sbG8=\x07");
    expect(messages).toHaveBeenCalledTimes(1);
    await write("\x1b]52;c;bmV3\x1b\\");
    expect(messages).toHaveBeenCalledTimes(2);
    detach();
    term.dispose();
  });

  it("reports a denied clipboard write without reporting success", async () => {
    const messages = spyOn(toast, "message").mockReturnValue(1);
    const error = spyOn(toast, "error").mockReturnValue(1);
    const success = spyOn(toast, "success").mockReturnValue(1);
    spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
    const t = terminal();
    const detach = attachTerminalClipboard(t.term);
    t.receive("c;aGVsbG8=");
    const action = messages.mock.calls[0]?.[1]?.action;
    if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("Expected Copy action");
    action.onClick({} as never);
    await Promise.resolve();
    expect(error).toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    detach();
  });
});

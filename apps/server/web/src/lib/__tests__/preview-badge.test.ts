import { describe, expect, it } from "bun:test";
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SavedService } from "@/hooks/use-subshell-services";
import { shouldPollSavedServices, unsavedPreviewItemCount } from "@/lib/preview-badge";

/**
 * The header badge's rule: discovered items with no saved service row that the
 * READER could actually open. The cases are the ones a wrong answer would
 * actually ship: double-counting a port seen on both IPv4 and IPv6,
 * badge-noising a pane whose node has previews off, a browser watch whose CDP
 * port is also a saved app, and numbering rows a `view` grantee is refused.
 */
function info(over: Partial<PreviewInfo> = {}): PreviewInfo {
  return {
    ports: [],
    cdpPort: null,
    screen: null,
    nodeEnabled: true,
    ...over,
  };
}

function port(p: number, proto: "tcp" | "tcp6" = "tcp"): PreviewInfo["ports"][number] {
  return { proto, port: p, pid: 100 + p };
}

function saved(p: number): SavedService {
  return { id: `s${p}`, name: `app ${p}`, host: "127.0.0.1", port: p, protocol: "http" };
}

const OPEN = "edit" as const;

describe("unsavedPreviewItemCount", () => {
  it("counts nothing before the first answer, or when the node cannot serve previews", () => {
    expect(unsavedPreviewItemCount(undefined, [], OPEN)).toBe(0);
    expect(unsavedPreviewItemCount(info({ nodeEnabled: false }), [], OPEN)).toBe(0);
    expect(unsavedPreviewItemCount(info({ reason: "node-offline", ports: [port(3000)] }), [], OPEN)).toBe(0);
  });

  it("counts each discovered thing the pane has no saved row for", () => {
    expect(unsavedPreviewItemCount(info({ ports: [port(3000), port(3001)] }), [], OPEN)).toBe(2);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000), port(3001)] }), [saved(3000)], OPEN)).toBe(1);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)] }), [saved(3000)], OPEN)).toBe(0);
  });

  it("counts only features enabled on the node", () => {
    const screen: PreviewInfo["screen"] = { display: ":90", viewer: { protocol: "vnc", port: 5910 } };
    const everything = { ports: [port(3000)], cdpPort: 9222, screen };
    expect(unsavedPreviewItemCount(info({ ...everything, webPreviewsEnabled: false }), [], OPEN)).toBe(1);
    expect(unsavedPreviewItemCount(info({ ...everything, virtualDisplayEnabled: false }), [], OPEN)).toBe(2);
    expect(
      unsavedPreviewItemCount(
        info({ ...everything, webPreviewsEnabled: false, virtualDisplayEnabled: false }),
        [],
        OPEN,
      ),
    ).toBe(0);
    expect(unsavedPreviewItemCount(info({ ...everything, webPreviewsEnabled: false }), [], "view")).toBe(0);
  });

  it("counts a dual-stack port once", () => {
    expect(unsavedPreviewItemCount(info({ ports: [port(3000), port(3000, "tcp6")] }), [], OPEN)).toBe(1);
  });

  it("counts the screen and the browser watch as one item each", () => {
    const screen: PreviewInfo["screen"] = { display: ":90", viewer: { protocol: "vnc", port: 5910 } };
    expect(unsavedPreviewItemCount(info({ screen }), [], OPEN)).toBe(1);
    expect(unsavedPreviewItemCount(info({ cdpPort: 9222 }), [], OPEN)).toBe(1);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)], cdpPort: 9222 }), [saved(3000)], OPEN)).toBe(1);
  });

  it("treats a missing services read as nothing saved, never as zero", () => {
    // The list is still in flight: hiding the badge would tell the person
    // there is nothing to open when there may be several things.
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)] }), undefined, OPEN)).toBe(1);
  });

  it("counts only what a view grantee can open", () => {
    // The picker refuses the app-port and screen rows for `view` (spec §6 and
    // §7: opening is `edit`), so a badge that counted them would put a number
    // on an icon whose every control answers "needs edit access". Browser
    // watch is the act `view` keeps, and the only one it may be advertised.
    const screen: PreviewInfo["screen"] = { display: ":90", viewer: { protocol: "vnc", port: 5910 } };
    const everything = info({ ports: [port(3000), port(3001)], screen, cdpPort: 9222 });
    expect(unsavedPreviewItemCount(everything, [], "view")).toBe(1);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)], screen }), [], "view")).toBe(0);
    expect(unsavedPreviewItemCount(info({ cdpPort: 9222 }), [], "view")).toBe(1);
  });
});

describe("shouldPollSavedServices", () => {
  it("holds the services poll off in exactly the states the count ignores", () => {
    expect(shouldPollSavedServices(undefined, OPEN)).toBe(false);
    expect(shouldPollSavedServices(info({ nodeEnabled: false }), OPEN)).toBe(false);
    expect(shouldPollSavedServices(info({ reason: "node-offline" }), OPEN)).toBe(false);
    expect(shouldPollSavedServices(info(), OPEN)).toBe(true);
  });

  it("holds the poll off for a switch-on refusal like preview-ports-unsupported", () => {
    // The route answers `nodeEnabled: true` alongside the reason whenever the
    // node has no /proc to scan, which is every macOS pane. Gating the poll on
    // the switch alone left those panes asking for a list for a count that is
    // always 0; the reason is what says there is nothing to ask.
    expect(shouldPollSavedServices(info({ nodeEnabled: true, reason: "preview-ports-unsupported" }), OPEN)).toBe(false);
  });

  it("holds the poll off for a viewer who never has ports counted", () => {
    // Same discard logic as the reason above: the count ignores the services
    // list at `view`, so the read would run every five seconds for nothing.
    expect(shouldPollSavedServices(info({ ports: [port(3000)] }), "view")).toBe(false);
  });
});

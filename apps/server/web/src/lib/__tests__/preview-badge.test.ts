import { describe, expect, it } from "bun:test";
import type { PreviewInfo } from "@/hooks/use-subshell-preview";
import type { SavedService } from "@/hooks/use-subshell-services";
import { shouldPollSavedServices, unsavedPreviewItemCount } from "@/lib/preview-badge";

/**
 * The header badge's rule: discovered items with no saved service row. The
 * cases are the ones a wrong answer would actually ship: double-counting a
 * port seen on both IPv4 and IPv6, badge-noising a pane whose node has
 * previews off, and a browser watch whose CDP port is also a saved app.
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

describe("unsavedPreviewItemCount", () => {
  it("counts nothing before the first answer, or when the node cannot serve previews", () => {
    expect(unsavedPreviewItemCount(undefined, [])).toBe(0);
    expect(unsavedPreviewItemCount(info({ nodeEnabled: false }), [])).toBe(0);
    expect(unsavedPreviewItemCount(info({ reason: "node-offline", ports: [port(3000)] }), [])).toBe(0);
  });

  it("counts each discovered thing the pane has no saved row for", () => {
    expect(unsavedPreviewItemCount(info({ ports: [port(3000), port(3001)] }), [])).toBe(2);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000), port(3001)] }), [saved(3000)])).toBe(1);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)] }), [saved(3000)])).toBe(0);
  });

  it("counts a dual-stack port once", () => {
    expect(unsavedPreviewItemCount(info({ ports: [port(3000), port(3000, "tcp6")] }), [])).toBe(1);
  });

  it("counts the screen and the browser watch as one item each", () => {
    const screen: PreviewInfo["screen"] = { display: ":90", viewer: { protocol: "vnc", port: 5910 } };
    expect(unsavedPreviewItemCount(info({ screen }), [])).toBe(1);
    expect(unsavedPreviewItemCount(info({ cdpPort: 9222 }), [])).toBe(1);
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)], cdpPort: 9222 }), [saved(3000)])).toBe(1);
  });

  it("treats a missing services read as nothing saved, never as zero", () => {
    // The list is still in flight: hiding the badge would tell the person
    // there is nothing to open when there may be several things.
    expect(unsavedPreviewItemCount(info({ ports: [port(3000)] }), undefined)).toBe(1);
  });
});

describe("shouldPollSavedServices", () => {
  it("holds the services poll off in exactly the states the count ignores", () => {
    expect(shouldPollSavedServices(undefined)).toBe(false);
    expect(shouldPollSavedServices(info({ nodeEnabled: false }))).toBe(false);
    expect(shouldPollSavedServices(info({ reason: "node-offline" }))).toBe(false);
    expect(shouldPollSavedServices(info())).toBe(true);
  });

  it("holds the poll off for a switch-on refusal like preview-ports-unsupported", () => {
    // The route answers `nodeEnabled: true` alongside the reason whenever the
    // node has no /proc to scan, which is every macOS pane. Gating the poll on
    // the switch alone left those panes asking for a list for a count that is
    // always 0; the reason is what says there is nothing to ask.
    expect(shouldPollSavedServices(info({ nodeEnabled: true, reason: "preview-ports-unsupported" }))).toBe(false);
  });
});

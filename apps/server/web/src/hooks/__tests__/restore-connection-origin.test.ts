import { describe, expect, it } from "bun:test";
import { restoreConnectionOrigin } from "@/hooks/use-backups.js";

function setOrigin(url: string): void {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}

describe("restoreConnectionOrigin", () => {
  it("follows an http restore onto the app's own new port", () => {
    setOrigin("http://172.16.0.5:3080");
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1, port: 3100, priorPort: 3080 })).toBe(
      "http://172.16.0.5:3100",
    );
  });

  it("follows an https restore served directly on the app's custom port", () => {
    // The gap the fix closes: a page whose port equals the port the restore
    // replaced is talking to the server DIRECTLY, whatever the scheme. The old
    // http-only guard left an https-on-app-port tab polling the dead old origin
    // forever after a port-changing restore ("not reconnected").
    setOrigin("https://plane.example:8443");
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1, port: 9000, priorPort: 8443 })).toBe(
      "https://plane.example:9000",
    );
  });

  it("keeps the origin when a proxy fronts the app (the page port is not the app's)", () => {
    // https://plane.example (proxy :443) restoring to a different SERVER_PORT:
    // the proxy does not move with the app's port, so jumping to
    // plane.example:PORT would hit nothing. Stay put and let the card explain.
    setOrigin("https://plane.example");
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1, port: 3100, priorPort: 3080 })).toBe(
      "https://plane.example",
    );
  });

  it("follows a loopback restore even when the page port does not match the prior one", () => {
    setOrigin("http://localhost:4000");
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1, port: 3100, priorPort: 3080 })).toBe(
      "http://localhost:3100",
    );
  });

  it("does nothing when there is no port change to follow", () => {
    setOrigin("http://172.16.0.5:3080");
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1, port: 3080, priorPort: 3080 })).toBe(
      "http://172.16.0.5:3080",
    );
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1 })).toBe("http://172.16.0.5:3080");
  });

  it("follows a restore off the default http port onto the app's own port", () => {
    setOrigin("http://box.lan"); // browser default :80
    expect(restoreConnectionOrigin({ id: "j", expiresAt: 1, port: 3100, priorPort: 80 })).toBe("http://box.lan:3100");
  });
});

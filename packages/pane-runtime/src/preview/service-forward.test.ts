import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect as tlsConnect } from "node:tls";
import { PreviewForward, type PreviewLaneEvent } from "./forward.js";

let directory: string;
let key: Buffer;
let cert: Buffer;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "service-tls-"));
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(generated.exitCode).toBe(0);
  key = readFileSync(join(directory, "key.pem"));
  cert = readFileSync(join(directory, "cert.pem"));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
for (const mode of ["untrusted", "trusted", "ignore"] as const)
  test(`HTTPS lane certificate policy: ${mode}`, async () => {
    let received = "";
    const server = createServer({ key, cert }, (socket) => {
      socket.on("error", () => {});
      socket.on("data", (bytes) => {
        received += bytes.toString();
        socket.write("encrypted response");
      });
    });
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const events: PreviewLaneEvent[] = [];
    // The trusted case supplies a CA; the opt-in case uses the production dial.
    const forward = new PreviewForward(
      mode === "trusted"
        ? {
            connect: (options) =>
              tlsConnect({
                host: options.host,
                port: options.port,
                servername: "localhost",
                ca: cert,
                rejectUnauthorized: true,
              }),
          }
        : {},
    );
    const ref = "a".repeat(32);
    let done!: () => void;
    const answered = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      forward.openLane({
        ref,
        paneId: "test",
        port: (server.address() as AddressInfo).port,
        service: {
          host: "127.0.0.1",
          protocol: "https",
          ...(mode === "ignore" ? { ignoreCertificateErrors: true } : {}),
        },
        lifetimeMs: 1000,
        hooks: {
          emit: (event) => {
            events.push(event);
            done();
          },
        },
      });
      forward.ingestInboundFrame({
        type: "preview_data",
        ref,
        dir: "in",
        blob: Buffer.from("private bytes").toString("base64"),
      });
      await answered;
      if (mode !== "untrusted") {
        expect(received).toBe("private bytes");
        expect(
          events.some(
            (event) =>
              event.type === "preview_data" && Buffer.from(event.blob, "base64").toString() === "encrypted response",
          ),
        ).toBe(true);
      } else {
        expect(received).toBe("");
        expect(events).toEqual([{ type: "preview_closed", ref, reason: "target-gone" }]);
      }
    } finally {
      forward.closeAll("viewer-left");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

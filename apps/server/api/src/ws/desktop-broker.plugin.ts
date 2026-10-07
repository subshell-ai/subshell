import { Elysia } from "elysia";
import {
  attachDesktopBroker,
  authenticateDesktopBroker,
  type DesktopIdentity,
  type DesktopLink,
  type DesktopSocket,
} from "@/services/ssh-runtime/desktop-broker.js";

interface BrokerSocket extends DesktopSocket {
  data: { desktopIdentity: DesktopIdentity; desktopLink?: DesktopLink; desktopOpening?: Promise<void> };
}
/** This narrow bearer is accepted only here; REST authGuard never recognizes it. */
export const desktopBrokerWsPlugin = new Elysia().ws("/api/ssh-runtime/desktop-brokers/attach", {
  async upgrade(context) {
    const request = (context as { request: Request }).request;
    const identity = await authenticateDesktopBroker(request.headers.get("authorization"));
    Object.assign(context as Record<string, unknown>, { desktopIdentity: identity });
  },
  open(ws) {
    const socket = ws as unknown as BrokerSocket;
    socket.data.desktopOpening = attachDesktopBroker(socket.data.desktopIdentity, socket)
      .then((link) => {
        socket.data.desktopLink = link;
      })
      .catch(() => {
        socket.close(4401, "Desktop pairing refused");
      });
  },
  async message(ws, frame) {
    const socket = ws as unknown as BrokerSocket;
    await socket.data.desktopOpening;
    await socket.data.desktopLink?.message(frame).catch(() => socket.data.desktopLink?.close());
  },
  async close(ws) {
    const socket = ws as unknown as BrokerSocket;
    await socket.data.desktopOpening;
    socket.data.desktopLink?.close();
  },
  maxPayloadLength: 1024 * 1024,
  idleTimeout: 60,
});

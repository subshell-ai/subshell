import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { KeyBar } from "@/components/key-bar";
import type { MoteClient } from "@/lib/api";
import { wrapPaste } from "@/lib/key-bar";
import { type SocketStatus, useSessionSocket } from "@/lib/session-socket";
import { colors } from "@/lib/tokens";

/**
 * The Live tab (spec §Rendering): a renderer, not a client. Incoming frames
 * arrive as strings via injectJavaScript; keystrokes/size post back through
 * onMessage. The bundled page has no network access and cannot reach the
 * token — that posture is what keeps the Keychain gate meaningful.
 */
export function LiveHost({ client, sessionId, active }: { client: MoteClient; sessionId: string; active: boolean }) {
  const webview = useRef<WebView | null>(null);
  const ready = useRef(false);
  const queue = useRef<string[]>([]); // writes issued before the page reports ready
  const [status, setStatus] = useState<SocketStatus>({ state: "connecting" });

  const inject = useCallback((expr: string) => {
    if (!ready.current) {
      queue.current.push(expr);
      return;
    }
    webview.current?.injectJavaScript(`${expr}; true;`);
  }, []);

  const { sendInput, sendResize } = useSessionSocket({
    client,
    sessionId,
    active,
    handlers: {
      onReset: () => inject("window.N.reset()"),
      onBytes: (data) => inject(`window.N.write(${JSON.stringify(data)})`),
      onStatus: (s) => setStatus(s),
    },
  });

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let m: { type: string; data?: string; cols?: number; rows?: number } | null = null;
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (!m) return;
      if (m.type === "keys" && m.data) sendInput(m.data);
      if (m.type === "size" && m.cols && m.rows) sendResize(m.cols, m.rows);
      if (m.type === "ready") {
        ready.current = true;
        if (m.cols && m.rows) sendResize(m.cols, m.rows);
        for (const expr of queue.current.splice(0)) webview.current?.injectJavaScript(`${expr}; true;`);
      }
    },
    [sendInput, sendResize],
  );

  // When the tab hides, the socket tears down and the page must re-report
  // ready before the next frame lands in it.
  useEffect(() => {
    if (!active) {
      ready.current = false;
      queue.current = [];
    }
  }, [active]);

  const onPaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    // Harness TUIs run with DECSET 2004 on; bracket by default (web parity).
    sendInput(wrapPaste(text, true));
  }, [sendInput]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.termCanvas }}>
      <RejectedBanner status={status} />
      <WebView
        ref={webview}
        source={require("../../assets/terminal.html")}
        onMessage={onMessage}
        javaScriptEnabled
        style={{ flex: 1, backgroundColor: colors.termCanvas }}
        // The renderer owns no network: refuse every request beyond the bundle.
        onShouldStartLoadWithRequest={(r) => r.url.startsWith("file://") || r.url === "about:blank"}
        originWhitelist={["file://*"]}
      />
      <KeyBar disabled={status.state !== "open"} onBytes={sendInput} onPaste={() => void onPaste()} />
    </View>
  );
}

/** Standing copy for the 4xxx rejections (spec §Error handling). */
function RejectedBanner({ status }: { status: SocketStatus }) {
  if (status.state !== "rejected") return null;
  const text =
    status.code === 4001
      ? "Not authorized — sign in again."
      : status.code === 4004
        ? "This session is not running."
        : "The terminal rejected the attach.";
  return (
    <View style={{ padding: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={{ color: colors.warning, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

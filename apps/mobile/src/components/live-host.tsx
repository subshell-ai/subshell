import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { KeyBar } from "@/components/key-bar";
import type { SubshellClient } from "@/lib/api";
import { wrapPaste } from "@/lib/key-bar";
import { type SocketStatus, useSubshellSocket } from "@/lib/subshell-socket";
import { colors, radius, touchTarget } from "@/lib/tokens";
import { requireBiometric } from "@/native/biometric";

const UNLOCK_LABEL = "Unlock the terminal";
/**
 * Cap on frames buffered while the page boots. A renderer that never reports
 * ready must not grow memory without bound; if it comes up late the next
 * attach's replay (wiped in via onReset) is the resync path, so dropping past
 * the cap is recoverable.
 */
const QUEUE_CAP = 200;

/**
 * The Live tab (spec §Rendering): a renderer, not a client. Incoming frames
 * arrive as strings via injectJavaScript; keystrokes/size post back through
 * onMessage. The bundled page has no network access and cannot reach the
 * token — that posture is what keeps the Keychain gate meaningful.
 */
export function LiveHost({
  client,
  subshellId,
  active,
  readOnly = false,
}: {
  client: SubshellClient;
  subshellId: string;
  active: boolean;
  /** A `view` grantee: output streams but keystrokes/paste are dropped and the key bar is hidden (spec §4.1). */
  readOnly?: boolean;
}) {
  const webview = useRef<WebView | null>(null);
  const ready = useRef(false);
  const queue = useRef<string[]>([]); // writes issued before the page reports ready
  // The Face ID gate protects ATTACHMENT — the socket carries keystroke
  // power (spec §Security notes). Denied → retry card, never silent.
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!active) {
      setUnlocked(false);
      return;
    }
    void requireBiometric(UNLOCK_LABEL).then((ok) => {
      if (!cancelled) setUnlocked(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const inject = useCallback((expr: string) => {
    if (!ready.current) {
      if (queue.current.length >= QUEUE_CAP) {
        console.warn("[live] renderer not ready; dropping frame");
        return;
      }
      queue.current.push(expr);
      return;
    }
    webview.current?.injectJavaScript(`${expr}; true;`);
  }, []);

  const { sendInput, sendResize, status } = useSubshellSocket({
    // The platform lookup lives here, in RN-land, not in the socket module.
    deviceLabel: `Subshell on ${Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS}`,
    client,
    subshellId,
    active: active && unlocked,
    handlers: {
      onReset: () => inject("window.N.reset()"),
      onBytes: (data) => inject(`window.N.write(${JSON.stringify(data)})`),
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
      if (m.type === "keys" && m.data && !readOnly) sendInput(m.data);
      if (m.type === "size" && m.cols && m.rows) sendResize(m.cols, m.rows);
      if (m.type === "ready") {
        ready.current = true;
        if (m.cols && m.rows) sendResize(m.cols, m.rows);
        // One bridge call for the whole backlog, not one per queued frame.
        const queued = queue.current.splice(0);
        if (queued.length) webview.current?.injectJavaScript(`${queued.join("; ")}; true;`);
      }
    },
    [sendInput, sendResize, readOnly],
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
    if (readOnly) return;
    const text = await Clipboard.getStringAsync();
    // Harness TUIs run with DECSET 2004 on; bracket by default (web parity).
    sendInput(wrapPaste(text, true));
  }, [sendInput, readOnly]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.termCanvas }}>
      <RejectedBanner status={status} />
      {!unlocked ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
          <Text style={{ color: colors.mutedFg }}>The terminal is locked.</Text>
          <Pressable
            onPress={() => void requireBiometric(UNLOCK_LABEL).then(setUnlocked)}
            style={{
              minHeight: touchTarget,
              paddingHorizontal: 20,
              borderRadius: radius,
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: colors.bg, fontWeight: "700" }}>Unlock</Text>
          </Pressable>
        </View>
      ) : (
        <>
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
          {!readOnly && (
            <KeyBar disabled={status.state !== "open"} onBytes={sendInput} onPaste={() => void onPaste()} />
          )}
        </>
      )}
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
        ? "This subshell is not running."
        : "The terminal rejected the attach.";
  return (
    <View style={{ padding: 12, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={{ color: colors.warning, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

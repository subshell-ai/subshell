import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { isRepeatable, KEY_BAR_BUTTONS, KEY_BAR_EXTENDED } from "@/lib/key-bar";
import { colors, font, touchTarget } from "@/lib/tokens";

const REPEAT_DELAY_MS = 400;
const REPEAT_RATE_MS = 90;

/**
 * The accessory row (spec §Screens key bar; web terminal-key-bar.tsx rules):
 * every button is a plain byte sender — subshell intercepts nothing. Arrows
 * press-repeat; `⋯` flips to the Ctrl/Pg page; the paste button sends the
 * clipboard wrapped in bracketed-paste markers (wired by the host).
 */
export function KeyBar({
  disabled,
  onBytes,
  onPaste,
  keyboardUp = false,
  onToggleKeyboard,
}: {
  /** Grayed until the subshell WS is attached */
  disabled: boolean;
  /** Write raw bytes to the pane */
  onBytes: (bytes: string) => void;
  /** Send the clipboard contents (bracketed by the caller's choice) */
  onPaste: () => void;
  /** Whether the device's soft keyboard is currently showing */
  keyboardUp?: boolean;
  /**
   * Raise or dismiss the soft keyboard. The only DETERMINISTIC way to do
   * either: the keyboard belongs to the WebView, so a tap on the terminal is
   * the only other thing that reaches it and a tap cannot dismiss.
   */
  onToggleKeyboard?: () => void;
}) {
  const [extended, setExtended] = useState(false);
  const timers = useRef<{ start: ReturnType<typeof setTimeout> | null; loop: ReturnType<typeof setInterval> | null }>({
    start: null,
    loop: null,
  });

  const stopRepeat = useCallback(() => {
    if (timers.current.start) clearTimeout(timers.current.start);
    if (timers.current.loop) clearInterval(timers.current.loop);
    timers.current = { start: null, loop: null };
  }, []);

  // Navigating away mid-hold must not leave a 90 ms interval typing into a
  // socket the unmounted screen no longer owns (review #6, 2026-08-31).
  useEffect(() => stopRepeat, [stopRepeat]);

  function startRepeat(bytes: string, label: string) {
    onBytes(bytes);
    if (!isRepeatable(label)) return;
    timers.current.start = setTimeout(() => {
      timers.current.loop = setInterval(() => onBytes(bytes), REPEAT_RATE_MS);
    }, REPEAT_DELAY_MS);
  }

  const buttons = extended ? KEY_BAR_EXTENDED : KEY_BAR_BUTTONS;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 4 }}>
        {buttons.map((b) => (
          <Pressable
            key={b.label}
            disabled={disabled}
            onPressIn={() => startRepeat(b.bytes, b.label)}
            onPressOut={stopRepeat}
            style={{
              minWidth: touchTarget,
              height: touchTarget,
              alignItems: "center",
              justifyContent: "center",
              opacity: disabled ? 0.4 : 1,
            }}
          >
            <Text style={{ ...font("body"), color: colors.mutedFg, fontFamily: "Menlo" }}>{b.label}</Text>
          </Pressable>
        ))}
        <Pressable
          disabled={disabled}
          onPress={() => setExtended((v) => !v)}
          style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ ...font("label"), color: extended ? colors.primary : colors.mutedFg }}>⋯</Text>
        </Pressable>
        <Pressable
          disabled={disabled}
          onPress={onPaste}
          style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ ...font("body"), color: colors.mutedFg }}>📋</Text>
        </Pressable>
        {onToggleKeyboard && (
          // Not disabled with the rest: dismissing a keyboard that is covering
          // half the pane has to work even while the socket is down.
          <Pressable
            onPress={onToggleKeyboard}
            accessibilityLabel={keyboardUp ? "Hide the keyboard" : "Show the keyboard"}
            style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...font("body"), color: keyboardUp ? colors.primary : colors.mutedFg }}>⌨</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

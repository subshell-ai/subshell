import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { isRepeatable, KEY_BAR_BUTTONS, KEY_BAR_EXTENDED } from "@/lib/key-bar";
import { colors, touchTarget } from "@/lib/tokens";

const REPEAT_DELAY_MS = 400;
const REPEAT_RATE_MS = 90;

/**
 * The accessory row (spec §Screens key bar; web terminal-key-bar.tsx rules):
 * every button is a plain byte sender — mote intercepts nothing. Arrows
 * press-repeat; `⋯` flips to the Ctrl/Pg page; the paste button sends the
 * clipboard wrapped in bracketed-paste markers (wired by the host).
 */
export function KeyBar({
  disabled,
  onBytes,
  onPaste,
}: {
  /** Grayed until the session WS is attached */
  disabled: boolean;
  /** Write raw bytes to the pane */
  onBytes: (bytes: string) => void;
  /** Send the clipboard contents (bracketed by the caller's choice) */
  onPaste: () => void;
}) {
  const [extended, setExtended] = useState(false);
  const timers = useRef<{ start: ReturnType<typeof setTimeout> | null; loop: ReturnType<typeof setInterval> | null }>({
    start: null,
    loop: null,
  });

  function stopRepeat() {
    if (timers.current.start) clearTimeout(timers.current.start);
    if (timers.current.loop) clearInterval(timers.current.loop);
    timers.current = { start: null, loop: null };
  }

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
            <Text style={{ color: colors.mutedFg, fontFamily: "Menlo", fontSize: 14 }}>{b.label}</Text>
          </Pressable>
        ))}
        <Pressable
          disabled={disabled}
          onPress={() => setExtended((v) => !v)}
          style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: extended ? colors.primary : colors.mutedFg, fontSize: 16 }}>⋯</Text>
        </Pressable>
        <Pressable
          disabled={disabled}
          onPress={onPaste}
          style={{ minWidth: touchTarget, height: touchTarget, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: colors.mutedFg, fontSize: 14 }}>📋</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

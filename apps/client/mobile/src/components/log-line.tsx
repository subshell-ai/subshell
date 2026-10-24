import { Linking, Text } from "react-native";
import { logSegments } from "@/lib/log-segments";
import { colors } from "@/lib/tokens";

/**
 * One Log-tab line with its URLs tappable. The Log is plain `<Text>` rows,
 * so a link is a nested `<Text>` span: the same trim and scheme decision the
 * Live tab's taps make (both run `@internal/subshell-protocol`'s scan), and
 * the same http(s) gate before `Linking` — the line is output printed by
 * whatever ran in the pane, which is untrusted.
 */
export function LogLine({ line, style }: { line: string; style?: object }) {
  const segments = logSegments(line);
  if (segments.length === 1 && !segments[0]?.url) {
    return <Text style={style}>{line.length > 0 ? line : " "}</Text>;
  }
  return (
    <Text style={style}>
      {segments.map((segment, index) => {
        // One const per span: the http(s)-gate closure keeps the narrowed
        // url instead of re-reading the property (and a `!` here would be
        // rewritten away by biome before it ever reached tsc).
        const url = segment.url;
        const key = `${index}:${url ?? "text"}`;
        if (!url) return <Text key={key}>{segment.text}</Text>;
        return (
          <Text
            key={key}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(url).catch(() => {})}
            style={{ color: colors.primary, textDecorationLine: "underline" }}
          >
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

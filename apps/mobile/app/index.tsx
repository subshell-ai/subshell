import { stripAnsi } from "@internal/backend-errors";
import { MAX_UPLOAD_BYTES } from "@internal/session-protocol";
import { Stack } from "expo-router";
import { Text, useWindowDimensions, View } from "react-native";
import { isWide } from "@/lib/breakpoints";

/**
 * Scaffold probe: proves the two things every later screen depends on — that the
 * `@internal/*` workspace packages resolve through Metro, and that the `@/`
 * alias works at runtime and not just under `tsc`.
 *
 * Replaced by the session shell in M2.
 */
export default function ScaffoldProbe() {
  const { width } = useWindowDimensions();
  const shell = isWide(width) ? "wide" : "compact";

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#0a0c0f" }}>
      <Text style={{ color: "#e4e4e7", fontSize: 17 }}>mote mobile</Text>
      <Text style={{ color: "#8b8b90" }}>
        {Math.round(width)}px → {shell} shell
      </Text>
      <Text style={{ color: "#8b8b90" }}>
        session-protocol: {MAX_UPLOAD_BYTES / 1024 / 1024} MB upload cap ·{" "}
        {stripAnsi("␛[31mansi␛[0m") === "ansi" ? "stripAnsi ok" : "stripAnsi FAIL"}
      </Text>
      <Stack screenOptions={{ headerShown: false }} />
    </View>
  );
}

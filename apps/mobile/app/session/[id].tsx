import { Stack, useLocalSearchParams } from "expo-router";
import { SessionDetail } from "@/components/session-detail";

/** Deep-linkable full-screen detail: subshell://session/<id> lands here. */
export default function SessionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      {id ? <SessionDetail sessionId={id} /> : null}
    </>
  );
}

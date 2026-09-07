import { Stack, useLocalSearchParams } from "expo-router";
import { SubshellDetail } from "@/components/subshell-detail";

/** Deep-linkable full-screen detail: subshell://subshell/<id> lands here. */
export default function SubshellRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      {id ? <SubshellDetail subshellId={id} /> : null}
    </>
  );
}

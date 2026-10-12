import { Card, CardContent, CardHeader, CardTitle } from "@internal/node-admin";
import type { ReactNode } from "react";

/** Keep prompt and stack columns aligned while their rows own expansion and actions. */
export function PromptLibraryTable({
  kind,
  shared,
  children,
}: {
  kind: "prompts" | "stacks";
  shared: boolean;
  children: ReactNode;
}) {
  const title = kind === "prompts" ? "Saved prompts" : "Prompt stacks";
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="@container overflow-x-auto">
          <table className="w-full text-sm" aria-label={title}>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="pr-4 pb-2 font-strong">
                  Name
                </th>
                <th
                  scope="col"
                  className={
                    kind === "prompts"
                      ? "@3xl:table-cell hidden pr-4 pb-2 font-strong"
                      : "@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong"
                  }
                >
                  {kind === "prompts" ? "Preview" : "Prompts"}
                </th>
                <th scope="col" className="@lg:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                  {shared ? "Owner" : "Sharing"}
                </th>
                <th scope="col" className="@2xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">
                  Updated
                </th>
                <th scope="col" className="pb-2 text-right font-strong" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

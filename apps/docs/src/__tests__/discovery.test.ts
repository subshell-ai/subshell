import { describe, expect, test } from "bun:test";
import { breadcrumbData, markdownBody, serializeStructuredData } from "../../lib/discovery";

describe("discovery content", () => {
  test("breadcrumb URLs and visible labels share the same source", () => {
    const data = breadcrumbData([
      { title: "Subshell Docs", url: "/" },
      { title: "MCP tools", url: "/mcp/tools" },
    ]);
    expect(data.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Subshell Docs", item: "https://docs.subshell.sh/" },
      { "@type": "ListItem", position: 2, name: "MCP tools", item: "https://docs.subshell.sh/mcp/tools" },
    ]);
  });

  test("a content label cannot terminate the structured-data script", () => {
    const value = { name: "</script><script>alert(1)</script>" };
    const serialized = serializeStructuredData(value);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(value);
  });

  test("AI markdown retains code and warnings while stripping authoring frontmatter", () => {
    const body =
      'Install the server.\n\n> [!warning] Data loss\n> Reset deletes state.\n\n```json\n{"id":"example"}\n```';
    expect(markdownBody(`---\ntitle: Example\ndescription: Test\n---\n\n${body}\n`)).toBe(body);
    expect(markdownBody(body)).toBe(body);
  });
});

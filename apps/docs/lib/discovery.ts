import { SITE_ORIGIN } from "./site";

export interface Breadcrumb {
  title: string;
  url: string;
}

/** The same breadcrumb list is rendered visibly and serialized for crawlers. */
export function breadcrumbData(items: Breadcrumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.title,
      item: new URL(item.url, SITE_ORIGIN).href,
    })),
  };
}

/** Keep script delimiters inert when a content title contains HTML characters. */
export function serializeStructuredData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Strip authoring metadata, retaining headings, code fences and alert text. */
export function markdownBody(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
}

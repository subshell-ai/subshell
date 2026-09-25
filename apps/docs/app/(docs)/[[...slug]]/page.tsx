import { createRelativeLink } from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle, EditOnGitHub } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { editPageUrl } from "@/lib/site";
import { source } from "@/lib/source";

interface PageRouteProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page(props: PageRouteProps) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} lastUpdate={page.data.lastModified}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // lets pages link to each other with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
        <EditOnGitHub href={editPageUrl(page.path)} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageRouteProps): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    // Canonical = the page's own path on the real origin. metadataBase
    // (docs.subshell.sh) makes this absolute; it tells crawlers that a
    // `/foo`, `/foo/`, or `?utm=` variant is one page, not duplicates.
    alternates: { canonical: page.url },
  };
}

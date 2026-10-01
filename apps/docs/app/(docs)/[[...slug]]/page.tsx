import { createRelativeLink } from "fumadocs-ui/mdx";
import { DocsBody, DocsPage, DocsTitle, EditOnGitHub } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { type Breadcrumb, breadcrumbData, serializeStructuredData } from "@/lib/discovery";
import { editPageUrl, SITE_ORIGIN } from "@/lib/site";
import { source } from "@/lib/source";

interface PageRouteProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page(props: PageRouteProps) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const breadcrumbs: Breadcrumb[] = [{ title: "Subshell Docs", url: "/" }];
  for (let depth = 1; depth <= (params.slug?.length ?? 0); depth++) {
    const ancestor = source.getPage(params.slug?.slice(0, depth));
    if (ancestor) breadcrumbs.push({ title: ancestor.data.title, url: ancestor.url });
  }

  return (
    <DocsPage
      className="gap-2"
      toc={page.data.toc}
      full={page.data.full}
      lastUpdate={page.data.lastModified}
      breadcrumb={{ enabled: false }}
    >
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-sm text-fd-muted-foreground">
          <ol className="flex flex-wrap gap-2">
            {breadcrumbs.map((item, index) => (
              <li key={item.url}>
                {index > 0 && (
                  <span aria-hidden="true" className="mr-2">
                    /
                  </span>
                )}
                <a href={item.url} aria-current={index === breadcrumbs.length - 1 ? "page" : undefined}>
                  {item.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <DocsTitle>{page.data.title}</DocsTitle>
      </header>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD has HTML delimiters escaped and tested.
        dangerouslySetInnerHTML={{ __html: serializeStructuredData(breadcrumbData(breadcrumbs)) }}
      />
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
    openGraph: {
      type: "website",
      siteName: "Subshell Docs",
      title: page.data.title,
      description: page.data.description,
      url: new URL(page.url, SITE_ORIGIN).href,
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Subshell Docs" }],
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
      images: ["/og.png"],
    },
  };
}

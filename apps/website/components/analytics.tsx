/**
 * GA4 pageview tag (spec §7). An EMPTY id means no script appears in the
 * bundle at all (empty-is-off, the standing operator ladder). Pageviews only:
 * no custom dimensions, no PII; traffic-source reporting is GA4's standard
 * session source/medium, which is the ask.
 */
export function Analytics({ id }: { id: string | undefined }) {
  if (id === undefined || id === "") return null;
  // The id is double-quoted below because the test pins that spelling; single
  // vs double is equivalent JS.
  const inline = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config',"${id}")`;
  return (
    <>
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${id}`} />
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the gtag.js bootstrap snippet: the only interpolation is `id`, which comes from a build-time env var and is rendered nowhere else */}
      <script dangerouslySetInnerHTML={{ __html: inline }} />
    </>
  );
}

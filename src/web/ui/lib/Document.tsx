/** web/ui/lib/Document.tsx — the one HTML document every page is prerendered into. See ../../http-router.md. */

// Prerendered at build time (scripts/build-web.mjs) into committed dist/*.html. Values that are
// only known per-request arrive as %%TOKENS%%, substituted with escaping by web/assets.ts.
const PREFIX = '/immich-shared-albums';

export type PageMeta = {
  title: string;
  /** Extra <meta property> pairs, e.g. og: tags. */
  meta?: Record<string, string>;
  /** Basename in dist/ — links %%name%%.css, and %%name%%.js when hasScript. */
  name: string;
  hasScript?: boolean;
  /** Immich share pages pin maximum-scale; the framed page inherits our viewport, so match it. */
  matchImmichViewport?: boolean;
};

export const Document = ({ page, children }: { page: PageMeta; children?: preact.ComponentChildren }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta
        name="viewport"
        content={
          page.matchImmichViewport
            ? 'width=device-width, initial-scale=1, maximum-scale=1'
            : 'width=device-width, initial-scale=1'
        }
      />
      <title>{page.title}</title>
      {Object.entries(page.meta ?? {}).map(([property, content]) => (
        <meta property={property} content={content} />
      ))}
      <link rel="stylesheet" href={`${PREFIX}/assets/${page.name}.css`} />
    </head>
    <body>
      {children}
      {page.hasScript && <script type="module" src={`${PREFIX}/assets/${page.name}.js`} />}
    </body>
  </html>
);

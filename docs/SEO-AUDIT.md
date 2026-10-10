# Pre-launch SEO audit for built websites

Run the dependency-free audit from the Atlas repository root:

```powershell
node scripts/local/seo-audit.mjs --directory C:\path\to\site\dist --url https://example.com
```

Use the site's intended production origin. The command reads existing build
artifacts; it does not rebuild, rewrite files, crawl the internet or deploy.
It works with Genesis static sites and other builds containing HTML and a root
`sitemap.xml`.

The output is versioned JSON (`schemaVersion: 1`) with the origin, status,
page/error/warning counts, findings and limitations. Each finding has a
severity, stable code, relative file and action-oriented message. Source
content and untrusted URLs are not copied into diagnostics.

Exit codes:

- **0:** no blocking findings. Warnings may still require review.
- **1:** blocking launch findings; read the report and repair the build.
- **2:** invalid arguments, unreadable input or an audit limit exceeded.
  No partial successful report is produced.

## Checks

- Nonempty HTML title and one canonical link in the head.
- Absolute HTTPS canonical and sitemap locations matching the selected origin,
  with no embedded credentials or fragment.
- Canonicals present in the root sitemap; duplicate sitemap locations and
  shared titles/canonicals flagged for review.
- Robots/googlebot `noindex` or `none` metadata, including in the body.
- Missing descriptions and primary headings flagged for review.
- Absolute production sitemap reference in robots.txt; root disallow rules
  flagged for manual user-agent/allow-precedence review.

These checks follow
[Google's canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
and [absolute sitemap URL guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
Requiring a root sitemap and HTTPS production origin is this launch audit's
explicit policy, not a claim that every search engine requires those choices.

## Bounds and limitations

The audit refuses symlinks and caps directory entries at 2,000, nesting at
8 levels, HTML pages at 200, each inspected document at 2 MiB and aggregate
document bytes at 20 MiB. HTML and the root robots/sitemap files are inspected;
other assets are counted during traversal but not read.

Metadata extraction is conservative and supports simple urlset sitemaps.
It is not a complete HTML/XML parser or robots-rule evaluator. It does not
check live HTTP headers, redirects, canonical response status, rendered
JavaScript, crawl results, structured-data validity, accessibility, search
rankings or GEO visibility. A successful report is a static pre-launch check,
not a production SEO certification.

Genesis's current static-site renderer emits relative canonical, sitemap and
robots sitemap URLs. The real-template regression test demonstrates that the
audit catches this unfinished production-domain work. The audit does not
silently fix these artifacts or interfere with the in-progress visual editor.

## Validation

```powershell
node --test scripts/local/seo-audit.test.mjs
```

The existing runner-scripts CI job discovers `scripts/local/*.test.mjs`.
Tests cover valid output and CLI exit codes, read-only behavior, canonical and
sitemap disagreements, noindex, comments/scripts, XML entities, unsupported
sitemap indexes, invalid arguments, bounds, symlinks where supported and an
actual Genesis renderer build.

Follow-up: integrate a verified production domain into generated builds, then
connect recurring live crawl/SEO checks and measured GEO outcomes through the
existing automation runtime. Keep those broader tasks open until verified.

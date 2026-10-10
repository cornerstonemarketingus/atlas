# Atlas visual system

2026-10-10 | PR #258 | owner-requested interface redesign

Atlas uses midnight blue (#080f1e), cyan (#67e8f9), cool blue highlights and quiet slate borders. Public pages and the workspace share the same identity. Light and system workspace themes use blue-white surfaces and a darker cyan accent.

The public entrance presents software creation, child agents, computer control and ongoing automation, with complete business creation and dedicated game workflows identified as the larger direction. Authentication controls and approval behavior are unchanged.

Implementation: apps/web/app/atlas-brand.css, imported last by layout.tsx, supplies shared presentation tokens and component rules. Existing shell files are avoided because they overlap an active memory PR. Consolidate older palette rules after that PR lands. Installed-app manifest and favicon use the same colors.

Validation: required GitHub CI on PR #258 supplies lint, typecheck, test and build evidence. Local shell and browser automation failed during initialization in this session; screenshot and signed-in visual review remain outstanding. Review desktop and phone widths and light/system/dark workspace themes when browser access is restored.

No database schema migration or new SEO functionality is part of this change.

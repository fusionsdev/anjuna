# Magic Pattern loan template

Static landing site built from the Magic Pattern content bundle (5 brand presets).
`build.ts` renders `content/*.ts` into `site/` following `docs/template-contract.md`.

```sh
bun build.ts                 # writes site/ (preset navy-green)
bun build.ts ./out trust-blue
bun run --cwd ../../packages/template-cert check-template ../../integrations/magic-pattern-template/site
```

Pages: `/`, `/faq/`, `/rates-and-terms/`, `/privacy/`, `/terms/`, `/do-not-sell/`, `/disclosures/`.
Presets: navy-green, trust-blue, forest-amber, plum-violet, slate-teal.

Submit: zip the contents of `site/` and POST to `/submit-zip` with a builder key
(`docs/runbooks/open-design-templates.md`). Legal copy needs attorney review before sealing.

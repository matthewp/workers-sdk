---
"@cloudflare/pages-functions": minor
---

New package for compiling Pages Functions directories into deployable Workers

Provides both a programmatic API and a CLI (`pages-functions build`) for converting a `functions/` directory into a Cloudflare Worker. The routing logic (filepath-based route discovery, routes module generation, `_routes.json` transformation/consolidation/validation) has been extracted from Wrangler into this package. Wrangler now depends on and re-exports from `@cloudflare/pages-functions`.

```sh
npx @cloudflare/pages-functions build ./functions --outdir ./dist
```

The compiled Worker can then be deployed with `wrangler deploy`.

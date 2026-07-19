---
"wrangler": minor
"miniflare": minor
---

Add batch workflow instance deletion support.

- `wrangler workflows instances delete <name> <id..>` deletes up to 100 workflow instances (works remotely and in local dev via `--local`).
- The Workflows binding now supports `env.MY_WORKFLOW.deleteBatch(instanceIds)` in local development and returns per-instance deletion results.

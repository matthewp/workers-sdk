---
"wrangler": minor
"miniflare": minor
---

Add workflow instance deletion support.

- `wrangler workflows instances delete <name> <id>` deletes a workflow instance (works remotely and in local dev via `--local`).
- The Workflows binding now supports `instance.delete()` (`env.MY_WORKFLOW.get(id).delete()`). Supported in local dev through the miniflare Workflows binding.

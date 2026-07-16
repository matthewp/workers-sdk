---
"wrangler": minor
"miniflare": minor
---

Add workflow instance deletion support.

- `wrangler workflows instances delete <name> <id>` deletes a workflow instance and its stored state (works remotely and in local dev via `--local`).
- The Workflows binding now supports `instance.delete()` (`env.MY_WORKFLOW.get(id).delete()`), which wipes the instance's engine storage. Supported in local dev through the miniflare Workflows binding.

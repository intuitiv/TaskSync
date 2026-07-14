---
description: Export the current problem + relevant file list + memories to a manifest for offline brainstorming in Microsoft Copilot cowork (free). Enumerates by search only — NEVER reads full file contents, so it costs almost no tokens.
---

# /export-to-cowork

Your job: write a single manifest file that a **free local script** will later expand into a full bundle. You must stay cheap — the entire value of this command is that it does NOT burn tokens reading files.

## HARD RULES (token discipline)

1. **NEVER read full file contents** to judge relevance. Use `file_search`, `grep_search`/`rg_search`, `code_nav` (document_symbols / workspace_symbols), and what is already in context. Enumerate by *metadata and search hits only*.
2. If you are tempted to open a file "just to check", don't — add it to the manifest with a short `reason` and let the human/cowork decide. Over-inclusion is cheap; reading is expensive.
3. Do not summarize file contents. Only record `{path, reason}`.
4. Output exactly ONE file: `.askaway/cowork-manifest.json`. Do not write the bundle yourself.

## What to gather (all via search, not reads)

- **task**: the problem statement / brief for this topic (from the user's request + current conversation). 1–5 sentences.
- **context**: short orienting notes — what's been tried, constraints, the decision to make. A few bullets max.
- **expectedOutput**: what cowork should return (e.g. "a reasoning writeup + a unified diff patch under `.askaway/cowork-inbox/` + any memory updates"). Keep it prescriptive so the return leg is machine-friendly.
- **files**: `[{ "path": "<workspace-relative or absolute>", "reason": "<why relevant, ≤1 line>" }]`. Discover via searches. Include source, config, and docs you'd want an offline model to see. Prefer precise paths; use `globs` for whole folders.
- **globs**: optional glob patterns (e.g. `tasksync-chat/src/**/*.ts`) for the bundle script to expand — cheaper than listing every file.
- **memories**: absolute paths to relevant memory files to append verbatim to the bundle. Resolve with the memory URI resolver when needed. Typical: repo memory + any relevant user-memory topic files.

## Steps

1. Derive `task`, `context`, `expectedOutput` from the conversation (no file reads).
2. Run targeted searches to enumerate relevant `files` / `globs`. Batch independent searches.
3. Resolve relevant memory file absolute paths.
4. Write `.askaway/cowork-manifest.json` with this shape:

```json
{
  "version": 1,
  "createdAt": "<ISO timestamp>",
  "topic": "<short title>",
  "task": "<problem statement>",
  "context": ["<bullet>", "<bullet>"],
  "expectedOutput": "<what cowork should produce>",
  "files": [{ "path": "tasksync-chat/src/foo.ts", "reason": "core logic" }],
  "globs": ["tasksync-chat/src/**/*.ts"],
  "memories": ["/absolute/path/to/memory.md"]
}
```

5. Tell the user the next step verbatim:

   > Manifest written. Build the free local bundle with:
   > `node ~/.askaway/cowork/bundle.mjs`
   > Then upload `.askaway/cowork-bundle.md` to Microsoft Copilot cowork. When it returns a patch/reasoning, drop it in `.askaway/cowork-inbox/` and run `node ~/.askaway/cowork/apply.mjs`.

## Modes

- **New topic**: build the manifest fresh from the user's stated problem.
- **Existing conversation**: mine the current thread for `task`/`context` and the files already referenced, then add search-discovered neighbors.

Remember: your success metric is a COMPLETE file list produced with MINIMAL token spend. Searches good, reads bad.

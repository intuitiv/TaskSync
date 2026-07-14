# cowork — offline brainstorming offload

Export your workspace state to a single file, brainstorm it in **Microsoft Copilot cowork** (free, works on mobile), then bring back a patch or reasoning — **without burning Copilot credits on the export**.

## The loop

```
/export-to-cowork          (chat)  → writes .askaway/cowork-manifest.json   [cheap: search only, no file reads]
node cowork/bundle.mjs     (shell) → writes .askaway/cowork-bundle.md       [free: pure fs]
        ↓ upload bundle to Microsoft Copilot cowork, brainstorm on mobile
        ↓ cowork returns a unified diff patch + reasoning
save output → .askaway/cowork-inbox/*.patch  (+ optional *.md reasoning)
node cowork/apply.mjs      (shell) → git apply patches, print reasoning     [free]
git diff && commit
```

## Why it saves credits

- The **export** (`/export-to-cowork`) only enumerates files via search — it never reads full contents, so it costs almost nothing.
- The **bundle** and **apply** steps are plain Node with no dependencies and no model calls — completely free.
- The actual thinking happens in cowork (free), not in a metered Copilot turn.

## Export leg — `/export-to-cowork`

A prompt command (`.github/prompts/export-to-cowork.prompt.md`). It writes `.askaway/cowork-manifest.json`:

```json
{
  "version": 1,
  "createdAt": "2026-07-12T...",
  "topic": "short title",
  "task": "the problem statement",
  "context": ["what's been tried", "constraints"],
  "expectedOutput": "reasoning + a unified diff patch under .askaway/cowork-inbox/",
  "files": [{ "path": "tasksync-chat/src/foo.ts", "reason": "core logic" }],
  "globs": ["tasksync-chat/src/**/*.ts"],
  "memories": ["/abs/path/to/memory.md"]
}
```

You can also hand-edit the manifest and skip the chat command entirely.

## Bundle leg — `node cowork/bundle.mjs`

Reads the manifest, expands `globs`, concatenates every file with `=== path ===` headers, appends the memory files verbatim, and prepends task/context/expected-output. Output: `.askaway/cowork-bundle.md`.

```
node cowork/bundle.mjs                      # default manifest + output
node cowork/bundle.mjs path/to/manifest.json
node cowork/bundle.mjs --out custom.md
node cowork/bundle.mjs --max-bytes 200000   # per-file truncation cap (default 400k)
```

Ignores `node_modules`, `.git`, `dist`, `build`, etc. when expanding globs.

## Return leg — `node cowork/apply.mjs`

Drop cowork's output into `.askaway/cowork-inbox/`:

- `*.patch` / `*.diff` → validated with `git apply --check`, then applied (`--3way` fallback).
- `*.md` / `*.txt` → printed back as reasoning.

```
node cowork/apply.mjs            # apply everything in the inbox
node cowork/apply.mjs --check    # dry-run: validate only
node cowork/apply.mjs one.patch  # single file
```

## Publishing (phase 2)

MVP writes a local file. To ground cowork on your tenant files, SharePoint/OneDrive is the right target (needs Graph API auth) — deferred. For a quick shareable URL you can pipe the bundle through your toolbox `publisher` (`files.msnlabs.me`) manually.

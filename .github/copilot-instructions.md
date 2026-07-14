# TaskSync / AskAway — Workspace Instructions

Workspace-specific guidance for developing the AskAway extension (`tasksync-chat/`).
General cross-workspace behavior lives in the **AskAway Build** agent; this file
holds only what is specific to THIS repo.

## Build & Deploy AskAway
- Source: `tasksync-chat/`. Build + deploy locally by copying the built bundle to the
  installed dev folder: `npx tsc -p ./ --noEmit && node esbuild.js && cp dist/extension.js ~/.vscode/extensions/intuitiv.askaway-1.0.35/dist/extension.js && cp package.json ~/.vscode/extensions/intuitiv.askaway-1.0.35/`.
  When webview/CSS changed, also copy `media/webview.js` and `media/main.css`.
- VS Code does NOT hot-reload on `cp` — **RELOAD THE WINDOW** after deploy.
- After editing `media/webview.js`, run `node --check media/webview.js` (tsc/esbuild never parse it).
- Record proof after changes: compile result, deploy marker (`DEPLOYED OK`), or relevant log source.

## Observability Rules (AskAway metrics)
- Observability is per workspace — never aggregate logs across unrelated VS Code workspaceStorage folders.
- Credit totals are recomputed from all readable current-workspace Copilot `main.jsonl` files, not a rolling window.
- Skip malformed/corrupt JSONL lines; continue counting valid lines.
- Credit display = local aggregation of Copilot log `copilotUsageNanoAiu` ÷ 1_000_000_000 (AIU).
- RTK token savings are SEPARATE from Copilot credits: savings come from `rtk gain --daily --format json`; credits come from `copilotUsageNanoAiu`. Never count RTK savings as Copilot credits.

## RTK (this repo's optimization work)
- Resolve RTK mode once at session start: if `~/.askaway-rtk-enabled` exists, RTK mode is on.
- Prefix eligible SIMPLE commands with `rtk ` (the global `~/.copilot/copilot-instructions.md` covers the base rule). Do NOT wrap compound commands (`&&`, `|`, redirects/subshells) — split them and wrap each simple command independently. If a command already starts with `rtk `, don't double-prefix.
- Keep commands simple so RTK can compress output effectively.

## Gradle test target (for engine testing)
- Reference project: `/Users/machs/VSProjects/model-calculation-service-app-logic` (JAVA_HOME corretto-17). Config phase is ~100s before the first `> Task`; keep the daemon warm, never pkill mid-run.

## Communication (this repo)
- Be honest about boundaries: you cannot rewrite Copilot's closed system prompt; guide behavior via this agent, tool descriptions, tool results, and worker prompts.
- Explain credit math plainly when asked.

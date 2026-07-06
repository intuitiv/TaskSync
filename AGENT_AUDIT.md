# AskAway Build — Agent Audit Log

## 2026-07-06 (later) IST — Crisp budget banner, conciseness instruction, timeline alignment; committed + pushed

**Requests:** budget banner too verbose → crisp; add strong "be concise" instruction (post-Caveman); fix uneven timeline formatting (screenshot); commit + push.

**Done:**
- Budget banner shortened in `extension.ts BUDGET_INJECT_SCRIPT` + live `~/.askaway/hooks/budget-inject.js`: `Budget: 200 AIU/turn (fresh). Last turn 182/200 (91%, high).` (tier: `, OVER` ≥100% / `, high` ≥75% / none). Verified output.
- `extension.ts ASKWAY_BUILD_AGENT_CONTENT` Communication section: added 3 strong crispness rules (shortest correct answer 1–3 sentences, result-first, no preamble/filler/self-narration, tight summary + proof over prose). Self-heals installed agent on activation.
- `media/main.css`: `.obs-caret/.obs-caret-spacer` gain `margin-right:4px` + `vertical-align:middle`; new `.obs-req-id` span rule (monospace, tabular-nums, `min-width:42px`, link color) so request/tool IDs align and carets aren't glued to IDs.
- Build tsc+esbuild OK, DEPLOYED OK, media (main.css+webview.js) copied. Reload window to see UI.

## 2026-07-06 (later) IST — Turn-budget hook boundary bug (fresh turn showed prior-turn spend)

**Bug (user):** fresh turn banner showed near-exhausted budget ("3 AIU left") carried from the previous turn; my own "99%" claim was likewise wrong.

**Root cause:** `BUDGET_INJECT_SCRIPT` (UserPromptSubmit hook) fires BEFORE the new turn's `user_message` is written to `main.jsonl`. So `lastSubmit` = the PREVIOUS turn's user_message ts, and `nano` (sum of llm_request `copilotUsageNanoAiu` since lastSubmit) = the PREVIOUS turn's total — but it was labeled as THIS turn. The `turn_budget` pull tool is unaffected (called mid-turn, after the user_message is logged).

**Fix:** rewrote the banner tail in `extension.ts` `BUDGET_INJECT_SCRIPT` (and the live `~/.askaway/hooks/budget-inject.js`) to state the current turn is fresh (0 spent) and report the measured value as PREVIOUS-turn spend with a warn tier (fine/ran high ≥75%/over), directing the agent to the `turn_budget` tool for live in-turn spend. `lastSubmit===0` → simple fresh message. Verified: emits `"...THIS turn — fresh, 0 spent... Previous turn used 167.44/200 (84%), previous turn ran high..."`. Build tsc+esbuild OK, DEPLOYED OK, `node --check` hook OK. Self-heals on next activation (content-diff rewrite).

## 2026-07-06 (later) IST — Tokenizer for tool tokens, $ in red, simplified request glance; credits reconciled to MS 34K

**Requests:** (1) MS dashboard says July=34K not 15K, recheck; (2) tokenize tool input+output (not chars/4); (3) show $ (=AIU/100) in red beside turn AIU; (4) make the per-request "glance" plain — what the request contains — drop cache/new/old jargon.

**Done (code):**
- (2) `webviewProvider.ts` timeline tool events now use `countTokens(argsStr)/countTokens(resultStr)` (exact o200k) instead of `Math.ceil(len/4)`. Month tool rollup fold still chars/4 (aggregate stores only chars, not strings) — noted.
- (3) `media/webview.js` `obs-turn-summary` switched textContent→innerHTML; appends `($X.XX)` in red (`#f14c4c`), usd = nanoAiu/1e9/100.
- (4) `renderSplitDetail` rewritten: plain label ("Start of conversation" / "Your message + history" / "Follow-up after tool calls") + total, and clean lines System prompt / Tool definitions / Conversation history (msgs) / Latest message. Removed cachedPrior/new + "Cached (reused total)" jargon.
- Build: tsc --noEmit + esbuild OK, `node --check webview.js` OK, DEPLOYED OK, media/webview.js copied to installed ext. Reload window to see it.

**(1) Credits truth reconciled:** MS **34K is authoritative**. My earlier live-log scan (15K) only sees CURRENTLY-EXISTING debug logs — Copilot rotates/prunes sessions, so ~19K of July spend already rotated off disk → live scan undercounts. Durable shard tried to retain rotated data but DOUBLE-COUNTS → 65K. So neither 15K nor 65K is right; ~34K is. This kills the earlier "clean rebuild (option 1)" idea — it would resnap to 15K and UNDERcount. Correct fix = per-line dedup (keep-once via `sid:li:hash`), which preserves already-seen rotated sessions without doubling → should converge near 34K. NOT implemented this turn (turn budget ~99%); next turn with fresh budget.

## 2026-07-06 (later) IST — Observability diagnosis: first-req "cached", tool ordering, MONTH CREDITS OVER-COUNT (USP)

**Request (user):** (1) first request A4156 shows 8.24K cached with no prior turn — why? (2) tool/request ordering + 66AC4 "user msg 1.06K" vs tools "64/1.25K/1.25K" seems wrong; (3) "This month credits" shows 64K — verify, it's the USP.

**Findings (diagnosis only, no code changes):**
1. First-req "cached" is a *measurement gap*, not provider cache. `cached = conversation − new = (total−system−tools) − tokens(inputMessages+userRequest)`. On req 1 the model total includes env_info/workspace-structure/attachments/memory framing that the sidecars don't capture → positive remainder mislabeled "cached". Real provider cache is the separate "Cached (reused total)" line.
2. Ordering is correct (timestamp sort, firstOfTurn pinned). The apparent mismatch is different metrics: "user msg 1.06K" = exact o200k user text; tool "1.25K" = tool OUTPUT payload sized as `chars/4` (approx, webviewProvider ~2033), billed only when folded into the NEXT request's input. Not comparable, not a bug. Only imprecision: tool tokens are chars/4 estimates.
3. **CONFIRMED USP BUG — month credits ~4.3× inflated.** Verified from raw logs: stored global shard `observability-months/_global.json` July=65,206 AIU/3,813 req vs TRUE live sum=15,061 AIU/321 req; June shard 79,355 vs true 38,142; all-months shard 144,562 vs live 53,203 (~2.7×). Cause: additive shard + per-file byte cursors (`observability-global-offsets.json`) with buckets only reset on `GLOBAL_FOLD_VERSION` (=2) bump; when the offsets file resets/desyncs while buckets persist, already-counted lines re-fold on top → non-integer inflation. Fix proposed (awaiting user go): (1) bump GLOBAL_FOLD_VERSION→3 for clean rebuild from existing logs (July→~15K; loses truly-rotated history), (2) replace byte-offset fold with per-line dedup keys (`sid:li:hash`) for permanent correctness + rotation durability. Recommend #1 now, #2 durable.

**Proof commands:** node scans of `User/workspaceStorage/*/GitHub.copilot-chat/debug-logs/*/main.jsonl` summing `attrs.copilotUsageNanoAiu` by month; read of `_global.json` + offsets. Recorded in repo memory. No source edits made.

## 2026-07-06 (later) IST — Q&A: token "cached" ambiguity + turn-budget wiring check

**Request (user):** clarify request 50601's input breakdown — Conversation shows "101K cached + 110K new" yet "Cached (reused total) = 0"; and confirm whether the turn-budget tool actually works given no instruction in the Build agent.

**Findings (no code changes):**
- Two distinct "cached" meanings collide on the Conversation row. `new` (110K) = `newMessageTokens`, exact o200k of this request's sidecar messages+user text (measured). `cached` (101K) = `cachedPriorTokens = conversation − new`, a *derived* prior-history label — NOT provider cache. "Cached (reused total)=0" = `split.cachedTokens`, the provider-REPORTED prompt-cache hits. 0 ⇒ genuine cache miss: ~101K reusable prior history existed but was billed full price (this is what cache-miss-spikes.jsonl tracks). "input 229" = `userTokens` (latest user msg), fine.
- Recommended one-word relabel of the Conversation line "cached" → "prior" to kill the ambiguity (offered, not yet applied).
- Turn budget IS working via both paths — verified: `turn_budget` tool registered (tools.ts:933); setting `askaway.turnBudgetAiu=200`; sentinel `~/.askaway/turn-budget-aiu`=200; UserPromptSubmit `budget-gate.sh` hook registered in `~/.claude/settings.json` (HOOK_YES). Push hook injects a live banner every prompt regardless of agent instructions; pull tool is self-describing. No `.agent.md` instruction is required for it to function.

## 2026-07-06 (later) IST — Exact tokens, shipping prep (3a–e), budget-injection hook (part 4)

**Requests (user):** exact token counts (no estimates — add a tokenizer); then ship-prep: (3a) disable bash_task/research_on + hide their tabs + update Build prompt; (3b) remove Caveman; (3c) move Copilot Debug Logging above Optimisation; (3d) RTK graceful + shown disabled when not installed; (3e) install-time hook + Build prompt; and (4) inject per-turn budget via a HOOK (not ask_user).

**Exact tokenization (o200k):** added `gpt-tokenizer` dep; `countTokens()` lazily loads o200k_base. Data finding: sidecars contain only the *new delta* (`inputMessages` ~319 tok while model reported 117,413, cached 116,736) because it's the responses API with server-side prefix caching. Exact reconciliation = tokenize system + tools precisely, then derive `conversation = reportedTotal − system − tools`. `_readSidecarStats` tokenizes sidecar `.content`, counts skills (`<skill>`) / tools (JSON array len). Verified: 61,662 + 11,919 + 43,832 = **117,413 exact**. Bundle → 4.3M. Also pinned the turn's first request (`firstOfTurn`) to the top with a `submission` tag.

**3a:** `WORKER_TOOLS_ENABLED=false` gates bash_task + research_on registration (reversible); removed both from package.json `languageModelTools`; removed Commands + Agents tab buttons; stripped delegation lines from the Build prompt. **3b:** removed Caveman everywhere (webview section/vars/handlers, `_formatCavemanQuestion`, `isCavemanEnabled`, `updateCavemanSetting`, config reads, tools.ts, ask_user CAVEMAN text). **3c:** Debug Logging renders above the Optimization header. **3d:** `isRtkInstalled()` (paths+PATH, cached); `isRtkCompressionEnabled()` requires the binary; broadcast `rtkInstalled`; webview disables RTK toggle + "(rtk not installed)"; enable handler warns+refuses when absent. **3e:** confirmed the three `ensure*Installed` run on activate.

**Part 4 (budget hook):** removed `buildBudgetBanner` from `ask_user`. New `UserPromptSubmit` hook: `~/.askaway/hooks/budget-gate.sh` → `budget-inject.js` reads sentinels `turn-budget-aiu` + `workspace-storage-root`, scans newest `main.jsonl`, sums `copilotUsageNanoAiu` since last `user_message`, emits `hookSpecificOutput.additionalContext` = `Turn budget: X/Y AIU (Z%) — over budget|be frugal(≥75%)|on track` + frugality directive. Installed by `ensureBudgetHookInstalled()` into `~/.claude/settings.json` (`hooks.UserPromptSubmit`) + `~/.copilot/hooks/budget-inject.json` (best-effort; Copilot UserPromptSubmit/additionalContext support unverified — no-ops if unsupported / no budget). Sentinels written on activate + setting change.

**Proof:** `tsc --noEmit` EXIT=0; `node --check` webview OK; package.json valid JSON; extracted budget-inject.js syntax OK; Build complete; DEPLOYED OK; media copied. Reload window; the budget hook installs on next activation.

## 2026-07-06 IST — Budget push banner + per-request clickable input breakdown

**Requests (user):** (1) inject live turn budget into every agent cycle (spent-this-turn / total + 2-word status) when a soft budget is configured — combine setting + system-prompt one-liner + tool; (2) make EVERY request row clickable/expandable (collapsed by default) to reveal its own input split (system prompt tokens, tools tokens, skills header count, messages count/size); tools stay a single merged left-aligned expandable cell.

**What changed:**
- **Budget push banner (`tools.ts`):** new `buildBudgetBanner(context)` — when `askaway.turnBudgetAiu > 0`, computes turn spend via `computeTurnSpend` and returns `Turn budget: X/Y AIU (Z%) — <status>` where status is `over budget` / `be frugal` (≥75%) / `on track`, plus a one-line "honor this soft budget, avoid unnecessary exploration" directive. Appended to the `ask_user` tool result's `next` instructions, so the agent sees live budget on (nearly) every cycle. This is the feasible "push" injection point — AskAway cannot modify Copilot's own per-request system prompt, but `ask_user` is its per-cycle channel. Together with the setting + `turn_budget` pull tool this is the soft-limit trio. Advisory only.
- **Per-request split (`webviewProvider.ts`):** `_computeInputSplit` now runs for EVERY turn request (removed first-only gate) and is enriched — `{systemTokens, toolsTokens, historyTokens, userTokens, totalInputTokens, skillsCount, toolsCount, messageCount, cachedTokens}`. Reads debug sidecars `systemPromptFile` (counts `<skill>` for skillsCount) and `toolsFile` (JSON array length for toolsCount) via `_readSidecarStats` with a path-keyed cache (`_splitFileCache`, cleared >200) so repeated sidecars aren't re-read. `inputMessages` → messageCount + historyTokens; `userRequest` → userTokens.
- **UI (`webview.js`):** LLM request rows are now `.obs-clickable` with a caret; each has a hidden `.obs-detail-row` (colspan 7) rendered by `renderSplitDetail()` (stacked System/Tools/History bar + line items: System prompt N tok / K skills, Tool definitions N tok / M tools, Conversation history N tok / P messages, Latest user message, Cached). A single delegated click handler on the tbody toggles the detail row; open request rows AND open tool `<details>` are both preserved across the 2s re-render (open-id capture from `details[open]` + `tr.obs-detail-row.obs-open`). Tool rows unchanged (merged left-aligned expandable cell). This also surfaces the first user-submission request as a proper expandable row.
- **CSS:** replaced the old always-on split sub-row styles with `.obs-detail-row`, `.obs-clickable`/hover, `.obs-caret` rotate-on-expand, and `.obs-split-line` legend rows.

**Gotcha fixed:** a JSDoc comment `/** … system_prompt_*/tools_* … */` contained `*/` (from `_*/t`) which prematurely closed the comment and broke the whole file's parse (tsc cascade from line 482; language-server `get_errors` missed it). Reworded the comment. Lesson: never put `*/` sequences (e.g. glob paths) inside block comments.

**Proof:** `tsc --noEmit` EXIT=0; `node --check` SYNTAX_OK; Build complete; DEPLOYED OK; media copied. Reload window.

## 2026-07-04 IST — Metrics timeline: flag rows + initial-input breakdown

**Request (user):** highlight tool rows with >1K input; highlight LLM rows with cache miss or >1K output; for the FIRST input of This turn only, show a split of what filled the initial request (system prompt / tool defs / conversation history).

**What changed:**
- **Flag rows** (`.obs-row-flag`, amber tint + left bar): tool events with `inputTokens > 1000`; LLM events with cache miss (<50% hit) OR `outputTokens > 1000` (the offending Output/Hit% cell also goes red).
- **Initial-input split** (first request of the turn only): backend `_computeInputSplit(sessionDir, attrs, inputTokens)` reads the debug-log sidecars `systemPromptFile`/`toolsFile` (est. tokens = file bytes/4) and inline `inputMessages`/`userRequest` lengths → `{systemTokens, toolsTokens, historyTokens, userTokens, totalInputTokens}`. Gated by `_turnFirstSplitDone` (reset in `_resetTurnMetrics`), attached as `TurnRequestEvent.split`. Sanitize mapper carries `split`. UI renders a `renderSplitRow()` sub-row (`.obs-split-row`) under the first LLM row: a stacked bar (System=blue, Tools=purple, History=orange) + legend with latest-user-msg note. Only in This turn (turnEvents), never per-row or in This month.

**Proof:** verified real `llm_request` debug line exposes `systemPromptFile`/`toolsFile`/`inputMessages`/`userRequest`/`requestShape`; sidecars exist in the session folder. `node --check` SYNTAX_OK; `get_errors` clean; Build complete; DEPLOYED OK; media copied. Reload window.

**Turn-budget design Q (answered, not implemented):** recommended appending live budget metadata to the system/context of every request over a tool call — see chat. Deferred per user.

## 2026-07-03 (later 7) IST — Metrics timeline: LLM rows in columns, tools expandable cell

**Request (user):** expand should only be for tools; LLM rows should be a proper table (ID, Model, Credits, Input, Output, Cached, Hit%) in rows/columns; tools should be a single expandable cell; This turn and This month should look consistent.

**What changed:** turn timeline is now a `<table class="observability-table observability-model-table obs-timeline-table">` sharing the month view's styling (consistency). Header: ID / Model·Tool / Credits / Input / Output / Cached / Hit%. LLM events render as normal 7-column `<tr class="obs-event-request">` rows (Hit% goes red via `.obs-cache-risk` when <50%). Tool events render as `<tr class="obs-event-tool">` with a single `<td colspan="7" class="obs-tool-cell">` holding the `<details>` (summary: tool badge, ID+name, ↓in / ↑out tokens, duration; body: Input/Output `<pre>` + status/group). Open tool rows are preserved across the 2s re-render via `data-eid`. `main.css` replaced the flex `.obs-timeline` list styles with `.obs-timeline-table td.obs-tool-cell` (borderless, tinted) while keeping the `.obs-tl-*` details styling.

**Proof:** `node --check media/webview.js` → SYNTAX_OK; Build complete; DEPLOYED OK; webview.js + main.css copied to installed extension. Reload window to load.

## 2026-07-03 (later 6) IST — Metrics timeline: compact expandable rows

**Request (user):** the timeline table was too verbose (full input/output per row causing horizontal scroll). Wanted each event as a compact one-line header (tool/model name, input token size, output token size, time) that expands on click to reveal input/output content, so the table fits in ~25% width without scrolling.

**What changed:** replaced the 6-column `#obs-turn-event-tbody` table with a `<details>`-based list `#obs-turn-event-list` (`.obs-timeline`). Each event is an `<details class="obs-tl-item">`: the `<summary>` shows a kind badge (tool/llm), ID+name, `↓`input-tok, `↑`output-tok, and a trailing metric (duration for tools, AIU for llm; turns red via `.obs-cache-risk` on tool error / <50% cache hit). Expanding shows `<pre>` input and output previews (tool) or a one-line credits/cache meta (llm). Open rows are preserved across the 2s re-render by capturing `details[open]` `data-eid` before rebuild and re-applying `open`. `main.css` adds `.obs-tl-*` styles (flex header, truncating name, wrap/scroll `<pre>`), replacing the old `.obs-preview`/`.obs-event-*` table styles.

**Proof:** `node --check media/webview.js` → SYNTAX_OK; Build complete; DEPLOYED OK; webview.js + main.css copied to installed extension. Reload window to load.

## 2026-07-03 (later 5) IST — Hotfix: all widget tabs broken (webview.js syntax error)

**Request (user):** "i am not able to open any tab from askaway widget." — every tab in the AskAway webview was unresponsive after the prior timeline edits.

**Root cause:** the previous turn's observability patch mis-applied. Its `obs-optimizations` / timeline-table hunk landed inside `createSettingsModal`'s `turnBudgetSection` instead of `createObservabilityTab`, producing orphaned string-concat lines outside any expression (`'<td>' + ... +` fragments after `modalContent.appendChild(...)`), and it deleted the `var autopilotSection = document.createElement('div')` creation lines. Result: `SyntaxError: Invalid left-hand side in assignment` at load, which aborted the whole webview IIFE so no tab handlers ever attached. `tsc`/esbuild did not catch it because they don't parse `media/webview.js`; `node --check` did.

**Fix:** (1) restored `turnBudgetSection` to a clean number-input (`#turn-budget-input`) block and re-added the autopilot section creation lines; (2) moved the `obs-optimizations` RTK/Gradle block back into `createObservabilityTab` above `.obs-view-toggle`; (3) replaced the old `#obs-turn-req-tbody` table with the 6-col `#obs-turn-event-tbody` timeline table in the correct location. No dangling `obs-turn-req-tbody` references remain.

**Proof:** `node --check media/webview.js` → SYNTAX_OK; Build complete; DEPLOYED OK; webview.js + main.css copied to installed extension. Reload window to load the fix.

**Lesson:** always run `node --check` on `media/webview.js` after editing it — the build task's `tsc`/esbuild never parse it, so a syntax error ships silently and disables every tab.

## 2026-07-03 (later 4) IST — Metrics turn timeline + zero-placeholder request cleanup

**Request (user):** remove/explain current-turn request rows like `93807`, `9F067`, `983CF` that show `unknown` model and all zero values; keep RTK/Gradle optimization stats outside the turn/month toggle; add tool calls between LLM requests so it is clear which tool outputs drove the next request and which tools need optimization.

**What changed:** `webviewProvider.ts` now exposes `turnEvents: TurnEvent[]` alongside legacy `turnRequests`. The scanner pushes chronological `request` events for real model calls and `tool` events for Copilot `tool_call` lines since the last user submit. Tool events include stable 5-char IDs, tool name, status, duration, input/output token estimates, input group, and compact input/output previews. All-zero placeholder `llm_request` entries are filtered before they affect the current-turn table/ledger (`model === "unknown"` and input/output/cached/AIU all 0), while any unknown-but-billed/nonzero call still passes through.

**UI:** `webview.js` turn view now renders a timeline table (LLM rows interleaved with tool rows) instead of a request-only table. Request rows show ID/model/AIU/input/output/cache; tool rows show ID/tool/time/input preview/output preview/status+group. RTK and Gradle savings moved into an always-visible `obs-optimizations` block above the turn/month toggle. `main.css` adds timeline row styling and truncates long tool previews.

**Proof:** sample IDs were not present in the persisted `usage-requests` store, consistent with live in-memory placeholder rows. `npx tsc -p ./ --noEmit` clean; Build complete; DEPLOYED OK; webview.js + main.css copied to installed extension. Reload window required to load the updated webview.

## 2026-07-03 (later 3) IST — Per-request turn view (with IDs) + turn_budget tool & soft limit

**Requests (user):** (1) do the request revamp — turn view shows individual requests, month view consolidated; (2) add a tool that reports how much the agent has spent this turn, with a soft limit configurable in the Settings tab that it shouldn't exceed.

**#1 Request revamp (Metrics tab).** Backend (`webviewProvider.ts`): new `TurnRequest` interface + `turnRequests: TurnRequest[]` on `ObservabilityMetrics`; `_turnRequests[]` accumulated in the scan for every llm_request with `ts >= _lastSubmitTs` (capped 500, reset in `_resetTurnMetrics`); each row gets a stable 5-char id `_shortReqId(sid, li)` = `sha256(sid:li).slice(0,5).toUpperCase()`. That same `id` is also written into the master table rows (`usage-requests/*.jsonl`) so the user can say "investigate ABCDE" and I resolve it → sid/li/responseId → full prompt + neighbors. UI (`webview.js` `createObservabilityTab`): a single **This turn ⇄ This month** toggle drives the whole panel. Turn view = a growing per-request table (ID · Model · Credits · Input · Output · Cached · Hit%) + a one-line turn summary + this turn's tool calls. Month view = consolidated totals row (Reqs · Credits · Input · Output · Cached · Hit% · Miss) + per-model + this month's tool calls. Dropped the old 3-row scope table and the separate tool-scope toggle. Tool times in seconds (2dp). RTK/Gradle lines stay outside the toggled views. New CSS: `.obs-view-toggle/.obs-view-btn`, `.obs-req-id`, `.obs-turn-summary`.

**#2 turn_budget tool + soft limit.** New LM tool `turn_budget` (`tools.ts`, declared in `package.json` languageModelTools, toolReferenceName `turnBudget`): returns `{spentAiu, requestCount, softLimitAiu, remainingAiu, usedPct, exceeded, note}`. Spend is computed **independently of the webview** by `computeTurnSpend(context)` — finds the newest debug-log session for this workspace (by `main.jsonl` mtime), finds the last `user_message` ts (turn boundary), and sums `copilotUsageNanoAiu` of llm_requests at/after it. Soft limit = new setting `askaway.turnBudgetAiu` (default 0 = disabled). When exceeded, the tool's `note` advises the agent to wrap up (advisory only — never blocks). Settings tab: a "Turn Budget (AIU)" number input wired through `updateTurnBudgetAiu` message → `_handleUpdateTurnBudgetAiu` → config update; broadcast back via `_updateSettingsUI`.

**Proof:** `npx tsc --noEmit` clean; Build complete; DEPLOYED OK; webview.js + main.css copied. Reload window to load the new bundle + register the `turn_budget` tool manifest.

## 2026-07-03 (later 2) IST — Observability moved to its own "Metrics" tab; tool times in seconds

**Request (user):** move Observability (RTK, Gradle, the requests/credits table, and Memories) into a separate tab; keep the other toggles in Settings.

**What changed:**
- **New tab.** Added a `Metrics` tab button (`data-tab="observability"`) between Agents and Settings, plus `<div class="tab-panel" id="panel-observability"><div id="observability-tab-shell">` in `webviewProvider.ts` HTML. Settings tab title reverted from "Settings and observability" → "Settings".
- **Moved the whole observability block** out of `createSettingsModal()` into a new `createObservabilityTab()` in `webview.js` (built into `observability-tab-shell`): the scope credits table (turn/workspace/month with Hit%/Miss), the `RTK:` and `Gradle:` savings lines, the Debug Details (per-model + tool-call tables + cards), and the Memories list. The observability element-reference caching moved with it (runs after the DOM is built). `createObservabilityTab()` is called in `init()` right after `createSettingsModal()`.
- **Settings keeps its toggles** — Notifications, Copilot Debug Logging, RTK Command Compression, Caveman, Interactive Approvals, Ctrl/Cmd+Enter, Autopilot, Webex, Telegram. (RTK/Gradle *stats* moved to Metrics; the RTK compression *toggle* stays in Settings.)
- **`switchTab()`**: added an `observability` branch that calls `updateObservabilityUI()`; removed the observability refresh from the `settings` branch. Live updates still flow via the metrics broadcast (view-visibility-based polling, not tab-gated), so the tab stays current.
- **Tool times now in seconds** (2-decimal): tool table headers → `avg s / min s / max s`, render converts ms→s via `(ms/1000).toFixed(2)`.
- **Tab bar** made scroll-safe for 5 tabs: `.widget-tabs { overflow-x:auto }` (hidden scrollbar) and tab padding tightened 12px→9px.

**Proof:** `npx tsc --noEmit` clean; Build complete; DEPLOYED OK; webview.js + main.css copied to installed extension. Reload window to load the new bundle.

## 2026-07-03 (later) IST — Credit accuracy fixes (month undercount + turn double-count) + cache-miss analytics

**Issues (user):** (1) July shows 4K credits but is really >11K; (2) current turn shows 2K but Copilot reported 1K. **Enhancements:** cached-tokens status; a cache-miss log with a pointer to a master table + neighbor (prev/next) request context; and cache-miss + cache-ratio columns per turn/workspace/month; plus a question on splitting the generic `read_file`/`run_in_terminal` tools.

**Root cause #1 — month undercount (the `responseId` dedup was wrong):** I had deduped requests by `responseId`, but an agent turn's iterations SHARE one `responseId` while each is a SEPARATE billed model call (verified: a 7-line responseId had nano 50, 6.6, 5.8, 4.4, 5.1, 4.5, 4.4 — non-cumulative distinct charges). Dedup-keep-first collapsed ~1200 billed reqs → ~180 and undercounted ~5×. FIX: `_ingestGlobalDebugLogs` now SUMS every `llm_request` line's `copilotUsageNanoAiu` with NO dedup, folding only from all-workspace debug logs (dropped the usage-requests mirror as a fold source to avoid cross-source double counts; per-file byte cursors already ensure each line is counted once; the additive shard preserves data after logs rotate). Added `GLOBAL_FOLD_VERSION=2` → one-time clean rebuild of `observability-months/_global.json`. Also removed the `summarize*` skip everywhere (compaction/retry calls are billed) so totals match Copilot. **Verified: July = 26,255 AIU / 1,380 reqs (was 4K).**

**Root cause #2 — turn double-count (re-entrant polls):** the 2s observability poll's async scan now takes >2s (heavy global ingest), so overlapping poll executions read the same debug-log bytes twice and double-added to the turn accumulator `_lastRequestMetrics` (which, unlike the ledger, has no per-line dedup). The last big turn is truly **1,070 AIU** (≈Copilot's "1K"); the 2× made it "2K". FIX: added `_observabilityScanning` re-entrancy guard around `_broadcastObservabilityMetrics` — only one scan runs at a time.

**Cached tokens:** now summed per line into every scope (turn/workspace/month + per-model). Displayed as a **Hit%** column (cached ÷ input), flagged red when <50%.

**Cache-miss analytics:** each scope now carries a `cacheMisses` count (requests with cached <50% of input); shown as a **Miss** column for This turn / This workspace / This month. `_recordCacheMissSpike` records now include a `master` pointer `{file: usage-requests/<wsKey>.jsonl, sid, li, responseId}` into the append-only master table, plus `before[]` and `after[]` neighbor summaries (prev/next up to 3 requests: role, model, cacheHitPct, tokens, nano) built from a cross-poll rolling window `_recentReqs` — so a spike can be analysed with its surrounding requests to see why cache broke.

**Tool-splitting question (honest answer):** `read_file`/`run_in_terminal` are Copilot BUILT-IN tools — an extension cannot split/replace them (Copilot owns the tool schema the model sees). What we CAN do: (a) route work to existing specific AskAway tools (`rg_search`, `code_nav`, `gradle`, `bash_task`) via agent instructions, (b) use the PreToolUse hook to intercept/redirect/compress. Telemetry now shows WHERE the generic tools go: `run_in_terminal` leading commands = cd 422, python3 70, grep 56, echo 45, find 40, rtk curl 40, rtk grep 40, ls 34…; `read_file` by ext = .ts 360, .kt 228, .md 145, .txt 119, .js 109, .json 65. So ~96 grep calls could route to `rg_search`; ls/find/cat could get a small custom list/inspect tool if desired. Offered to add targeted tools rather than build speculatively.

**Proof:** `npx tsc --noEmit` clean; Build complete; DEPLOYED OK; webview.js copied. Reload window to load the new bundle. The global month shard auto-rebuilds once via foldVersion bump.

## 2026-07-03 IST — Durable ALL-tool telemetry + loss-proof month credits + gradle 4-min wait cap

**Requests (user, 6):** (1) cap gradle `wait` at 4 min so the tool round-trip returns before the prompt-cache TTL expires (keeps cache warm via polling); (2) log EVERY tool (built-in + custom), not just AskAway's 5 — inputs (for grouping), output token size, time taken; (3) store tool metrics like the request ledger with current-turn vs whole-month scopes; (4) per-tool time averaged + min + max (to spot tools causing cache misses); (5) durable storage — "this data is very important, never lose the data"; (6) responsibly fix the credit-drop bug.

**#1 gradle 4-min wait cap** (`gradleEngine.ts handleGradleWait`): hard-cap `timeoutMs` at 240000ms. When still RUNNING at the cap, returns `waitCapped:true` + a note to call `wait` again — each poll keeps the ~5-min Anthropic prefix cache warm instead of one long blocking wait letting it go cold. Applies to both the plain and `readyPattern` paths.

**#2–#5 tool telemetry (source: Copilot debug-log `tool_call` entries):** Copilot already logs EVERY tool call with `name`, `dur`(ms), `status`, `attrs.args`(input), `attrs.result`(output) — no hook needed. The observability scan loop (`webviewProvider.ts`) now also parses `tool_call` lines and appends them to an **append-only** durable log `usage-tools/<wsKey>.jsonl`. A durable, additive per-workspace tool shard `observability-tools/<wsKey>.json` (persisted byte cursor) aggregates per tool: **calls, avg/min/max ms, output tokens (≈chars/4), errors, and input groups** (`_toolInputGroup`: terminal→leading command word, read→`*.ext`, else query/prompt/default). `_collectToolCallObservability` returns MONTH scope (summed across all workspace shards) + TURN scope (in-memory `_turnToolAgg`, reset each submit). UI (`webview.js`): tool table now shows Tool / Calls / Out tok / avg ms / min ms / max ms / err, with a **this month ⇄ this turn** toggle and a ⚠ cache-risk flag when a tool's max dur ≥ 4 min (risks blowing the cache TTL). CSS `.obs-cache-risk`, `.obs-scope-toggle` added.

**#6 credit-drop ROOT CAUSE + loss-proof fix:** the displayed "This month" total came from `_computeOverallMonth` **rebuilding from the volatile `seen` map** every load — legacy `true` entries were excluded and rotated/migrated entries dropped out, so credits fell (e.g. 11K→2K). Replaced with a **durable additive global month shard** (`observability-months/_global.json`) fed by `_ingestGlobalDebugLogs()`, which folds llm_requests from BOTH comprehensive sources — (a) every workspace's Copilot debug log and (b) our append-only `usage-requests` mirror — deduped by `responseId` (persistent, pruned to current+prev month) via persisted per-file byte cursors. Once a request is counted it is retained forever, even after both underlying sources rotate away → the figure only grows, never drops. Also persist debug-log read offsets (`observability-logoffsets.json`) so a restart never re-appends duplicate rows to the append-only logs.

**Honest data-loss finding:** an earlier scan this session showed July ≈ 19,566 AIU, but Copilot has since **rotated/pruned** most of those session debug logs (July 986→159 reqs on disk) and those requests were never mirrored into our durable store, so they are **unrecoverable** from any local source now. The union of all currently-available local sources = July **4,315 AIU / 888 reqs** (credits identical across sources; the extra requests are 0-AIU tool-loop continuations). From now on the durable global shard captures the union and never loses it. Verified by simulation over the real on-disk logs.

**Proof:** `npx tsc --noEmit` clean; `node esbuild.js` Build complete; DEPLOYED OK; webview.js + main.css copied to installed extension. Reload window required to load the new bundle. Durable stores under `globalStorage/intuitiv.askaway/`: `usage-tools/`, `observability-tools/`, `observability-months/_global.json`, `observability-logoffsets.json`, `observability-global-offsets.json` (all append-only / additive / cursor-guarded).

## 2026-07-02T23:29 IST — Observability refinements: gradle tokens-saved, per-model cachedTokens fix, cache-miss analysis

**Requests (user, 5):** (1) show tokens SAVED by the gradle async design vs the agent reading the whole raw output; (2) per-model breakdown shows cachedTokens=0 — why; (3) unclear how "tasks avoided" is calculated; (4) stop sending `optimizations` in the gradle response (wasted tokens); (5) cache-miss alerts — are we logging, analyse and recommend.

**#4 optimizations removed from gradle response:** `handleGradleStart` no longer returns `optimizations` (kept `run.optimizations` for the gradle-runs.jsonl success-story log only). Comment added explaining why.

**#2 per-model cachedTokens=0 — ROOT CAUSE + fix:** `SeenMeta` stored `{ts,model,nano,in,out}` with NO `cached` field, so every scope derived from SeenMeta (monthly totals + per-model breakdown) accumulated 0 cached. Also `_loadObservabilityLedger` recomputed the workspace `cachedTokens` from `seen` and left it at 0 (never incremented). Fix: added optional `cached` to `SeenMeta`; populate at both write sites (legacy-upgrade + new); accumulate `meta.cached` in `_computeOverallMonth` (totals + per-model) and in the load-recompute. Historical entries lack `cached` (can't recover) — only new requests populate it.

**#1 gradle tokens-saved metric:** `recordGradleRun` now logs `rawOutputTokens = ceil(fullBuildOutputChars/4)` = what the agent would pay if the whole gradle log were dumped into context. `_collectGradleObservability` sums it; new `_gradleWithSavings()` computes `savedTokens = max(0, sum(rawOutputTokens) − gradleToolSentTokens)` where sentTokens comes from the gradle rows in tool-calls.jsonl (compact status + bounded/paginated logs actually returned). Surfaced in Debug Details gradle line: "Gradle: N runs · M optimized · ~X tokens saved · Y tasks cached · Z cfg-cache reuse".

**#3 tasks-avoided clarified + relabelled:** `tasksAvoided = Σ(tasksUpToDate + tasksFromCache)` parsed from `> Task :x UP-TO-DATE` / `FROM-CACHE` lines = tasks Gradle skipped (outputs already cached/unchanged). UI relabelled to "tasks cached" for clarity; de-emphasised behind the new tokens-saved headline.

**#5 cache-miss analysis (1765 spikes in cache-miss-spikes.jsonl):** Logging IS working. Findings: avg cache hit only **3.1%**; 1553/1765 spikes in the 0–10% bucket; Σ input = 182.9M tokens vs Σ cached = 5.7M (~97% billed uncached). By model: opus-4.8=536, sonnet-4.6=388, gpt-5.3-codex=323, gpt-5.5=308, others fewer. Top spikes ~300K input at 0% hit on opus-4.8. Span Jun 19 – Jul 2. Strong signals: heavy model switching (8 models — each has its own cache; every switch = cold cache) and/or an unstable prompt prefix (volatile early tokens invalidate the cached suffix). Recommendation to user: keep the system/instruction prefix stable, move volatile content to the END, reduce mid-session model switching, and surface a cache-efficiency aggregate in the UI.

**Proof:** `npx tsc --noEmit` clean; `node esbuild.js` Build complete; DEPLOYED OK; webview.js copied manually to installed extension. Reload window required to load new bundle.

## 2026-07-02 IST — Gradle → portable MCP tool (fully tested) + credits-drop diagnosis

**Request 1 (user):** "Don't register gradle as an LM tool. Do it as an MCP tool… I built this so I can make optimisations; if it's taking a shortcut I wouldn't get my benefits. Make sure the gradle tool is usable outside VS Code too. And I want all commands tested — start, track, get logs, get errors, all."

**What changed:**
- **New VS Code-free engine** `tasksync-chat/src/gradle/gradleEngine.ts` — ZERO `vscode` imports (only `child_process`/`fs`/`path`), so it runs in any Node host (MCP server, CLI, CI, tests). Exports `dispatchGradle(input, root=process.cwd())`, `findGradlew(startDir)`, `killAllGradleRuns()`. Async model: `start` spawns `./gradlew --console=plain --stacktrace` (env `TERM=dumb`, `GRADLE_OPTS`, caller `env` merged) and returns `{buildId, state:RUNNING}` immediately; `status`/`wait`/`stop`/`logs` operate by buildId. Parses `> Task :x` lines for `completedTasks`/`runningTasks`/`failedTasks`; on FAILED/TIMEOUT extracts `whatWentWrong`, `exception` (Caused by chain), `errors` (java/kotlin compiler), `testFailures`, `exitCode`. Run registry with pruning (max 20 runs, 30-min retain, 4 MB buffer cap, 30-min safety timeout).
- **Registered as MCP tool `gradle`** in `src/mcp/mcpServer.ts` (full zod schema: action enum start/status/stop/logs/wait, tasks[], arguments[], projectDir, offline, env, timeoutMs, buildId, task, tail). Handler returns `{content:[{type:'text',text:JSON.stringify(result,null,2)}]}`. Because it's MCP-over-HTTP (port 3579, auto-registers with Kiro + Antigravity/Gemini), it is now usable **outside** VS Code — no LM-tool abstraction/shortcut.
- **Removed the LM-tool version:** deleted the old in-tools gradle engine + LM registration from `src/tools.ts`, the `gradle` entry from `package.json` `languageModelTools`, and wired `killAllGradleRuns()` into `extension.ts` `deactivate()`.

**Testing (all commands):** standalone `tasksync-chat/test-gradle-engine.cjs` against a real large Kotlin/Java project (`model-calculation-service-app-logic`, JAVA_HOME corretto-17). 21 assertions across 4 scenarios: error paths (unknown buildId, missing gradlew), start→stop→CANCELLED, start→live status tracking→wait→full+task-filtered logs (SUCCESS `help`), and failure→error extraction (bogus task → FAILED). **Final run: 21 passed, 0 failed (EXIT=0).**

**Two REAL parser bugs found by the test and fixed (not timing artifacts):**
1. Executed tasks print a bare `> Task :help` with no marker; old `parseRunStatus` only counted tasks with terminal markers (UP-TO-DATE/SKIPPED/…) as completed, so it reported `:help` as still *running* after `BUILD SUCCESSFUL`. Fixed: pass `isTerminal`; a bare last task is "running" only while RUNNING, otherwise completed (`completed=1` now correct).
2. `extractTaskLogs` sliced the last `tail` lines and dropped the `> Task :x` header when task output exceeded `tail`. Fixed: always retain the header + tail of the body.

**Request 2 (user):** "'This month' credits suddenly got reduced. Is there a bug?" — **Diagnosed, NOT an ongoing bug.** Two causes: (a) the earlier double-count de-dup fix corrected an inflated ~9696 AIU down to the real ~5143 AIU; (b) 88 legacy ledger entries (~4553 AIU in the `bc6ff…` workspace) are stored as the old boolean `true` form with no timestamp, so `_computeOverallMonth()` correctly can't bucket them into a month — and their source Copilot debug logs have rotated away, so a re-scan can't upgrade them. Current build always writes timestamped SeenMeta objects, so new usage counts correctly. No fabricated timestamps added.

**Proof:** `tsc --noEmit` clean; engine compiled standalone (`.gradle-test-build/`); lifecycle test 21/21 pass EXIT=0; `Build complete` + `DEPLOYED OK` (extension.js + package.json copied to installed extension).

**Follow-up (same day):** Removed the stale `intuitiv.askaway/gradle` reference from the `tools:` list in the installed `askaway-build.agent.md` (self-heal preserves user copies, so it won't be re-added). Agent tool list is now just ask_user / bash_task / research_on / code_nav / rg_search. **Validated the tool against the user's real task** `:service:test --tests ForgePipelineIntegrationTest` on `model-calculation-service-app-logic` via `run-gradle-tool.cjs` (same `dispatchGradle` engine the MCP tool wraps): start→buildId, live status tracking (`completedTasks` 0→27, `runningTasks` surfaced `:service:test` then `:service:jacocoTestReport` in real time), wait→`SUCCESS exitCode 0` in 247s, task-filtered + full logs both work → **BUILD SUCCESSFUL, ForgePipelineIntegrationTest passed**.

**Follow-up 2 (same day) — failure-path hardening + auto speed:**
- **Auto-optimization ("agent just names the task, tool handles speed"):** `buildGradleSpawnArgs` now auto-applies `--daemon --parallel --build-cache --configuration-cache --configuration-cache-problems=warn` on every run. Each flag is skipped if the caller passed it or its `--no-` opposite; `optimize:false` disables all. The applied set is echoed in the start response as `optimizations`. Verified live: config-cache degraded gracefully ("Configuration cache entry stored with 10 problems", build did not crash) and is now reused on subsequent runs.
- **Failed-task name for log queries:** `runToStatus` FAILED branch now merges `> Task :x FAILED` markers with tasks named in `Execution failed for task ':x'` messages into `failedTasks`, and adds `failedTaskLogsHint` (a ready-to-run `gradle {action:"logs", buildId, task:":x"}`) so the agent always knows which task's logs to pull.
- **JUnit report enrichment:** new `extractTestReportFailures(cwd, failedTasks)` reads `<module>/build/test-results/<task>/TEST-*.xml` for failed test-style tasks and returns `testFailureDetails: {test, className, message, location}` — the real assertion message + source line that Gradle's console omits. Verified end-to-end by injecting a deliberate `assertEquals(999, result.refs.size, "INTENTIONAL_ASKAWAY_FAILURE…")` into ForgePipelineIntegrationTest, running through the tool → `state:FAILED, exitCode:1, failedTasks:[":service:test"], testFailures:["…fresh rule…() FAILED"]`, and the parser extracted `message: "…expected: <999> but was: <3>"`, `location: "ForgePipelineIntegrationTest.kt:180"`. **Test change was then reverted** (git diff clean, confirmed). MCP tool description + `optimize` param updated in mcpServer.ts.

**Proof (follow-up 2):** `tsc --noEmit` clean; engine recompiled; failing run EXIT=1 with correct failure fields; JUnit parser validated against the on-disk report; `Build complete` + `DEPLOYED OK`; ForgePipelineIntegrationTest.kt restored to HEAD.

**Follow-up 3 (same day) — running-server / pagination / richer failures (answering user design Qs):**
- **Paginated logs (for ongoing tasks/servers):** `action=logs` now returns `{fromLine,toLine,totalLines,nextFromLine,hasMore}`. Omit `fromLine` → tail (`tail` lines). Pass `fromLine` (0-based) + `maxLines` (default 200) → forward paging; feed `nextFromLine` back as the cursor to stream a never-terminating task. Refactored `extractTaskLogs`→`collectLogLines` (returns full line array; slicing decided by handler). Verified live: cursor 0→5→10→15, totalLines=56, tail from=46→56 hasMore=false.
- **Server-ready detection (opt-in, non-fragile by design):** `action=wait` accepts `readyPattern` (regex). Returns early `ready:true` when the pattern appears in output even though the task keeps RUNNING (server/--continuous); else terminal state or timeout with `ready:false`. Caller-supplied so the tool never hardcodes framework-specific banners. Verified live: `readyPattern:'Welcome to Gradle'` returned `ready:true, state:RUNNING` at 63s, build later SUCCESS.
- **Full stack trace in failures:** `testFailureDetails[]` gained a `stack` field (exception line + non-framework frames, capped ~2500 chars). Verified: message `…expected: <999> but was: <3>`, location `ForgePipelineIntegrationTest.kt:180`, stack shows app frames at :180 and :172, JUnit/coroutine/java.base noise stripped.
- **Non-test task failures:** confirmed uniform handling — `failedTasks` captures ANY task via `> Task :x FAILED` + `Execution failed for task ':x'`; compiler errors surface in `errors` (`e: File.kt:..` / `error:`); `failedTaskLogsHint` points the agent to the right task's logs. `testFailureDetails` only populates for test-type tasks (reads JUnit XML).
- **Descriptions:** rewrote the `gradle` MCP tool description + all param `.describe()`s to spell out per-action returns (failure fields, pagination cursor, readyPattern). New GradleInput fields: `fromLine`, `maxLines`, `readyPattern`. New test harness `test-gradle-pagination.cjs`.

**Proof (follow-up 3):** `tsc --noEmit` clean; engine recompiled; stack extraction + live pagination + live readyPattern all validated (EXIT=0); `Build complete` + `DEPLOYED OK`.

**Follow-up 4 (same day) — "gradle not visible in other workspaces" root cause + fix:**
- **Root cause:** gradle is now MCP-only, but AskAway's MCP server was wired ONLY to external clients (`~/.kiro/settings/mcp.json`, `~/.gemini/antigravity/mcp_config.json`) — never to VS Code's OWN MCP client. So VS Code Copilot chat had no path to the gradle tool in any workspace. The workspace that still "showed" gradle was a VS Code window opened BEFORE the redeploy: extensions don't hot-reload on file copy, so that window kept the old in-memory bundle (with the removed gradle LM tool), while newly-opened windows loaded the new bundle (LM tool gone, no VS Code MCP bridge) → gradle absent. Also the server only auto-started when an external client was detected.
- **Fix:** registered AskAway's HTTP MCP server with VS Code natively via `vscode.lm.registerMcpServerDefinitionProvider('askaway-mcp', …)` returning a `McpHttpServerDefinition('AskAway', http://127.0.0.1:<port>/message)`; added the `contributes.mcpServerDefinitionProviders` entry (id `askaway-mcp`) and bumped `engines.vscode` → `^1.101.0` (API/contribution requires ≥1.101). Provider starts the server on demand (`provideMcpServerDefinitions` awaits `mcpServer.start()` if not running) and exposes `getPort()`; a module-level `mcpDefsChanged` EventEmitter fires after start so VS Code re-queries. API accessed via `(vscode as any)` since `@types/vscode` is still 1.90. Now the gradle tool (and other AskAway MCP tools) surface in VS Code Copilot chat in EVERY workspace where AskAway is active, staying MCP (no LM-tool re-add). Per-window isolation preserved (each window binds 3579 or a dynamic fallback and registers its own port).
- **User action needed:** reload each VS Code window; the "AskAway" MCP server + its `gradle` tool then appear in the Copilot tools/MCP picker (may need a one-time enable/trust).

**Proof (follow-up 4):** `tsc --noEmit` clean; `Build complete` + `DEPLOYED OK`; deployed `dist/extension.js` contains `registerMcpServerDefinitionProvider` (1) + `McpHttpServerDefinition` (1); installed `package.json` has the `askaway-mcp` provider contribution.

**Follow-up 5 (same day) — "make gradle same as other tools":** User noticed gradle was the only tool needing the MCP bridge (all others are LM tools, auto-visible everywhere) and asked to make it consistent.
- **Added gradle as an LM tool** in `src/tools.ts` (registered at end of `registerTools`, mirrors rg_search/code_nav) + full manifest entry in `package.json` `languageModelTools` (name `gradle`, toolReferenceName `gradle`, complete inputSchema: action enum, tasks, arguments, projectDir, offline, optimize, env, timeoutMs, buildId, task, tail, fromLine, maxLines, readyPattern). The LM `invoke` forwards to the SAME shared `dispatchGradle(input, workspaceRoot)` engine — no duplicated logic, no shortcut. Now gradle behaves exactly like ask_user/bash_task: auto-visible in every VS Code workspace, no reload/enable dance.
- **Reverted the VS Code MCP bridge** from follow-up 4 (it would otherwise show DUPLICATE tools in VS Code since it exposes the whole MCP server incl. ask_user): removed `registerMcpServerDefinitionProvider` block + `mcpDefsChanged` emitter from `extension.ts`, removed `contributes.mcpServerDefinitionProviders` from `package.json`, reverted `engines.vscode` → `^1.90.0`. (`McpServerManager.getPort()` left in place, harmless.)
- **Kept the MCP `gradle` tool** in `mcpServer.ts` + `autoRegisterMcp` (Kiro/Antigravity) untouched — external/CLI portability preserved, invisible to VS Code, so no duplication. Net: gradle is dual-surfaced (LM for VS Code, MCP for outside) via one engine.

**Proof (follow-up 5):** `tsc --noEmit` clean; `Build complete` + `DEPLOYED OK`; deployed `package.json` languageModelTools = `ask_user, bash_task, research_on, code_nav, rg_search, gradle`, `mcpServerDefinitionProviders` absent, `engines.vscode ^1.90.0`; deployed `dist/extension.js` has 0 bridge refs + gradle LM registration present.

**Follow-up 6 (same day) — observability: cache-miss status + gradle "success story" + tool-call logging:**
- **Cache-miss logging (Q: "what happened to it?")** — still fully active. `_recordCacheMissSpike()` writes every request with <50% cache hit to `~/.askaway/cache-miss-spikes.jsonl`; confirmed **1493 entries** (latest = 14% hit on claude-opus-4.8, 144K input / 20K cached). It's silent (file only, no UI alert) — that's by design for offline analysis.
- **Gradle optimizations as a success story (like RTK)** — NEW. `recordGradleRun()` in `gradleEngine.ts` appends every finished run to `~/.askaway/gradle-runs.jsonl`: `{ts, tasks, optimizations[], state, exitCode, elapsedSec, tasksUpToDate, tasksFromCache, tasksExecuted, configCacheReused}`. Aggregated by `_collectGradleObservability()` (runs / optimizedRuns / tasksAvoided / configCacheReuses) and shown as a "Gradle: N runs · N optimized · N tasks avoided" line in the webview, mirroring the RTK line. Verified live: `help` run wrote a correct record (optimizations = daemon/parallel/build-cache/configuration-cache, SUCCESS, tasksExecuted 1).
- **Tool-call count + output token size (Q: "log all tool calls…for optimisation")** — NEW. `logToolCall()` in `tools.ts` appends `{ts, tool, detail, outputChars, approxTokens=ceil(chars/4)}` to `~/.askaway/tool-calls.jsonl` on the success return of gradle/rg_search/code_nav/bash_task/research_on (ask_user skipped — tiny interactive output). Aggregated by `_collectToolCallObservability()` (per-tool calls + approx output tokens, sorted desc) and rendered as a "Tool calls" table in Debug Details.
- **Q: "Sonnet data resets every conversation, only 10 requests" — diagnosis (not a bug):** that's the **"This turn"** row, which by design resets on every user submit (`_resetTurnMetrics()` fires on each `user_message` log line) — so within a conversation every message resets it, and "10 requests" = that turn's model-call count. The persistent scopes do NOT reset: **"This workspace (all-time)"** and **"This month (all WS)"** + the per-model monthly breakdown in Debug Details. If a per-conversation (multi-turn) accumulator is wanted, that's a new scope to add — offered, not built.
- Wired `gradle` + `toolCalls` into `ObservabilityMetrics`, both payload branches, `emptyMetrics`, cache init, and webview.js (sanitize + init + render). `_tailJsonl()` helper bounds memory (gradle 5000 / tool-calls 20000 last lines).

**Proof (follow-up 6):** `tsc --noEmit` clean; `Build complete` + `DEPLOYED OK`; `media/webview.js` copied to installed extension; `~/.askaway/gradle-runs.jsonl` record verified end-to-end; cache-miss log confirmed at 1493 entries.

---

## 2026-07-01 22:50 IST — Fixed extension-host crash loop + "This turn" credit reset

**Problem 1 (user):** Extension host terminated 3 times in a crash loop.

**Root cause (proven via CPU profile + renderer.log):**
- `WebviewProvider._collectObservabilityMetrics()` ran every **1000ms** and re-read + JSON-parsed the ENTIRE Copilot debug JSONL (11k+ lines this session), computing a SHA-256 per `llm_request` line. CPU profile showed `_collectObservabilityMetrics` at 1197 hits and the host flagged `intuitiv.askaway took 47.47% of 471ms` → unresponsive → host killed → restart loop (3x then VS Code gives up).
- `media/notification.wav` was **missing** from the extension; the webview `<audio preload="auto">` threw `Webview.loadLocalResource - Error using fileReader` on every host start.

**Fix applied:**
1. Generated `media/notification.wav` (4.4 KB, 440 Hz 0.1s beep) and deployed it.
2. `_collectObservabilityMetrics` now does **incremental reads** — tracks `{byteOffset, lineCount}` per log file in `_logFileReadOffsets`, opens with `fs.open` and reads only new bytes since last poll. Incremental (new) lines skip the SHA-256 dedup check entirely (`recordKey = sid:lineIndex:new`); only the first full read after restart uses hash keys.
3. Poll interval raised 1000ms → **2000ms** (`_OBSERVABILITY_POLL_MS`).

**Problem 2 (user):** "This turn" credits reset after every llm request (regression from the incremental-read change).

**Root cause:** The turn total was recomputed each poll into a fresh local `turnSum` by summing all llm_requests with `ts >= _lastSubmitTs` from a full-file scan. After switching to incremental reads, each poll only saw the newly-appended lines, so `turnSum` reset to just those.

**Fix applied:** Accumulate turn metrics **in-place** into the persistent `this._lastRequestMetrics` field during the scan (reset to empty only at turn boundaries via `_resetTurnMetrics()` — user submit / `user_message` log line). Removed the local `turnSum` and the end-of-scan `_lastRequestMetrics = turnSum` reassignment. `_deriveLastRequest()` still returns a copy of the field.

**Files:** `tasksync-chat/src/webview/webviewProvider.ts`, `tasksync-chat/media/notification.wav`. Compiled clean (`tsc --noEmit`), bundled, deployed to installed extension. Requires "Developer: Restart Extension Host" to apply.

## 2026-07-01 12:25:47 IST — Root-caused & fixed "RTK hook not working"

**Problem (user):** RTK hook worked intermittently; ~300 rtk calls over days despite hooks firing constantly. "If it is a hook, it should be used for every tool."

**Root cause (proven):**
- VS Code Copilot reads its native PreToolUse hook config from `~/.copilot/hooks/rtk-rewrite.json` — NOT `~/.claude/settings.json` (that file is Claude Code CLI only). Confirmed via debug-log `type:"hook"` spans whose `attrs.command` = `rtk hook copilot` (a string that exists only in the `.copilot` config, shipped by rtk).
- That config had no matcher, so the hook fired for EVERY tool (1142x this session — normal), but it invoked `rtk hook copilot`, which in rtk v0.42.4 is a **no-op** (returns empty for every payload: simple, terminal, and file). So nothing was ever rewritten by the Copilot-native hook.
- `rtk hook claude` DOES rewrite correctly (git status→rtk git status, npm run build→rtk npm run build, cat foo→rtk read foo) and emits the `hookSpecificOutput.updatedInput` shape Copilot consumes.

**Fix applied:**
1. Live config `~/.copilot/hooks/rtk-rewrite.json` re-pointed from `rtk hook copilot` → `/Users/machs/.askaway/hooks/rtk-gate.sh` (absolute) in both `PreToolUse.command` and `preToolUse.bash`/`powershell`. Gate delegates to `rtk hook claude` and honors the `~/.askaway-rtk-enabled` sentinel toggle. Original backed up as `rtk-rewrite.json.bak-*`.
2. `tasksync-chat/src/extension.ts`: added `ensureCopilotHookInstalled()` (called on activation) that self-heals this config — rewrites any `rtk hook copilot` value to the gate abspath, creates the file if missing. So future installs/updates keep RTK working in VS Code Copilot.

**Also shipped in this build (pending from earlier):**
- webviewProvider.ts turn-metrics reset now keys off `user_message` (real user submit) instead of `turn_start` (fires per agent iteration), fixing "This turn" resetting on every llm request.

**Proof:** `npx tsc --noEmit` clean; `node esbuild.js` Build complete; deployed to `~/.vscode/extensions/intuitiv.askaway-1.0.35/dist/extension.js` (marker `Routed Copilot native hook through AskAway RTK gate` present). Gate end-to-end test: Copilot-shape `git status` payload → `{"hookSpecificOutput":{...,"updatedInput":{"command":"rtk git status",...}}}`.

**Action for user:** Reload VS Code window / start a fresh chat so Copilot re-reads `~/.copilot/hooks/rtk-rewrite.json`. RTK rewriting will then apply to every eligible terminal command consistently.

---

## 2026-07-01 13:00 IST — Added code_nav + rg_search tools

**code_nav**: Renamed AskAway's `lsp_bridge` to `code_nav` (avoids silent collision with VS Code Copilot's built-in `lsp_bridge`). Supports: definition, references, implementation, type_definition, hover, document_symbols, workspace_symbols, diagnostics. Registered in tools.ts + package.json.

**rg_search**: New ripgrep LM tool. Parameters: `pattern` (required), `path`, `fileType` (e.g. "ts,js"), `caseSensitive`, `wholeWord`, `contextLines` (default 2), `maxResults` (default 50), `includeGlob`, `excludeGlob`. Detects rg from PATH or VS Code's bundled `@vscode/ripgrep-universal` binary. Returns structured results with file, line numbers, match context.

**RTK intercept clarification**: Hook fires for every tool (1142x/session, no matcher). RTK only rewrites tools with a shell `command` field: `run_in_terminal` ✅ `send_to_terminal` ✅. `create_and_run_task` nested `task.command` → ❌ RTK limitation. Non-shell tools (read_file, grep_search, etc.) → correctly pass through. The ~300 RTK rewrites = ~300 real terminal commands, which is honest.

**Proof:** tsc clean, Build complete, deployed extension.js + package.json.

---

## 2026-07-01 ~19:00 IST — Crash triage + code_nav-for-reads guidance + gradle_build tool

**Crash loop "Extension host terminated unexpectedly 3 times" — NOT AskAway.**
- exthost.log stack: `TypeError: e is not iterable` at `m8e.setItems → gp._computeFn/_recompute/get/reportChanges/endUpdate → tS.init → Timeout._onTimeout`, all inside the **bundled** GitHub Copilot completions extension (`/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/dist/extension.js`), VS Code 1.126.0. A derived observable recomputed on a startup timer and iterated a completion-model list that came back non-iterable (undefined) — a startup race in Copilot's completion-model init, not our code.
- AskAway activated cleanly every restart ("Activation complete!", zero errors). Fired 5× (18:20–18:24), VS Code hit its restart cap → banner, then self-recovered; no recurrence for 3+ hrs. Guidance: reload window if it recurs; if it loops, toggle `github.copilot.nextEditSuggestions.enabled` or update VS Code. Did NOT touch Copilot global state.

**Agent guidance — code_nav for file reads:** Updated `ASKWAY_BUILD_AGENT_CONTENT` "Search & Navigation Discipline" — read/understand a file by starting with `code_nav` `document_symbols` (outline + line ranges), then a targeted ranged read, instead of dumping whole files. Honest boundary noted: code_nav returns structure/ranges, not raw source text.

**gradle_build tool (new):** Delegated Gradle runner that returns a COMPACT digest instead of the full log. Finds `./gradlew` by walking up from `projectDir`/workspace root; runs with `--console=plain --stacktrace` (env `TERM=dumb`). `summarizeGradleOutput()` extracts: BUILD SUCCESSFUL/FAILED + duration + exit; failing `> Task :x FAILED`; Gradle `* What went wrong:` blocks; java/kotlin compiler errors; `Class > testCase FAILED`; `Caused by:` chain; warning/deprecation count; on success a task exec/up-to-date/from-cache summary; failure appends a de-noised log tail. Output capped (8KB, or 20KB with `fullLog`). Params: `tasks` (default "build"), `projectDir`, `args`, `offline`, `timeoutMs` (10s–30min, default 5min), `fullLog`. Supports cancellation + timeout SIGKILL, 5MB capture cap. Registered in tools.ts + package.json (`gradleBuild` ref name) with a run-confirmation prompt. Agent Implementation Discipline updated to prefer it over terminal gradle.

**Re "is there a Gradle MCP?":** No official Gradle MCP server. Rather than depend on an external/community MCP, this built-in AskAway tool wraps the wrapper directly and does the failure summarization/log-filtering in-process — keeps heavy output out of the model context (token-billing friendly) and needs no extra install.

**Proof:** `npx tsc --noEmit` clean; `node esbuild.js` Build complete; deployed to `~/.vscode/extensions/intuitiv.askaway-1.0.35/` — `gradle_build` present 2× in bundle, 1× in package.json.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CONFIG_NAMESPACE, OUTPUT_CHANNEL_NAME, MCP_SERVER_NAME } from './constants/branding';
import { AskAwayWebviewProvider } from './webview/webviewProvider';
import { registerTools } from './tools';
import { McpServerManager } from './mcp/mcpServer';
import { killAllGradleRuns } from './gradle/gradleEngine';
import { ContextManager } from './context';
import { PlanEditorProvider } from './plan/planEditorProvider';
import { COWORK_BUNDLE_B64, COWORK_APPLY_B64, COWORK_PROMPT_B64 } from './cowork/coworkAssets';

// Heavy modules loaded lazily to avoid blocking activation
// RemoteUiServer imports express + socket.io (expensive)
// WebexService, TelegramService do network/config I/O
type RemoteUiServerType = import('./server/remoteUiServer').RemoteUiServer;
type RemoteMessageType = import('./server/remoteUiServer').RemoteMessage;
type WebexServiceType = import('./services/webexService').WebexService;
type TelegramServiceType = import('./services/telegramService').TelegramService;

let mcpServer: McpServerManager | undefined;
let webviewProvider: AskAwayWebviewProvider | undefined;
let contextManager: ContextManager | undefined;
let remoteServer: RemoteUiServerType | undefined;
let remoteOutputChannel: vscode.OutputChannel | undefined;
let planEditor: PlanEditorProvider | undefined;
let telegramServiceInstance: TelegramServiceType | undefined;
let activationOutputChannel: vscode.OutputChannel | undefined;

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
    }
    return String(error);
}

function logRuntime(message: string, details?: unknown): void {
    const timestamp = new Date().toISOString();
    const suffix = details !== undefined
        ? ` ${typeof details === 'string' ? details : JSON.stringify(details)}`
        : '';
    activationOutputChannel?.appendLine(`[${timestamp}] AskAway Runtime: ${message}${suffix}`);
}

const ASKWAY_BUILD_AGENT_FILE = 'askaway-build.agent.md';
const ASKWAY_BUILD_AGENT_CONTENT = `---
description: "Use when: acting as the main AskAway build agent, orchestrating implementation work, RTK command optimization, observability fixes, builds, tests, and production-readiness tasks."
name: "AskAway Build"
tools: [vscode/extensions, vscode/memory, vscode/newWorkspace, vscode/resolveMemoryFileUri, vscode/runCommand, vscode/toolSearch, execute, read, agent, edit, search, todo]
user-invocable: true
---

You are the main AskAway Build Agent. Your job is to orchestrate implementation work with strong token discipline, accurate observability, and safe delegation.

**At the end of conversation update AGENT_AUDIT.md with summary of work done, so that i can review in future. Template is timestamp  followed by summary.**

## Core Role
- Act as the primary build/orchestration agent for AskAway work.
- Plan briefly, execute decisively, verify changes, and report concise proof.
- Keep user-facing responses short, direct, and evidence-based.

## RTK Policy
- Resolve RTK mode once at session start: if \`~/.askaway-rtk-enabled\` exists, set RTK mode on for this chat session.
- RTK must apply to regular agent command tools, not only delegated worker tools.
- Use regular command-capable tools as needed. While VS Code-side interception is being validated, explicitly pass \`rtk \`-prefixed simple commands in command parameters.
- RTK command parameters discovered so far: \`execute/runInTerminal.command\`, \`execute/sendToTerminal.command\`, and \`execute/createAndRunTask.task.command\`.
- If a command parameter already starts with \`rtk \`, do not add another prefix.
- Do not prepend \`rtk \` to an entire compound command such as \`cmd1 && cmd2\`, \`cmd1 | cmd2\`, or commands using redirects/subshells. Split compound commands into separate tool calls and wrap each eligible simple command independently.
- While command-tool discovery is active, use the temporary LM tool catalog dump and PreToolUse parameter logger to identify command-capable tools and their command parameter names.
- Do not perform a runtime file check before each command; treat RTK mode as a design-time/session-start decision.
- If RTK is toggled during a chat, restart the agent session so RTK mode is re-evaluated.
- Keep commands simple (avoid unnecessary pipes or chaining) so RTK can compress output effectively.
- Never count RTK saved tokens as Copilot credits. RTK savings come from \`rtk gain\`; Copilot credits come from Copilot log \`copilotUsageNanoAiu\`.

## Observability Rules
- Observability must be per workspace. Never aggregate logs across unrelated VS Code workspaceStorage folders.
- Credit totals must be recomputed from all readable current-workspace Copilot \`main.jsonl\` files, not a rolling window.
- Skip malformed/corrupt JSONL lines; continue counting valid lines.
- Credit display is local aggregation of Copilot log \`copilotUsageNanoAiu\`, divided by \`1_000_000_000\` for AIU.
- RTK token savings are separate and should be shown from \`rtk gain --daily --format json\`.

## Memory Discipline
- Use the built-in \`memory\` tool (\`vscode/memory\`) to read and write durable notes across sessions.
- At session start, \`view\` the \`/memories/\` directory and read \`/memories/_index.md\` (if present).
- **WRITE AFTER substantial work**: persist key facts, verified commands, and architecture decisions. Keep notes concise.
- If you skip a memory read or write, state why explicitly.

## Implementation Discipline
- Preserve user changes. Do not revert unrelated files.
- Keep edits narrow and consistent with existing code style.
- Compile/build after TypeScript changes.
- Deploy AskAway locally by copying the built bundle to \`~/.vscode/extensions/intuitiv.askaway-1.0.35/dist/extension.js\` when requested or when validating installed behavior.
- **Gradle builds/tests → use the \`gradle\` tool, never the terminal.**
  - \`action:start\` with \`tasks\`, \`arguments\`, \`projectDir\`, \`env\` (e.g. \`{"JAVA_HOME":"/path/to/jdk"}\`) → returns \`{buildId}\` immediately.
  - Poll \`action:status\` for live state (\`RUNNING/SUCCESS/FAILED\`). On FAILED the response includes \`failedTasks\`, \`whatWentWrong\`, \`exception[]\`, \`errors[]\`, \`testFailures[]\`, \`exitCode\`.
  - \`action:wait\` to block until done (set \`timeoutMs\` if needed).
  - \`action:logs\` with optional \`task\` filter (e.g. \`":service:test"\`) for per-task output.
  - \`action:stop\` to kill a running build.
  - Example: \`env JAVA_HOME=/path/jdk ./gradlew :service:test --tests '*.Foo' --no-daemon\` maps to:
    \`{ action:"start", tasks:[":service:test"], arguments:["--tests","*.Foo","--no-daemon"], env:{"JAVA_HOME":"/path/jdk"} }\`
- Record meaningful proof: compile result, bundle marker, RTK gain output, or relevant log source.

## Search & Navigation Discipline
- **Text/pattern search across files → use \`rg_search\`** (faster than grep in terminal, structured results with line numbers and context). Pass \`fileType\` to narrow to language (e.g. "ts", "py", "kt"). Only fall back to \`grep_search\` if rg_search is unavailable.
- **Symbol lookups (go-to-definition, find references, hover, diagnostics) → use \`code_nav\`**. Requires the relevant VS Code language extension to be installed (e.g. Kotlin Language Support for .kt files, Pylance for .py). Works for any language — the bridge delegates to VS Code's language provider API automatically.
- **Reading/understanding a file → start with \`code_nav\` (\`document_symbols\`)**, not a full-file dump. Get the symbol outline (functions, classes, methods with their line ranges) first, then do a *targeted ranged read* of only the region you need. Reserve whole-file reads for small files (<~150 lines) or when you genuinely need the entire content.
- Note the boundary: \`code_nav\` returns structure and precise line ranges, not raw source text. Use it to locate *where* to look, then read that range — this avoids pulling thousands of irrelevant lines into context.
- Do NOT run \`grep\` or \`rg\` in the terminal for code search when \`rg_search\` is available.
- Do NOT read entire files to locate a symbol when \`code_nav\` (definition/references/document_symbols) or \`rg_search\` can locate it in one call.

## Turn Budget
- A per-turn budget banner (\`Turn budget: N AIU · last turn …\`) reports the soft AIU limit and the previous turn's spend. It is advisory and never blocks.
- Work within it: prefer targeted searches (\`rg_search\`/\`code_nav\`) over broad scans and full-file reads, batch independent tool calls in one step, avoid re-reading large files, delegate heavy exploration to a cheaper sub-agent, and finalize as soon as the task is done.
- Call the \`turn_budget\` tool to check live in-turn spend when a turn runs long.

## Communication
- BE CRISP. Default to the shortest correct answer (1–3 sentences). Lead with the result first; add detail only when asked or essential.
- No preamble, no restating the question, no filler, no narrating what you are about to do. Never pad the final response.
- Prefer a tight summary + concrete proof (numbers, file:line) over prose. Use short bullets, not paragraphs. Cut every sentence that does not add information.
- Be honest about boundaries: you cannot rewrite GitHub Copilot's closed system prompt. You can guide behavior through this custom agent, tool descriptions, tool results, and worker prompts.
- Explain credit math plainly when asked.
- When user says today is RTK work, prioritize RTK setup, RTK command routing, RTK observability, and proof of savings.
`;

const RTK_GATE_COMMAND = '$HOME/.askaway/hooks/rtk-gate.sh';
const RTK_GATE_SCRIPT = `#!/bin/sh
# AskAway RTK conditional hook gate (PreToolUse).
# Toggle OFF: no output -> tool runs unchanged.
# Toggle ON: delegate command-only mutation to rtk's hook implementation.

SENTINEL="$HOME/.askaway-rtk-enabled"
payload=$(cat)

[ -f "$SENTINEL" ] || exit 0

RTK_BIN="$(command -v rtk 2>/dev/null)"
if [ -z "$RTK_BIN" ]; then
    for p in /opt/homebrew/bin/rtk /usr/local/bin/rtk "$HOME/.local/bin/rtk"; do
        if [ -x "$p" ]; then
            RTK_BIN="$p"
            break
        fi
    done
fi
[ -n "$RTK_BIN" ] || exit 0

# VS Code Copilot sends {toolName,input}; current rtk expects Claude's
# {tool_name,tool_input}. Normalize keys, then delegate to rtk's hook engine.
printf '%s' "$payload" | sed 's/"toolName"/"tool_name"/;s/"input"/"tool_input"/' | "$RTK_BIN" hook claude
exit 0
`;
const RTK_HOOK_MATCHERS = [
    // Claude Code's shell tool.
    'Bash',
    // VS Code Copilot terminal + task command tools. RTK wraps the shell command
    // carried by these tools; non-shell command tools (e.g. run_vscode_command) are
    // intentionally excluded because RTK cannot compress VS Code command output.
    'run_in_terminal|runInTerminal|sendToTerminal|send_to_terminal|local_shell|bash|powershell|createAndRunTask|create_and_run_task|runTask|runTasks|runCommand|runCommands'
];

// ── Turn-budget UserPromptSubmit hook ─────────────────────────────────────────
// Injects a live per-turn budget banner into every prompt when a soft budget is set
// (askaway.turnBudgetAiu > 0). This is the "push" complement to the pull-based
// turn_budget tool. The extension writes two sentinels the hook reads (it runs as an
// external process and can't read VS Code config):
//   ~/.askaway/turn-budget-aiu        the soft limit (0/absent => hook is a no-op)
//   ~/.askaway/workspace-storage-root the VS Code workspaceStorage dir to scan for logs
const BUDGET_GATE_COMMAND = '$HOME/.askaway/hooks/budget-gate.sh';
const BUDGET_GATE_SCRIPT = `#!/bin/sh
# AskAway turn-budget injector (UserPromptSubmit). No output unless a soft budget is set.
CFG="$HOME/.askaway"
[ -f "$CFG/turn-budget-aiu" ] || exit 0
cat >/dev/null 2>&1
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
    for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
        [ -x "$p" ] && NODE="$p" && break
    done
fi
[ -n "$NODE" ] || exit 0
"$NODE" "$CFG/hooks/budget-inject.js"
exit 0
`;
const BUDGET_INJECT_SCRIPT = `// AskAway turn-budget injector. Emits a UserPromptSubmit additionalContext banner with
// live per-turn spend vs the configured soft limit. No output if no budget is set.
const fs = require('fs'), path = require('path'), os = require('os');
function safeReaddir(d) { try { return fs.readdirSync(d); } catch (e) { return []; } }
try {
    const cfg = path.join(os.homedir(), '.askaway');
    const limit = parseFloat((fs.readFileSync(path.join(cfg, 'turn-budget-aiu'), 'utf8') || '0').trim()) || 0;
    if (!(limit > 0)) { process.exit(0); }
    const wsRoot = (fs.readFileSync(path.join(cfg, 'workspace-storage-root'), 'utf8') || '').trim();
    if (!wsRoot) { process.exit(0); }
    let newest = null;
    for (const h of safeReaddir(wsRoot)) {
        const dl = path.join(wsRoot, h, 'GitHub.copilot-chat', 'debug-logs');
        for (const s of safeReaddir(dl)) {
            const m = path.join(dl, s, 'main.jsonl');
            try { const st = fs.statSync(m); if (!newest || st.mtimeMs > newest.mt) { newest = { dir: path.join(dl, s), mt: st.mtimeMs }; } } catch (e) {}
        }
    }
    if (!newest) { process.exit(0); }
    // Parent turn boundary = newest user_message in main.jsonl (child sub-agent logs have their own).
    const mainLines = fs.readFileSync(path.join(newest.dir, 'main.jsonl'), 'utf8').split('\\n');
    let lastSubmit = 0;
    for (const l of mainLines) { if (l.indexOf('"type":"user_message"') === -1) { continue; } try { const p = JSON.parse(l); if (typeof p.ts === 'number' && p.ts > lastSubmit) { lastSubmit = p.ts; } } catch (e) {} }
    // Sum main.jsonl PLUS runSubagent-*.jsonl child sessions (sub-agent calls are billed but logged separately).
    const files = safeReaddir(newest.dir).filter(n => n.endsWith('.jsonl') && n.indexOf('title-') !== 0 && (n === 'main.jsonl' || n.indexOf('runSubagent') === 0)).map(n => path.join(newest.dir, n));
    let nano = 0;
    for (const f of files) {
        let data; try { data = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        for (const l of data.split('\\n')) { if (l.indexOf('llm_request') === -1) { continue; } let p; try { p = JSON.parse(l); } catch (e) { continue; } const ts = typeof p.ts === 'number' ? p.ts : 0; if (ts < lastSubmit) { continue; } nano += (p.attrs && typeof p.attrs.copilotUsageNanoAiu === 'number') ? p.attrs.copilotUsageNanoAiu : 0; }
    }
    // At UserPromptSubmit the NEW turn's user_message is not yet in the log, so the newest
    // user_message ts is the PREVIOUS turn's — and \`nano\` below is the previous turn's total.
    // The current turn is genuinely fresh (0 spent) at this instant, so present it that way
    // and expose the previous turn as context. Live in-turn spend comes from the turn_budget tool.
    // One line of NUMBERS only. The how-to guidance is static and lives in the cached
    // AskAway Build agent instructions (## Turn Budget), so it costs ~0 per turn here.
    const prevSpent = nano / 1e9;
    const pctPrev = Math.round(prevSpent / limit * 100);
    const ctx = lastSubmit === 0
        ? 'Turn budget: ' + limit + ' AIU'
        : 'Turn budget: ' + limit + ' AIU · last turn ' + prevSpent.toFixed(0) + ' (' + pctPrev + '%' + (pctPrev >= 100 ? ', OVER — be frugal' : '') + ')';
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
} catch (e) {}
process.exit(0);
`;

// ── Prompt-cache activity timer (event-driven) ────────────────────────────────
// The webview shows a "prompt cache age" clock. Polling the debug log lags (Copilot
// logs an llm_request only on completion) and never resets on a fresh submission.
// These hooks stamp ~/.askaway/cache-activity-ts on model-activity events so the clock
// is event-driven: UserPromptSubmit resets it (age 0), PostToolUse/Stop mark the last
// model round. The extension reads the sentinel each broadcast (max with the log ts).
const CACHE_TIMER_GATE_COMMAND = '$HOME/.askaway/hooks/cache-timer-gate.sh';
const CACHE_TIMER_GATE_SCRIPT = `#!/bin/sh
# AskAway prompt-cache activity timer. Records wall-clock time of model activity so the
# webview cache-age clock is event-driven. Passes stdin to node (it reads hook_event_name
# to detect turn end). No-op if node is missing.
CFG="$HOME/.askaway"
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
    for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
        [ -x "$p" ] && NODE="$p" && break
    done
fi
[ -n "$NODE" ] || { cat >/dev/null 2>&1; exit 0; }
"$NODE" "$CFG/hooks/cache-timer.js"
exit 0
`;
const CACHE_TIMER_INJECT_SCRIPT = `// AskAway prompt-cache activity timer. Stamps ~/.askaway/cache-activity-ts on each
// model-activity hook event; on the Stop event it also stamps ~/.askaway/turn-complete-ts
// so the webview can play the "turn complete" sound. No stdout.
const fs = require('fs'), path = require('path'), os = require('os');
try {
    let ev = '';
    try { const p = JSON.parse(fs.readFileSync(0, 'utf8')); ev = p.hook_event_name || p.hookEventName || ''; } catch (e) {}
    const cfg = path.join(os.homedir(), '.askaway');
    try { fs.mkdirSync(cfg, { recursive: true }); } catch (e) {}
    const now = String(Date.now());
    fs.writeFileSync(path.join(cfg, 'cache-activity-ts'), now, 'utf8');
    if (ev === 'Stop') { fs.writeFileSync(path.join(cfg, 'turn-complete-ts'), now, 'utf8'); }
} catch (e) {}
process.exit(0);
`;

/** Install the prompt-cache activity timer hook (UserPromptSubmit / PostToolUse / Stop). */
async function ensureCacheTimerHookInstalled(): Promise<void> {
    const gatePath = path.join(os.homedir(), '.askaway', 'hooks', 'cache-timer-gate.sh');
    const injectPath = path.join(os.homedir(), '.askaway', 'hooks', 'cache-timer.js');
    const events = ['UserPromptSubmit', 'PostToolUse', 'Stop'];
    try {
        await fs.promises.mkdir(path.dirname(gatePath), { recursive: true });
        if (await fs.promises.readFile(gatePath, 'utf8').catch(() => undefined) !== CACHE_TIMER_GATE_SCRIPT) {
            await fs.promises.writeFile(gatePath, CACHE_TIMER_GATE_SCRIPT, 'utf8');
        }
        await fs.promises.chmod(gatePath, 0o755);
        if (await fs.promises.readFile(injectPath, 'utf8').catch(() => undefined) !== CACHE_TIMER_INJECT_SCRIPT) {
            await fs.promises.writeFile(injectPath, CACHE_TIMER_INJECT_SCRIPT, 'utf8');
        }
        const gateAbs = path.join(os.homedir(), '.askaway', 'hooks', 'cache-timer-gate.sh');

        // VS Code Copilot: ~/.copilot/hooks/cache-timer.json (one file, several events).
        const copilotHookPath = path.join(os.homedir(), '.copilot', 'hooks', 'cache-timer.json');
        await fs.promises.mkdir(path.dirname(copilotHookPath), { recursive: true });
        const cfg: any = { version: 1, hooks: {} };
        for (const ev of events) {
            cfg.hooks[ev] = [{ type: 'command', command: gateAbs, cwd: '.', timeout: 5 }];
        }
        await fs.promises.writeFile(copilotHookPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

        // Claude Code: ~/.claude/settings.json hooks.<event>
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
        let settings: any = {};
        try { settings = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
        }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { settings = {}; }
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) { settings.hooks = {}; }
        let changed = false;
        for (const ev of events) {
            if (!Array.isArray(settings.hooks[ev])) { settings.hooks[ev] = []; }
            const has = settings.hooks[ev].some((e: any) =>
                Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === CACHE_TIMER_GATE_COMMAND));
            if (!has) {
                settings.hooks[ev].push({ hooks: [{ type: 'command', command: CACHE_TIMER_GATE_COMMAND }] });
                changed = true;
            }
        }
        if (changed) {
            await fs.promises.writeFile(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        }

        logRuntime('Installed AskAway cache-timer hook', { gatePath, injectPath });
    } catch (err) {
        logRuntime('Warning: Could not install AskAway cache-timer hook', formatError(err));
    }
}

// ── Tool I/O logger (PostToolUse) ─────────────────────────────────────────────
// Copilot truncates the tool result in its DEBUG LOG (attrs.result, ~5K chars), so the
// observability tool row undercounts big outputs (a 185KB memory read shows as ~1.3K tok
// instead of ~48K). The PostToolUse hook receives the FULL, untruncated tool_response plus
// tool_name + tool_use_id, so we log the real input/output sizes to ~/.askaway/tool-io.jsonl
// and the webview reconciles the tool row against it. Lossless, independent of the debug log.
const TOOL_IO_GATE_COMMAND = '$HOME/.askaway/hooks/tool-io-gate.sh';
const TOOL_IO_GATE_SCRIPT = `#!/bin/sh
# AskAway tool I/O logger. Pipes the PostToolUse payload (stdin) to node, which appends the
# real (untruncated) input/output sizes to ~/.askaway/tool-io.jsonl. No-op if node is missing.
CFG="$HOME/.askaway"
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
    for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
        [ -x "$p" ] && NODE="$p" && break
    done
fi
[ -n "$NODE" ] || { cat >/dev/null 2>&1; exit 0; }
"$NODE" "$CFG/hooks/tool-io.js"
exit 0
`;
const TOOL_IO_INJECT_SCRIPT = `// AskAway tool I/O logger. Reads a PostToolUse payload from stdin and appends one JSONL row
// {ts, tool, id, inChars, outChars, in, out} with the FULL (untruncated) input/output Copilot
// handed the model. The EXTENSION tokenizes 'in'/'out' with the real gpt-tokenizer (there is no
// tokenizer here), so no chars/4 estimate is stored. Text is capped at 1MB/field and the file is
// bounded to the last ~2000 rows / 16MB. No stdout.
const fs = require('fs'), path = require('path'), os = require('os');
try {
    let p = {};
    try { p = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) {}
    const tool = p.tool_name || p.toolName || '';
    if (!tool) { process.exit(0); }
    const id = p.tool_use_id || p.toolUseId || '';
    const inStr = typeof p.tool_input === 'string' ? p.tool_input : JSON.stringify(p.tool_input || {});
    // Copilot has changed the PostToolUse response key over time; probe the known aliases so a
    // rename doesn't silently zero out captured output.
    const respRaw = (p.tool_response !== undefined ? p.tool_response
        : p.tool_result !== undefined ? p.tool_result
        : p.toolResponse !== undefined ? p.toolResponse
        : p.response !== undefined ? p.response
        : p.output !== undefined ? p.output
        : p.result);
    const outStr = typeof respRaw === 'string' ? respRaw : JSON.stringify(respRaw || '');
    const CAP = 1024 * 1024;
    const row = { ts: Date.now(), tool: tool, id: id, inChars: inStr.length, outChars: outStr.length, in: inStr.slice(0, CAP), out: outStr.slice(0, CAP) };
    const cfg = path.join(os.homedir(), '.askaway');
    try { fs.mkdirSync(cfg, { recursive: true }); } catch (e) {}
    const file = path.join(cfg, 'tool-io.jsonl');
    fs.appendFileSync(file, JSON.stringify(row) + '\\n', 'utf8');
    try {
        const st = fs.statSync(file);
        if (st.size > 16 * 1024 * 1024) {
            const lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean);
            fs.writeFileSync(file, lines.slice(-2000).join('\\n') + '\\n', 'utf8');
        }
    } catch (e) {}
} catch (e) {}
process.exit(0);
`;

/** Install the tool I/O logger hook (PostToolUse). Logs full, untruncated tool input/output
 *  sizes so the observability tool row reflects what the model actually received. */
async function ensureToolIoHookInstalled(): Promise<void> {
    const gatePath = path.join(os.homedir(), '.askaway', 'hooks', 'tool-io-gate.sh');
    const injectPath = path.join(os.homedir(), '.askaway', 'hooks', 'tool-io.js');
    const events = ['PostToolUse'];
    try {
        await fs.promises.mkdir(path.dirname(gatePath), { recursive: true });
        if (await fs.promises.readFile(gatePath, 'utf8').catch(() => undefined) !== TOOL_IO_GATE_SCRIPT) {
            await fs.promises.writeFile(gatePath, TOOL_IO_GATE_SCRIPT, 'utf8');
        }
        await fs.promises.chmod(gatePath, 0o755);
        if (await fs.promises.readFile(injectPath, 'utf8').catch(() => undefined) !== TOOL_IO_INJECT_SCRIPT) {
            await fs.promises.writeFile(injectPath, TOOL_IO_INJECT_SCRIPT, 'utf8');
        }
        const gateAbs = path.join(os.homedir(), '.askaway', 'hooks', 'tool-io-gate.sh');

        // VS Code Copilot: ~/.copilot/hooks/tool-io.json
        const copilotHookPath = path.join(os.homedir(), '.copilot', 'hooks', 'tool-io.json');
        await fs.promises.mkdir(path.dirname(copilotHookPath), { recursive: true });
        const cfg: any = { version: 1, hooks: {} };
        for (const ev of events) {
            cfg.hooks[ev] = [{ type: 'command', command: gateAbs, cwd: '.', timeout: 5 }];
        }
        await fs.promises.writeFile(copilotHookPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

        // Claude Code: ~/.claude/settings.json hooks.PostToolUse
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
        let settings: any = {};
        try { settings = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
        }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { settings = {}; }
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) { settings.hooks = {}; }
        let changed = false;
        for (const ev of events) {
            if (!Array.isArray(settings.hooks[ev])) { settings.hooks[ev] = []; }
            const has = settings.hooks[ev].some((e: any) =>
                Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === TOOL_IO_GATE_COMMAND));
            if (!has) {
                settings.hooks[ev].push({ hooks: [{ type: 'command', command: TOOL_IO_GATE_COMMAND }] });
                changed = true;
            }
        }
        if (changed) {
            await fs.promises.writeFile(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        }

        logRuntime('Installed AskAway tool-io hook', { gatePath, injectPath });
    } catch (err) {
        logRuntime('Warning: Could not install AskAway tool-io hook', formatError(err));
    }
}

// ── Sub-agent model interception (PreToolUse) ─────────────────────────────────
// Opt-in: when askaway.subagentModel is set, a PreToolUse hook rewrites the `model`
// arg of Copilot's built-in `runSubagent` tool so sub-agents run on a cheaper model.
// Same mechanism as the RTK command rewrite. No-op when the sentinel is empty/absent.
const SUBAGENT_MODEL_GATE_COMMAND = '$HOME/.askaway/hooks/subagent-model-gate.sh';
const SUBAGENT_MODEL_GATE_SCRIPT = `#!/bin/sh
# AskAway sub-agent model injector (PreToolUse). Passes stdin through to node so the
# tool payload reaches the injector. No-op (stdin consumed, tool unchanged) when the
# sentinel is absent or node can't be found.
CFG="$HOME/.askaway"
[ -f "$CFG/subagent-model" ] || { cat >/dev/null 2>&1; exit 0; }
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ]; then
    for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
        [ -x "$p" ] && NODE="$p" && break
    done
fi
[ -n "$NODE" ] || { cat >/dev/null 2>&1; exit 0; }
"$NODE" "$CFG/hooks/subagent-model.js"
exit 0
`;
const SUBAGENT_MODEL_INJECT_SCRIPT = `// AskAway sub-agent model injector. On a runSubagent PreToolUse, overrides tool_input.model
// with the configured cheap model so the sub-agent runs cheaper. Emits nothing otherwise.
const fs = require('fs'), path = require('path'), os = require('os');
try {
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { process.exit(0); }
    let p; try { p = JSON.parse(raw); } catch (e) { process.exit(0); }
    const toolName = p.tool_name || p.toolName || '';
    const input = p.tool_input || p.input;
    if (toolName !== 'runSubagent' || !input || typeof input !== 'object') { process.exit(0); }
    const model = (fs.readFileSync(path.join(os.homedir(), '.askaway', 'subagent-model'), 'utf8') || '').trim();
    if (!model) { process.exit(0); }
    if (input.model === model) { process.exit(0); }
    const updated = Object.assign({}, input, { model: model });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }));
} catch (e) {}
process.exit(0);
`;

/** Write the sentinel the sub-agent model hook reads (the desired model string; empty = off). */
async function writeSubagentModelSentinel(): Promise<void> {
    try {
        const cfgDir = path.join(os.homedir(), '.askaway');
        await fs.promises.mkdir(cfgDir, { recursive: true });
        const model = String(vscode.workspace.getConfiguration('askaway').get('subagentModel', '') || '').trim();
        await fs.promises.writeFile(path.join(cfgDir, 'subagent-model'), model, 'utf8');
    } catch (err) {
        logRuntime('Warning: Could not write sub-agent model sentinel', formatError(err));
    }
}

/** Install the sub-agent model PreToolUse hook (Copilot hooks + Claude settings, best-effort). */
async function ensureSubagentModelHookInstalled(): Promise<void> {
    const gatePath = path.join(os.homedir(), '.askaway', 'hooks', 'subagent-model-gate.sh');
    const injectPath = path.join(os.homedir(), '.askaway', 'hooks', 'subagent-model.js');
    try {
        await fs.promises.mkdir(path.dirname(gatePath), { recursive: true });
        if (await fs.promises.readFile(gatePath, 'utf8').catch(() => undefined) !== SUBAGENT_MODEL_GATE_SCRIPT) {
            await fs.promises.writeFile(gatePath, SUBAGENT_MODEL_GATE_SCRIPT, 'utf8');
        }
        await fs.promises.chmod(gatePath, 0o755);
        if (await fs.promises.readFile(injectPath, 'utf8').catch(() => undefined) !== SUBAGENT_MODEL_INJECT_SCRIPT) {
            await fs.promises.writeFile(injectPath, SUBAGENT_MODEL_INJECT_SCRIPT, 'utf8');
        }

        // VS Code Copilot: ~/.copilot/hooks/subagent-model.json (separate file; PreToolUse).
        const copilotHookPath = path.join(os.homedir(), '.copilot', 'hooks', 'subagent-model.json');
        await fs.promises.mkdir(path.dirname(copilotHookPath), { recursive: true });
        const gateAbs = path.join(os.homedir(), '.askaway', 'hooks', 'subagent-model-gate.sh');
        const cfg = {
            version: 1,
            hooks: {
                PreToolUse: [{ type: 'command', command: gateAbs, cwd: '.', timeout: 5 }],
                preToolUse: [{ type: 'command', bash: gateAbs, powershell: gateAbs, cwd: '.', timeoutSec: 5 }],
            },
        };
        await fs.promises.writeFile(copilotHookPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

        // Claude Code: ~/.claude/settings.json hooks.PreToolUse with a runSubagent matcher.
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
        let settings: any = {};
        try { settings = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
        }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { settings = {}; }
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) { settings.hooks = {}; }
        if (!Array.isArray(settings.hooks.PreToolUse)) { settings.hooks.PreToolUse = []; }
        const hasEntry = settings.hooks.PreToolUse.some((e: any) =>
            Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === SUBAGENT_MODEL_GATE_COMMAND));
        if (!hasEntry) {
            settings.hooks.PreToolUse.push({ matcher: 'runSubagent', hooks: [{ type: 'command', command: SUBAGENT_MODEL_GATE_COMMAND }] });
            await fs.promises.writeFile(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        }

        logRuntime('Installed AskAway sub-agent model hook', { gatePath, injectPath });
    } catch (err) {
        logRuntime('Warning: Could not install AskAway sub-agent model hook', formatError(err));
    }
}

/** Persist the sentinels the budget hook reads: the soft limit + the workspaceStorage root. */
async function writeBudgetSentinels(context: vscode.ExtensionContext): Promise<void> {
    try {
        const cfgDir = path.join(os.homedir(), '.askaway');
        await fs.promises.mkdir(cfgDir, { recursive: true });
        const limit = Number(vscode.workspace.getConfiguration('askaway').get('turnBudgetAiu', 0)) || 0;
        await fs.promises.writeFile(path.join(cfgDir, 'turn-budget-aiu'), `${limit}\n`, 'utf8');
        const storage = context.storageUri?.fsPath;
        if (storage) {
            // storageUri = <...>/workspaceStorage/<hash>/<ext-id>; go up two to workspaceStorage.
            const wsRoot = path.dirname(path.dirname(storage));
            await fs.promises.writeFile(path.join(cfgDir, 'workspace-storage-root'), `${wsRoot}\n`, 'utf8');
        }
    } catch (err) {
        logRuntime('Warning: Could not write budget sentinels', formatError(err));
    }
}

/** Install the turn-budget UserPromptSubmit hook (Claude settings + Copilot hooks). */
async function ensureBudgetHookInstalled(): Promise<void> {
    const gatePath = path.join(os.homedir(), '.askaway', 'hooks', 'budget-gate.sh');
    const injectPath = path.join(os.homedir(), '.askaway', 'hooks', 'budget-inject.js');
    try {
        await fs.promises.mkdir(path.dirname(gatePath), { recursive: true });
        if (await fs.promises.readFile(gatePath, 'utf8').catch(() => undefined) !== BUDGET_GATE_SCRIPT) {
            await fs.promises.writeFile(gatePath, BUDGET_GATE_SCRIPT, 'utf8');
        }
        await fs.promises.chmod(gatePath, 0o755);
        if (await fs.promises.readFile(injectPath, 'utf8').catch(() => undefined) !== BUDGET_INJECT_SCRIPT) {
            await fs.promises.writeFile(injectPath, BUDGET_INJECT_SCRIPT, 'utf8');
        }

        // Claude Code: ~/.claude/settings.json hooks.UserPromptSubmit
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
        let settings: any = {};
        try { settings = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
        }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { settings = {}; }
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) { settings.hooks = {}; }
        if (!Array.isArray(settings.hooks.UserPromptSubmit)) { settings.hooks.UserPromptSubmit = []; }
        const hasBudget = settings.hooks.UserPromptSubmit.some((e: any) =>
            Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === BUDGET_GATE_COMMAND));
        if (!hasBudget) {
            settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: BUDGET_GATE_COMMAND }] });
            await fs.promises.writeFile(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
        }

        // VS Code Copilot: ~/.copilot/hooks/budget-inject.json (best-effort — event support may vary).
        const copilotHookPath = path.join(os.homedir(), '.copilot', 'hooks', 'budget-inject.json');
        await fs.promises.mkdir(path.dirname(copilotHookPath), { recursive: true });
        let cfg: any = {};
        try { cfg = JSON.parse(await fs.promises.readFile(copilotHookPath, 'utf8')); } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
        }
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { cfg = {}; }
        if (typeof cfg.version !== 'number') { cfg.version = 1; }
        if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) { cfg.hooks = {}; }
        const gateAbs = path.join(os.homedir(), '.askaway', 'hooks', 'budget-gate.sh');
        cfg.hooks.UserPromptSubmit = [{ type: 'command', command: gateAbs, cwd: '.', timeout: 10 }];
        await fs.promises.writeFile(copilotHookPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

        logRuntime('Installed AskAway turn-budget hook', { gatePath, injectPath });
    } catch (err) {
        logRuntime('Warning: Could not install AskAway turn-budget hook', formatError(err));
    }
}


async function ensureAskAwayBuildAgentInstalled(context: vscode.ExtensionContext): Promise<void> {
    const userDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
    const promptsDir = path.join(userDir, 'prompts');
    const agentPath = path.join(promptsDir, ASKWAY_BUILD_AGENT_FILE);

    try {
        await fs.promises.mkdir(promptsDir, { recursive: true });
        const existing = await fs.promises.readFile(agentPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                return undefined;
            }
            throw err;
        });

        if (existing === undefined) {
            await fs.promises.writeFile(agentPath, ASKWAY_BUILD_AGENT_CONTENT, 'utf8');
            logRuntime('Installed AskAway Build user agent', { agentPath });
        } else if (existing === ASKWAY_BUILD_AGENT_CONTENT) {
            logRuntime('AskAway Build user agent already installed', { agentPath });
        } else {
            logRuntime('AskAway Build user agent exists; preserving user copy', { agentPath });
        }
    } catch (err) {
        logRuntime('Warning: Could not install AskAway Build user agent', formatError(err));
    }
}

/**
 * Install the cowork offload assets at USER level so they work in every workspace:
 *  - the `/export-to-cowork` prompt command -> VS Code User prompts folder
 *  - `bundle.mjs` / `apply.mjs` scripts      -> ~/.askaway/cowork/
 * User edits to any file are preserved (only writes when missing or byte-identical to a prior install).
 */
async function ensureCoworkInstalled(context: vscode.ExtensionContext): Promise<void> {
    const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
    const userDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
    const promptsDir = path.join(userDir, 'prompts');
    const coworkDir = path.join(os.homedir(), '.askaway', 'cowork');

    const writeIfSafe = async (filePath: string, content: string, label: string, mode?: number) => {
        const existing = await fs.promises.readFile(filePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') { return undefined; }
            throw err;
        });
        if (existing === undefined || existing === content) {
            await fs.promises.writeFile(filePath, content, 'utf8');
            if (mode !== undefined) { await fs.promises.chmod(filePath, mode).catch(() => {}); }
            logRuntime(existing === undefined ? `Installed cowork ${label}` : `cowork ${label} up to date`, { filePath });
        } else {
            logRuntime(`cowork ${label} exists; preserving user copy`, { filePath });
        }
    };

    try {
        await fs.promises.mkdir(promptsDir, { recursive: true });
        await fs.promises.mkdir(coworkDir, { recursive: true });
        await writeIfSafe(path.join(promptsDir, 'export-to-cowork.prompt.md'), decode(COWORK_PROMPT_B64), 'command');
        await writeIfSafe(path.join(coworkDir, 'bundle.mjs'), decode(COWORK_BUNDLE_B64), 'bundle.mjs', 0o755);
        await writeIfSafe(path.join(coworkDir, 'apply.mjs'), decode(COWORK_APPLY_B64), 'apply.mjs', 0o755);
    } catch (err) {
        logRuntime('Warning: Could not install cowork assets', formatError(err));
    }
}

function hookEntryUsesCommand(entry: any, command: string): boolean {
    return Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) => hook?.type === 'command' && hook?.command === command);
}

function migrateDirectRtkHookToGate(entry: any): boolean {
    if (!Array.isArray(entry?.hooks)) {
        return false;
    }

    let changed = false;
    for (const hook of entry.hooks) {
        if (hook?.type === 'command' && hook.command === 'rtk hook claude') {
            hook.command = RTK_GATE_COMMAND;
            changed = true;
        }
    }
    return changed;
}

async function ensureRtkGlobalHooksInstalled(): Promise<void> {
    const gatePath = path.join(os.homedir(), '.askaway', 'hooks', 'rtk-gate.sh');
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    try {
        await fs.promises.mkdir(path.dirname(gatePath), { recursive: true });
        const existingGate = await fs.promises.readFile(gatePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                return undefined;
            }
            throw err;
        });
        if (existingGate !== RTK_GATE_SCRIPT) {
            await fs.promises.writeFile(gatePath, RTK_GATE_SCRIPT, 'utf8');
        }
        await fs.promises.chmod(gatePath, 0o755);

        await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
        let settings: any = {};
        try {
            const rawSettings = await fs.promises.readFile(claudeSettingsPath, 'utf8');
            settings = JSON.parse(rawSettings);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }

        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            settings = {};
        }
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
            settings.hooks = {};
        }
        if (!Array.isArray(settings.hooks.PreToolUse)) {
            settings.hooks.PreToolUse = [];
        }

        let settingsChanged = false;
        for (const entry of settings.hooks.PreToolUse) {
            if (migrateDirectRtkHookToGate(entry)) {
                settingsChanged = true;
            }
        }

        // Prune stale AskAway gate entries whose matcher is no longer in RTK_HOOK_MATCHERS.
        // This lets the matcher list evolve (e.g. adding task/command tools) without leaving
        // orphaned entries behind from previous versions.
        const beforePrune = settings.hooks.PreToolUse.length;
        settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((entry: any) => {
            const isAskAwayGate = hookEntryUsesCommand(entry, RTK_GATE_COMMAND);
            if (!isAskAwayGate) {
                return true; // keep non-AskAway entries (e.g. the param logger) untouched
            }
            return RTK_HOOK_MATCHERS.includes(entry?.matcher);
        });
        if (settings.hooks.PreToolUse.length !== beforePrune) {
            settingsChanged = true;
        }

        for (const matcher of RTK_HOOK_MATCHERS) {
            const hasMatcherGate = settings.hooks.PreToolUse.some((entry: any) => entry?.matcher === matcher && hookEntryUsesCommand(entry, RTK_GATE_COMMAND));
            if (!hasMatcherGate) {
                settings.hooks.PreToolUse.push({
                    matcher,
                    hooks: [{ type: 'command', command: RTK_GATE_COMMAND }]
                });
                settingsChanged = true;
            }
        }

        if (settingsChanged) {
            await fs.promises.writeFile(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
            logRuntime('Installed AskAway RTK global hooks', { claudeSettingsPath, gatePath });
        } else {
            logRuntime('AskAway RTK global hooks already installed', { claudeSettingsPath, gatePath });
        }
    } catch (err) {
        logRuntime('Warning: Could not install AskAway RTK global hooks', formatError(err));
    }
}

/**
 * Ensure the GitHub Copilot native PreToolUse hook routes through AskAway's RTK gate.
 *
 * VS Code Copilot reads its own hook config from ~/.copilot/hooks/*.json (NOT
 * ~/.claude/settings.json). RTK ships a config that calls `rtk hook copilot`, but
 * that subcommand is a no-op in current rtk builds (it never rewrites commands).
 * `rtk hook claude` — which AskAway's gate invokes — DOES rewrite correctly and
 * emits the `hookSpecificOutput.updatedInput` shape Copilot consumes. So we point
 * every Copilot PreToolUse hook at the gate, giving consistent RTK rewriting plus
 * the sentinel toggle. Copilot has no matcher here, so the gate runs for every tool
 * and rewrites only the ones carrying a shell command.
 */
async function ensureCopilotHookInstalled(): Promise<void> {
    const gateAbsPath = path.join(os.homedir(), '.askaway', 'hooks', 'rtk-gate.sh');
    const copilotHookPath = path.join(os.homedir(), '.copilot', 'hooks', 'rtk-rewrite.json');
    const BROKEN_CMD = 'rtk hook copilot';

    try {
        await fs.promises.mkdir(path.dirname(copilotHookPath), { recursive: true });

        let config: any = {};
        try {
            config = JSON.parse(await fs.promises.readFile(copilotHookPath, 'utf8'));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            config = {};
        }
        if (typeof config.version !== 'number') {
            config.version = 1;
        }
        if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
            config.hooks = {};
        }

        let changed = false;
        const isBrokenValue = (v: unknown): boolean => v === BROKEN_CMD;

        // `PreToolUse` array uses a single `command` string per entry.
        const upper = Array.isArray(config.hooks.PreToolUse) ? config.hooks.PreToolUse : [];
        if (upper.length === 0) {
            config.hooks.PreToolUse = [{ type: 'command', command: gateAbsPath, cwd: '.', timeout: 5 }];
            changed = true;
        } else {
            for (const entry of upper) {
                if (entry && typeof entry === 'object' && (isBrokenValue(entry.command) || entry.command !== gateAbsPath)) {
                    entry.command = gateAbsPath;
                    changed = true;
                }
            }
            config.hooks.PreToolUse = upper;
        }

        // `preToolUse` array uses `bash`/`powershell` string keys per entry.
        const lower = Array.isArray(config.hooks.preToolUse) ? config.hooks.preToolUse : [];
        if (lower.length === 0) {
            config.hooks.preToolUse = [{ type: 'command', bash: gateAbsPath, powershell: gateAbsPath, cwd: '.', timeoutSec: 5 }];
            changed = true;
        } else {
            for (const entry of lower) {
                if (!entry || typeof entry !== 'object') {
                    continue;
                }
                if (isBrokenValue(entry.bash) || entry.bash !== gateAbsPath) {
                    entry.bash = gateAbsPath;
                    changed = true;
                }
                if (isBrokenValue(entry.powershell) || entry.powershell !== gateAbsPath) {
                    entry.powershell = gateAbsPath;
                    changed = true;
                }
            }
            config.hooks.preToolUse = lower;
        }

        if (changed) {
            await fs.promises.writeFile(copilotHookPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
            logRuntime('Routed Copilot native hook through AskAway RTK gate', { copilotHookPath, gateAbsPath });
        } else {
            logRuntime('Copilot native hook already routed through RTK gate', { copilotHookPath });
        }
    } catch (err) {
        logRuntime('Warning: Could not install Copilot RTK hook', formatError(err));
    }
}

// Memoized result for external MCP client check (only checked once per activation)
let _hasExternalMcpClientsResult: boolean | undefined;

/**
 * Check if external MCP client configs exist (Kiro, Cursor, Antigravity)
 * This indicates user has external tools that need the MCP server
 * Result is memoized to avoid repeated file system reads
 * Uses async I/O to avoid blocking the extension host thread
 */
async function hasExternalMcpClientsAsync(): Promise<boolean> {
    // Return cached result if available
    if (_hasExternalMcpClientsResult !== undefined) {
        return _hasExternalMcpClientsResult;
    }

    const configPaths = [
        path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
        path.join(os.homedir(), '.cursor', 'mcp.json'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json')
    ];

    for (const configPath of configPaths) {
        try {
            const content = await fs.promises.readFile(configPath, 'utf8');
            const config = JSON.parse(content);
            // Check if askaway is registered
            if (config.mcpServers?.[MCP_SERVER_NAME]) {
                _hasExternalMcpClientsResult = true;
                return true;
            }
        } catch {
            // File doesn't exist or parse error - continue to next path
        }
    }
    _hasExternalMcpClientsResult = false;
    return false;
}

/**
 * Detect installed extensions that are likely to conflict with AskAway's ask_user tool.
 * Primary known conflict is upstream TaskSync shipping the same tool name.
 */
function findConflictingTaskSyncExtension(): vscode.Extension<any> | undefined {
    const explicitIds = ['4regab.tasksync'];

    for (const id of explicitIds) {
        const ext = vscode.extensions.getExtension(id);
        if (ext) {
            return ext;
        }
    }

    return vscode.extensions.all.find(ext => {
        if (ext.id.toLowerCase() === 'intuitiv.askaway') {
            return false;
        }

        const packageJson = ext.packageJSON as { name?: string; displayName?: string } | undefined;
        const name = (packageJson?.name || '').toLowerCase();
        const displayName = (packageJson?.displayName || '').toLowerCase();
        return name === 'tasksync' || displayName === 'tasksync';
    });
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    activationOutputChannel = outputChannel;
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine(`[${new Date().toISOString()}] AskAway: Extension activating...`);

    void ensureAskAwayBuildAgentInstalled(context);
    void ensureCoworkInstalled(context);
    void ensureRtkGlobalHooksInstalled();
    void ensureCopilotHookInstalled();
    void writeBudgetSentinels(context);
    void ensureBudgetHookInstalled();
    void ensureCacheTimerHookInstalled();
    void ensureToolIoHookInstalled();
    void writeSubagentModelSentinel();
    void ensureSubagentModelHookInstalled();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('askaway.subagentModel')) { void writeSubagentModelSentinel(); }
    }));

    // Enable debug logging globally on first activation (needed for token telemetry)
    (async () => {
        try {
            const globalConfig = vscode.workspace.getConfiguration('', null);
            await globalConfig.update(
                'github.copilot.chat.agentDebugLog.fileLogging.enabled',
                true,
                vscode.ConfigurationTarget.Global
            );
            logRuntime('Debug logging enabled globally');
        } catch (err) {
            logRuntime('Warning: Could not enable debug logging', err);
        }
    })();

    const conflictingTaskSync = findConflictingTaskSyncExtension();
    if (conflictingTaskSync) {
        const conflictMessage = `AskAway detected a potential tool conflict with installed extension "${conflictingTaskSync.id}". Disable TaskSync (or AskAway) to avoid ask_user routing issues.`;
        outputChannel.appendLine(`[${new Date().toISOString()}] AskAway: ${conflictMessage}`);
        vscode.window.showWarningMessage(
            conflictMessage,
            'Open Extensions'
        ).then(selection => {
            if (selection === 'Open Extensions') {
                vscode.commands.executeCommand('workbench.view.extensions');
            }
        });
    }

    try {
        // Initialize context manager for #terminal, #problems features
        logRuntime('Creating ContextManager', { type: typeof ContextManager });
        contextManager = new ContextManager();
        context.subscriptions.push({ dispose: () => contextManager?.dispose() });

        logRuntime('Creating AskAwayWebviewProvider', {
            providerType: typeof AskAwayWebviewProvider,
            viewType: AskAwayWebviewProvider?.viewType
        });
        const provider = new AskAwayWebviewProvider(context.extensionUri, context, contextManager);
        webviewProvider = provider;

        // Register the provider EARLY so sidebar loads fast
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(AskAwayWebviewProvider.viewType, provider),
            provider
        );

        // Register VS Code LM Tools (critical for Copilot — must be early)
        logRuntime('Registering language model tools');
        registerTools(context, provider);

        // Initialize Plan Board editor (lightweight, no I/O at init)
        logRuntime('Creating PlanEditorProvider', { type: typeof PlanEditorProvider });
        planEditor = new PlanEditorProvider(context.extensionUri);
        provider.setPlanEditor(planEditor);
        context.subscriptions.push(planEditor);
        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.openPlanBoard', () => planEditor?.open())
        );

        // ── Commands — registered synchronously, reference lazy-loaded services ──

        // Send current input command (for Keyboard Shortcuts)
        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.sendMessage', () => {
                provider.triggerSendFromShortcut();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.dumpLmTools', async () => {
                const outputPath = path.join(context.globalStorageUri.fsPath, 'lm-tools-catalog.json');
                await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
                const tools = vscode.lm.tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    tags: Array.from(tool.tags || []),
                    inputSchema: tool.inputSchema ?? null
                }));
                await fs.promises.writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), tools }, null, 2));
                await vscode.env.clipboard.writeText(outputPath);
                vscode.window.showInformationMessage(`AskAway LM tools catalog written to ${outputPath}`);
            })
        );

        // MCP commands
        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.startMcp', async () => {
                if (mcpServer && !mcpServer.isRunning()) {
                    await mcpServer.start();
                    vscode.window.showInformationMessage('AskAway MCP Server started');
                } else if (mcpServer?.isRunning()) {
                    vscode.window.showInformationMessage('AskAway MCP Server is already running');
                }
            }),
            vscode.commands.registerCommand('askaway.restartMcp', async () => {
                if (mcpServer) { await mcpServer.restart(); }
            }),
            vscode.commands.registerCommand('askaway.showMcpConfig', async () => {
                const config = (mcpServer as any).getMcpConfig?.();
                if (!config) {
                    vscode.window.showErrorMessage('MCP server not running');
                    return;
                }
                const selected = await vscode.window.showQuickPick(
                    [
                        { label: 'Kiro', description: 'Kiro IDE', value: 'kiro' },
                        { label: 'Cursor', description: 'Cursor Editor', value: 'cursor' },
                        { label: 'Antigravity', description: 'Gemini CLI', value: 'antigravity' }
                    ],
                    { placeHolder: 'Select MCP client to configure' }
                );
                if (!selected) return;
                const cfg = config[selected.value];
                const configJson = JSON.stringify(cfg.config, null, 2);
                const message = `Add this to ${cfg.path}:\n\n${configJson}`;
                const action = await vscode.window.showInformationMessage(message, 'Copy to Clipboard', 'Open File');
                if (action === 'Copy to Clipboard') {
                    await vscode.env.clipboard.writeText(configJson);
                    vscode.window.showInformationMessage('Configuration copied to clipboard');
                } else if (action === 'Open File') {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(cfg.path));
                }
            })
        );

        // Session commands
        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.openHistory', () => provider.openHistoryModal()),
            vscode.commands.registerCommand('askaway.newSession', () => provider.startNewSession()),
            vscode.commands.registerCommand('askaway.clearCurrentSession', async () => {
                const result = await vscode.window.showWarningMessage(
                    'Clear all tool calls from current session?',
                    { modal: true },
                    'Clear'
                );
                if (result === 'Clear') { provider.clearCurrentSession(); }
            }),
            vscode.commands.registerCommand('askaway.openSettings', () => provider.openSettingsModal())
        );

        // Remote server commands (lazy — actual server loaded in deferred block)
        const remotePort = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<number>('remotePort', 3000);
        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.startRemote', async () => {
                try {
                    await ensureRemoteServer(context, provider);
                    await startRemoteServer(remotePort);
                } catch (err: any) {
                    const msg = err?.message ?? String(err);
                    vscode.window.showErrorMessage(`AskAway Remote Server failed to start: ${msg}`);
                    outputChannel.appendLine(`[AskAway] Remote server start error: ${msg}\n${err?.stack ?? ''}`);
                }
            }),
            vscode.commands.registerCommand('askaway.stopRemote', () => {
                if (remoteServer) {
                    remoteServer.stop();
                    vscode.commands.executeCommand('setContext', 'askaway.remoteServerRunning', false);
                    vscode.window.showInformationMessage('AskAway Remote Server stopped');
                }
            }),
            vscode.commands.registerCommand('askaway.showRemoteUrl', () => {
                if (remoteServer) {
                    const info = remoteServer.getConnectionInfo();
                    if (info.port > 0) { showRemoteConnectionInfo(info); }
                    else { vscode.window.showWarningMessage('AskAway Remote Server is not running.'); }
                }
            }),
            vscode.commands.registerCommand('askaway.toggleRemoteStart', async () => {
                try {
                    await ensureRemoteServer(context, provider);
                    await startRemoteServer(remotePort);
                } catch (err: any) {
                    const msg = err?.message ?? String(err);
                    vscode.window.showErrorMessage(`AskAway Remote Server failed to start: ${msg}`);
                    outputChannel.appendLine(`[AskAway] Remote server start error: ${msg}\n${err?.stack ?? ''}`);
                }
            }),
            vscode.commands.registerCommand('askaway.toggleRemoteStop', async () => {
                if (!remoteServer) return;
                const info = remoteServer.getConnectionInfo();
                if (info.port <= 0) return;
                const action = await vscode.window.showQuickPick([
                    { label: '$(copy) Copy URL with PIN', description: 'Copy ready-to-use URL for mobile', action: 'copy' },
                    { label: '$(key) Show PIN', description: info.pin, action: 'pin' },
                    { label: '$(link-external) Show All URLs', description: 'View all connection options', action: 'urls' },
                    { label: '$(debug-disconnect) Stop Server', description: 'Stop the remote server', action: 'stop' }
                ], { placeHolder: `Remote Server running on port ${info.port}` });
                if (action?.action === 'copy') {
                    const networkUrl = info.urls.find(u => !u.includes('localhost')) || info.urls[0];
                    await vscode.env.clipboard.writeText(`${networkUrl}?pin=${info.pin}`);
                    vscode.window.showInformationMessage('URL with PIN copied to clipboard');
                } else if (action?.action === 'pin') {
                    await vscode.env.clipboard.writeText(info.pin);
                    vscode.window.showInformationMessage(`PIN ${info.pin} copied to clipboard`);
                } else if (action?.action === 'urls') {
                    showRemoteConnectionInfo(info);
                } else if (action?.action === 'stop') {
                    remoteServer.stop();
                    vscode.commands.executeCommand('setContext', 'askaway.remoteServerRunning', false);
                    vscode.window.showInformationMessage('AskAway Remote Server stopped');
                }
            }),
            vscode.commands.registerCommand('askaway.toggleRemote', async () => {
                if (remoteServer) {
                    const info = remoteServer.getConnectionInfo();
                    if (info.port > 0) { await vscode.commands.executeCommand('askaway.toggleRemoteStop'); }
                    else { await vscode.commands.executeCommand('askaway.toggleRemoteStart'); }
                } else {
                    await vscode.commands.executeCommand('askaway.toggleRemoteStart');
                }
            })
        );

        // Webex/Telegram commands (services loaded in deferred block)
        context.subscriptions.push(
            vscode.commands.registerCommand('askaway.authorizeWebex', async () => {
                const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                const clientId = config.get<string>('webex.clientId', '');
                if (!clientId) {
                    const action = await vscode.window.showWarningMessage('AskAway: Please set your Webex Client ID first.', 'Open Settings');
                    if (action === 'Open Settings') { vscode.commands.executeCommand('workbench.action.openSettings', 'askaway.webex.clientId'); }
                    return;
                }
                const clientSecret = config.get<string>('webex.clientSecret', '');
                if (!clientSecret) {
                    const action = await vscode.window.showWarningMessage('AskAway: Please set your Webex Client Secret first.', 'Open Settings');
                    if (action === 'Open Settings') { vscode.commands.executeCommand('workbench.action.openSettings', 'askaway.webex.clientSecret'); }
                    return;
                }
                const http = require('http');
                const callbackPort = 54321;
                const redirectUri = `http://localhost:${callbackPort}/callback`;
                const scopes = 'spark%3Aall';
                const authUrl = `https://webexapis.com/v1/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}`;
                const server = http.createServer(async (req: any, res: any) => {
                    const url = new URL(req.url, `http://localhost:${callbackPort}`);
                    if (url.pathname === '/callback') {
                        const code = url.searchParams.get('code');
                        if (code) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end('<html><body><h2>AskAway: Webex authorized!</h2><p>You can close this tab.</p></body></html>');
                            try {
                                const tokenResp = await fetch('https://webexapis.com/v1/access_token', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: new URLSearchParams({
                                        grant_type: 'authorization_code', client_id: clientId,
                                        client_secret: clientSecret, code, redirect_uri: redirectUri
                                    }).toString()
                                });
                                if (tokenResp.ok) {
                                    const data = await tokenResp.json() as any;
                                    await config.update('webex.accessToken', data.access_token, vscode.ConfigurationTarget.Global);
                                    await config.update('webex.refreshToken', data.refresh_token, vscode.ConfigurationTarget.Global);
                                    vscode.window.showInformationMessage(`AskAway: Webex authorized! Token expires in ${Math.round(data.expires_in / 3600)}h.`);
                                    webviewProvider?.getWebexService()?.reloadConfig();
                                } else {
                                    vscode.window.showErrorMessage(`AskAway: Token exchange failed: ${await tokenResp.text()}`);
                                }
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`AskAway: OAuth error: ${e.message}`);
                            }
                        } else {
                            res.writeHead(400, { 'Content-Type': 'text/html' });
                            res.end(`<html><body><h2>Authorization failed: ${url.searchParams.get('error') || 'Unknown error'}</h2></body></html>`);
                        }
                        setTimeout(() => server.close(), 1000);
                    }
                });
                server.listen(callbackPort, () => {
                    vscode.env.openExternal(vscode.Uri.parse(authUrl));
                    vscode.window.showInformationMessage('AskAway: Opening Webex authorization page...');
                });
                server.on('error', (err: any) => { vscode.window.showErrorMessage(`AskAway: OAuth callback error: ${err.message}`); });
                setTimeout(() => server.close(), 120000);
            }),
            vscode.commands.registerCommand('askaway.getTelegramChatId', async () => {
                if (telegramServiceInstance) { await telegramServiceInstance.getChatId(); }
                else { vscode.window.showWarningMessage('Telegram service not initialized yet.'); }
            })
        );

        // Initialize remote server context
        vscode.commands.executeCommand('setContext', 'askaway.remoteServerRunning', false);

        // ── Deferred initialization — heavy services loaded AFTER sidebar is ready ──
        setImmediate(async () => {
            let webexService: WebexServiceType | undefined;
            let telegramService: TelegramServiceType | undefined;

            // Initialize Webex independently so its failure does not block Telegram.
            try {
                const webexModule = await import('./services/webexService');
                const { WebexService } = webexModule;
                logRuntime('Webex module loaded', {
                    moduleKeys: Object.keys(webexModule),
                    ctorType: typeof WebexService
                });

                if (typeof WebexService !== 'function') {
                    throw new Error('WebexService import is not a constructor function');
                }

                webexService = new WebexService(outputChannel);
                provider.setWebexService(webexService);
                webexService.start();
                context.subscriptions.push({ dispose: () => webexService?.dispose() });

                context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.webex`) && webexService) {
                        webexService.reloadConfig();
                        webexService.start();
                    }
                }));
            } catch (err) {
                logRuntime('Webex deferred init failed', formatError(err));
                console.error('[AskAway] Webex deferred init error:', err);
            }

            // Initialize Telegram independently so it is available even if Webex fails.
            try {
                const telegramModule = await import('./services/telegramService');
                const { TelegramService } = telegramModule;
                logRuntime('Telegram module loaded', {
                    moduleKeys: Object.keys(telegramModule),
                    ctorType: typeof TelegramService
                });

                if (typeof TelegramService !== 'function') {
                    throw new Error('TelegramService import is not a constructor function');
                }

                telegramService = new TelegramService(outputChannel);
                telegramServiceInstance = telegramService;
                telegramService.setExtensionContext(context);
                provider.setTelegramService(telegramService);
                context.subscriptions.push({ dispose: () => telegramService?.dispose() });

                context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.telegram`) && telegramService) {
                        telegramService.reloadConfig();
                    }
                }));
            } catch (err) {
                logRuntime('Telegram deferred init failed', formatError(err));
                console.error('[AskAway] Telegram deferred init error:', err);
                vscode.window.showWarningMessage(
                    'AskAway: Telegram service failed to initialize. Open "AskAway" output for details.',
                    'Open Output'
                ).then(selection => {
                    if (selection === 'Open Output') {
                        outputChannel.show(true);
                    }
                });
            }

            // File change tracker for Webex/Telegram
            context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.scheme !== 'file') return;
                const relativePath = vscode.workspace.asRelativePath(e.document.uri);
                if (webexService && webexService.getActiveTaskCount() > 0) {
                    webexService.trackFileChange(relativePath);
                    webexService.notifyCopilotActivity();
                }
                if (telegramService && telegramService.getActiveTaskCount() > 0) {
                    telegramService.trackFileChange(relativePath);
                    telegramService.notifyCopilotActivity();
                }
            }));

            // MCP Server initialization should not block other services.
            try {
                mcpServer = new McpServerManager(provider);
                const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                const mcpEnabled = config.get<boolean>('mcpEnabled', false);
                const autoStartIfClients = config.get<boolean>('mcpAutoStartIfClients', true);
                if (mcpEnabled) {
                    mcpServer.start();
                } else if (autoStartIfClients) {
                    hasExternalMcpClientsAsync().then(hasClients => {
                        if (hasClients && mcpServer) { mcpServer.start(); }
                    }).catch(() => {});
                }

                // Auto-start Remote Server if configured
                const remoteEnabled = config.get<boolean>('remoteEnabled', false);
                if (remoteEnabled) {
                    logRuntime('Remote auto-start requested', { remotePort: config.get<number>('remotePort', 3000) });
                    await ensureRemoteServer(context, provider);
                    await startRemoteServer(config.get<number>('remotePort', 3000));
                }
            } catch (err) {
                logRuntime('MCP/Remote deferred init failed', formatError(err));
                console.error('[AskAway] MCP/Remote deferred init error:', err);
            }
        });

    outputChannel.appendLine(`[${new Date().toISOString()}] AskAway: Activation complete!`);
    } catch (error) {
        console.error('AskAway Activation Error:', error);
        logRuntime('Activation failed', formatError(error));
        outputChannel.appendLine(`[AskAway] CRITICAL ACTIVATION ERROR: ${error}`);
    }
}

/**
 * Lazily load and initialize the Remote UI Server (imports express + socket.io)
 */
async function ensureRemoteServer(context: vscode.ExtensionContext, provider: AskAwayWebviewProvider): Promise<void> {
    if (remoteServer) return;

    const remoteModule = await import('./server/remoteUiServer');
    const { RemoteUiServer } = remoteModule;
    type RemoteMessage = import('./server/remoteUiServer').RemoteMessage;

    logRuntime('Remote server module loaded', {
        moduleKeys: Object.keys(remoteModule),
        remoteCtorType: typeof RemoteUiServer
    });

    if (typeof RemoteUiServer !== 'function') {
        throw new Error('RemoteUiServer import is not a constructor function');
    }

    remoteServer = new RemoteUiServer(context.extensionUri, context);
    context.subscriptions.push(remoteServer);

    // Create output channel for remote server info
    if (!remoteOutputChannel) {
        remoteOutputChannel = vscode.window.createOutputChannel('AskAway Remote');
        context.subscriptions.push(remoteOutputChannel);
    }

    // Wire up remote server with webview provider
    remoteServer.onGetState(() => provider.getStateForRemote());
    remoteServer.onMessage((message: RemoteMessage, _respond) => {
        provider.handleRemoteMessage(message as any);
    });
    provider.setRemoteBroadcastCallback((message) => {
        remoteServer?.broadcast(message as RemoteMessage);
    });
}

/**
 * Start the remote UI server
 */
async function startRemoteServer(preferredPort: number): Promise<void> {
    if (!remoteServer) return;
    
    try {
        logRuntime('Starting remote server', { preferredPort });
        const port = await remoteServer.start(preferredPort);
        const info = remoteServer.getConnectionInfo();
        
        // Update context for icon toggle
        vscode.commands.executeCommand('setContext', 'askaway.remoteServerRunning', true);
        
        // Show in output channel
        remoteOutputChannel?.clear();
        remoteOutputChannel?.appendLine('='.repeat(50));
        remoteOutputChannel?.appendLine('  AskAway Remote Server Started');
        remoteOutputChannel?.appendLine('='.repeat(50));
        remoteOutputChannel?.appendLine('');
        remoteOutputChannel?.appendLine(`📱 Access from your phone or browser:`);
        remoteOutputChannel?.appendLine('');
        info.urls.forEach(url => {
            remoteOutputChannel?.appendLine(`   ${url}`);
        });
        remoteOutputChannel?.appendLine('');
        remoteOutputChannel?.appendLine(`🔐 PIN: ${info.pin}`);
        remoteOutputChannel?.appendLine('');
        remoteOutputChannel?.appendLine('Tip: Use the network URL (192.168.x.x) to access from mobile');
        remoteOutputChannel?.appendLine('='.repeat(50));
        remoteOutputChannel?.show(true);
        
        // Show notification with quick action
        const action = await vscode.window.showInformationMessage(
            `AskAway Remote running on port ${port}. PIN: ${info.pin}`,
            'Copy URL',
            'Show Details'
        );
        
        if (action === 'Copy URL') {
            const networkUrl = info.urls.find(u => !u.includes('localhost')) || info.urls[0];
            await vscode.env.clipboard.writeText(`${networkUrl}?pin=${info.pin}`);
            vscode.window.showInformationMessage('URL copied to clipboard');
        } else if (action === 'Show Details') {
            showRemoteConnectionInfo(info);
        }
    } catch (err) {
        logRuntime('Remote server start failed', formatError(err));
        vscode.window.showErrorMessage(`Failed to start Remote Server: ${err}`);
    }
}

/**
 * Show remote connection info in a QuickPick
 */
async function showRemoteConnectionInfo(info: { urls: string[]; pin: string; port: number }): Promise<void> {
    const items = [
        { label: '$(key) PIN', description: info.pin, detail: 'Enter this PIN on your phone' },
        ...info.urls.map(url => ({
            label: url.includes('localhost') ? '$(globe) Local URL' : '$(broadcast) Network URL',
            description: url,
            detail: url.includes('localhost') ? 'Access from this computer' : 'Access from phone/tablet on same WiFi'
        })),
        { label: '$(copy) Copy Network URL with PIN', description: '', detail: 'Copy ready-to-use URL for mobile' }
    ];
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'AskAway Remote Connection Info'
    });
    
    if (selected) {
        if (selected.label.includes('Copy')) {
            const networkUrl = info.urls.find(u => !u.includes('localhost')) || info.urls[0];
            await vscode.env.clipboard.writeText(`${networkUrl}?pin=${info.pin}`);
            vscode.window.showInformationMessage('URL with PIN copied to clipboard');
        } else if (selected.description) {
            await vscode.env.clipboard.writeText(selected.description);
            vscode.window.showInformationMessage('Copied to clipboard');
        }
    }
}

export async function deactivate() {
    // Save current tool call history to persisted history before deactivating
    if (webviewProvider) {
        webviewProvider.saveCurrentSessionToHistory();
        webviewProvider = undefined;
    }

    if (remoteServer) {
        remoteServer.dispose();
        remoteServer = undefined;
    }

    if (mcpServer) {
        await mcpServer.dispose();
        mcpServer = undefined;
    }

    killAllGradleRuns();
}

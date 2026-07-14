import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { AskAwayWebviewProvider } from './webview/webviewProvider';
import { getImageMimeType } from './utils/imageUtils';
import { PlanTaskStatus } from './plan/planTypes';
import { dispatchGradle, GradleInput } from './gradle/gradleEngine';

/**
 * Append a per-invocation record for an AskAway LM tool to
 * ~/.askaway/tool-calls.jsonl for offline "where do we spend output tokens?"
 * analysis. approxTokens ≈ chars/4 (never sent to the model; best-effort).
 */
function logToolCall(tool: string, outputText: string, detail?: string): void {
    try {
        const chars = typeof outputText === 'string' ? outputText.length : 0;
        const record = {
            ts: Date.now(),
            tool,
            detail: detail ?? null,
            outputChars: chars,
            approxTokens: Math.ceil(chars / 4),
        };
        const dir = path.join(os.homedir(), '.askaway');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'tool-calls.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    } catch {
        // Best-effort — never let logging affect a tool call.
    }
}

/**
 * Compute how many credits (nanoAiu) the CURRENT turn has spent, straight from the
 * active Copilot debug log (independent of the webview being open). Finds the newest
 * debug-log session for this workspace, then sums copilotUsageNanoAiu of every
 * llm_request logged at/after the last user_message (= the current turn boundary).
 */
async function computeTurnSpend(context: vscode.ExtensionContext): Promise<{ nanoAiu: number; requestCount: number; sessionId: string | null }> {
    const empty = { nanoAiu: 0, requestCount: 0, sessionId: null as string | null };
    const storageUriPath = context.storageUri?.fsPath;
    if (!storageUriPath) { return empty; }
    const debugRoot = path.join(path.dirname(storageUriPath), 'GitHub.copilot-chat', 'debug-logs');
    let sessionDirs: fs.Dirent[];
    try { sessionDirs = await fs.promises.readdir(debugRoot, { withFileTypes: true }); }
    catch { return empty; }

    // Newest session by main.jsonl mtime = the active chat.
    let newest: { dir: string; mtime: number; sid: string } | null = null;
    for (const d of sessionDirs) {
        if (!d.isDirectory()) { continue; }
        const f = path.join(debugRoot, d.name, 'main.jsonl');
        try {
            const st = await fs.promises.stat(f);
            if (!newest || st.mtimeMs > newest.mtime) { newest = { dir: path.join(debugRoot, d.name), mtime: st.mtimeMs, sid: d.name }; }
        } catch { /* skip unreadable */ }
    }
    if (!newest) { return empty; }

    // The active session dir holds main.jsonl (parent turn) PLUS runSubagent-*.jsonl child
    // sessions. Sub-agent LLM calls are billed but logged ONLY in the child files, so the budget
    // must sum ALL of them — otherwise heavy sub-agent turns look far under budget than reality.
    let childFiles: string[] = [];
    try {
        childFiles = (await fs.promises.readdir(newest.dir))
            .filter(n => n.endsWith('.jsonl') && !n.startsWith('title-') && (n === 'main.jsonl' || n.startsWith('runSubagent')))
            .map(n => path.join(newest!.dir, n));
    } catch { childFiles = [path.join(newest.dir, 'main.jsonl')]; }

    // The parent turn boundary is the newest user_message in main.jsonl. Child logs have their
    // own user_message (the sub-agent prompt) which must NOT move the boundary.
    let lastSubmitTs = 0;
    try {
        const mainData = await fs.promises.readFile(path.join(newest.dir, 'main.jsonl'), 'utf8');
        for (const line of mainData.split('\n')) {
            if (line.indexOf('"type":"user_message"') === -1) { continue; }
            try { const p = JSON.parse(line) as { ts?: number }; if (typeof p.ts === 'number' && p.ts > lastSubmitTs) { lastSubmitTs = p.ts; } } catch { /* skip */ }
        }
    } catch { return empty; }

    let nanoAiu = 0, requestCount = 0;
    for (const file of childFiles) {
        let data: string;
        try { data = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
        for (const line of data.split('\n')) {
            if (line.indexOf('llm_request') === -1) { continue; }
            let p: { ts?: number; attrs?: { copilotUsageNanoAiu?: number } };
            try { p = JSON.parse(line); } catch { continue; }
            const ts = typeof p.ts === 'number' ? p.ts : 0;
            if (ts < lastSubmitTs) { continue; }
            nanoAiu += typeof p.attrs?.copilotUsageNanoAiu === 'number' ? p.attrs.copilotUsageNanoAiu : 0;
            requestCount += 1;
        }
    }
    return { nanoAiu, requestCount, sessionId: newest.sid };
}



export interface Input {
    question: string;
    taskId?: string;
    taskStatus?: PlanTaskStatus;
}

export interface AskUserToolResult {
    response: string;
    attachments: string[];
    queue: boolean;
    taskId?: string;
    taskStatus?: PlanTaskStatus;
}

type LspBridgeOperation = 'definition' | 'references' | 'implementation' | 'type_definition' | 'hover' | 'document_symbols' | 'workspace_symbols' | 'diagnostics';

interface LspBridgeInput {
    operation: LspBridgeOperation;
    filePath?: string;
    line?: number;
    character?: number;
    query?: string;
    maxResults?: number;
}

function clampMaxResults(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 30;
    }
    return Math.max(1, Math.min(100, Math.floor(value)));
}

function resolveWorkspaceUri(filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) {
        return vscode.Uri.file(filePath);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return vscode.Uri.file(path.resolve(filePath));
    }
    return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
}

function formatUri(uri: vscode.Uri): string {
    if (uri.scheme === 'file') {
        return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.toString();
}

function formatRange(range: vscode.Range): { start: { line: number; character: number }; end: { line: number; character: number } } {
    return {
        start: { line: range.start.line + 1, character: range.start.character + 1 },
        end: { line: range.end.line + 1, character: range.end.character + 1 }
    };
}

function formatLocation(item: vscode.Location | vscode.LocationLink): Record<string, unknown> {
    if ('targetUri' in item) {
        return {
            file: formatUri(item.targetUri),
            range: formatRange(item.targetRange),
            selectionRange: item.targetSelectionRange ? formatRange(item.targetSelectionRange) : undefined,
            originSelectionRange: item.originSelectionRange ? formatRange(item.originSelectionRange) : undefined
        };
    }

    return {
        file: formatUri(item.uri),
        range: formatRange(item.range)
    };
}

function stringifyMarkdown(value: vscode.MarkdownString | vscode.MarkedString): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof vscode.MarkdownString) {
        return value.value;
    }
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

function formatSymbolKind(kind: vscode.SymbolKind): string {
    return vscode.SymbolKind[kind] ?? String(kind);
}

function formatDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): Record<string, unknown> {
    if (symbol instanceof vscode.DocumentSymbol) {
        return {
            name: symbol.name,
            detail: symbol.detail,
            kind: formatSymbolKind(symbol.kind),
            range: formatRange(symbol.range),
            selectionRange: formatRange(symbol.selectionRange),
            children: symbol.children.map(formatDocumentSymbol)
        };
    }

    return {
        name: symbol.name,
        kind: formatSymbolKind(symbol.kind),
        file: formatUri(symbol.location.uri),
        range: formatRange(symbol.location.range),
        containerName: symbol.containerName
    };
}

function formatDiagnosticSeverity(severity: vscode.DiagnosticSeverity): string {
    return vscode.DiagnosticSeverity[severity] ?? String(severity);
}

function requireFileAndPosition(input: LspBridgeInput): { uri: vscode.Uri; position: vscode.Position } | string {
    if (!input.filePath) {
        return 'filePath is required for this operation';
    }
    if (typeof input.line !== 'number' || typeof input.character !== 'number') {
        return 'line and character are required for this operation (1-based)';
    }
    return {
        uri: resolveWorkspaceUri(input.filePath),
        position: new vscode.Position(Math.max(0, Math.floor(input.line) - 1), Math.max(0, Math.floor(input.character) - 1))
    };
}

async function runLspBridge(input: LspBridgeInput, token: vscode.CancellationToken): Promise<Record<string, unknown>> {
    const maxResults = clampMaxResults(input.maxResults);

    switch (input.operation) {
        case 'definition':
        case 'references':
        case 'implementation':
        case 'type_definition': {
            const target = requireFileAndPosition(input);
            if (typeof target === 'string') {
                return { error: target };
            }
            const command = input.operation === 'definition'
                ? 'vscode.executeDefinitionProvider'
                : input.operation === 'references'
                    ? 'vscode.executeReferenceProvider'
                    : input.operation === 'implementation'
                        ? 'vscode.executeImplementationProvider'
                        : 'vscode.executeTypeDefinitionProvider';
            const locations = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(command, target.uri, target.position);
            return {
                operation: input.operation,
                file: formatUri(target.uri),
                position: { line: target.position.line + 1, character: target.position.character + 1 },
                count: locations?.length ?? 0,
                results: (locations ?? []).slice(0, maxResults).map(formatLocation)
            };
        }

        case 'hover': {
            const target = requireFileAndPosition(input);
            if (typeof target === 'string') {
                return { error: target };
            }
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', target.uri, target.position);
            return {
                operation: input.operation,
                file: formatUri(target.uri),
                position: { line: target.position.line + 1, character: target.position.character + 1 },
                count: hovers?.length ?? 0,
                results: (hovers ?? []).slice(0, maxResults).map(hover => ({
                    contents: hover.contents.map(stringifyMarkdown),
                    range: hover.range ? formatRange(hover.range) : undefined
                }))
            };
        }

        case 'document_symbols': {
            if (!input.filePath) {
                return { error: 'filePath is required for document_symbols' };
            }
            const uri = resolveWorkspaceUri(input.filePath);
            const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri);
            return {
                operation: input.operation,
                file: formatUri(uri),
                count: symbols?.length ?? 0,
                results: (symbols ?? []).slice(0, maxResults).map(formatDocumentSymbol)
            };
        }

        case 'workspace_symbols': {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', input.query ?? '');
            return {
                operation: input.operation,
                query: input.query ?? '',
                count: symbols?.length ?? 0,
                results: (symbols ?? []).slice(0, maxResults).map(formatDocumentSymbol)
            };
        }

        case 'diagnostics': {
            const diagnostics = input.filePath
                ? vscode.languages.getDiagnostics(resolveWorkspaceUri(input.filePath))
                : vscode.languages.getDiagnostics().flatMap(([uri, items]) => items.map(item => ({ uri, item })));
            const results = Array.isArray(diagnostics) && diagnostics.length > 0 && 'uri' in diagnostics[0]
                ? (diagnostics as Array<{ uri: vscode.Uri; item: vscode.Diagnostic }>).slice(0, maxResults).map(({ uri, item }) => ({
                    file: formatUri(uri),
                    range: formatRange(item.range),
                    severity: formatDiagnosticSeverity(item.severity),
                    code: item.code,
                    source: item.source,
                    message: item.message
                }))
                : (diagnostics as vscode.Diagnostic[]).slice(0, maxResults).map(item => ({
                    file: input.filePath,
                    range: formatRange(item.range),
                    severity: formatDiagnosticSeverity(item.severity),
                    code: item.code,
                    source: item.source,
                    message: item.message
                }));
            return {
                operation: input.operation,
                file: input.filePath,
                count: Array.isArray(diagnostics) ? diagnostics.length : 0,
                results
            };
        }

        default:
            return { error: `Unsupported operation: ${String(input.operation)}` };
    }
}

/**
 * Reads a file as Uint8Array for efficient binary handling
 */
async function readFileAsBuffer(filePath: string): Promise<Uint8Array> {
    const buffer = await fs.promises.readFile(filePath);
    return new Uint8Array(buffer);
}

/**
 * Creates a cancellation promise with proper cleanup to prevent memory leaks.
 * Returns both the promise and a dispose function to clean up the event listener.
 */
function createCancellationPromise(token: vscode.CancellationToken): {
    promise: Promise<never>;
    dispose: () => void;
} {
    let disposable: vscode.Disposable | undefined;

    const promise = new Promise<never>((_, reject) => {
        if (token.isCancellationRequested) {
            reject(new vscode.CancellationError());
            return;
        }
        disposable = token.onCancellationRequested(() => {
            reject(new vscode.CancellationError());
        });
    });

    return {
        promise,
        dispose: () => disposable?.dispose()
    };
}

/**
 * Core logic to ask user, reusable by MCP server
 * Queue handling and history tracking is done in waitForUserResponse()
 * Plan mode: taskId and taskStatus are passed through for orchestrator logic
 */
export async function askUser(
    params: Input,
    provider: AskAwayWebviewProvider,
    token: vscode.CancellationToken
): Promise<AskUserToolResult> {
    // Check if already cancelled before starting
    if (token.isCancellationRequested) {
        // Signal messaging services that Copilot conversation is done
        provider.getWebexService()?.notifyCopilotStopped();
        provider.getTelegramService()?.notifyCopilotStopped();
        throw new vscode.CancellationError();
    }

    // ── Plan mode: If Copilot reports task status, let the orchestrator handle it ──
    // Auto-map to active plan task if Copilot didn't include taskId
    let taskId = params.taskId;
    let taskStatus = params.taskStatus;
    if (!taskId) {
        const activeId = provider.getActivePlanTaskId();
        if (activeId) {
            taskId = activeId;
            // Copilot didn't include taskId — it doesn't know about the plan system.
            // Use AI to classify: is this a completion report or a mid-task question?
            taskStatus = await provider.classifyTaskProgress(activeId, params.question);
        }
    }
    if (taskId && taskStatus) {
        const planResult = await provider.handlePlanTaskUpdate(
            taskId, 
            taskStatus, 
            params.question,
            token
        );
        if (planResult) {
            return {
                response: planResult.response,
                attachments: [],
                queue: true,  // Keep Copilot calling ask_user for the next plan task
                taskId: taskId,
                taskStatus: taskStatus
            };
        }
        // If planResult is null, fall through to normal ask_user flow
    }

    // Notify messaging services that Copilot is still alive (resets idle timer)
    provider.getWebexService()?.notifyCopilotActivity();
    provider.getTelegramService()?.notifyCopilotActivity();
    provider.getTelegramService()?.notifyToolCallStarted();

    // Create cancellation promise with cleanup capability
    const cancellation = createCancellationPromise(token);

    try {
        // Race the user response against cancellation
        const result = await Promise.race([
            provider.waitForUserResponse(params.question),
            cancellation.promise
        ]);

        // Notify Telegram that the tool call returned (Copilot is processing again)
        provider.getTelegramService()?.notifyToolCallReturned();

        // Handle case where request was superseded by another call
        if (result.cancelled) {
            return {
                response: result.value,
                attachments: [],
                queue: result.queue
            };
        }

        let responseText = result.value;
        const validAttachments: string[] = [];

        // Process attachments to resolve context content
        if (result.attachments && result.attachments.length > 0) {
            for (const att of result.attachments) {
                if (att.uri.startsWith('context://')) {
                    // Compact context attachment — minimal markers to save tokens
                    responseText += `\n--- ${att.name} ---\n`;

                    const content = await provider.resolveContextContent(att.uri);
                    if (content) {
                        responseText += content;
                    }

                    responseText += '\n---\n';
                } else {
                    // Regular file attachment
                    validAttachments.push(att.uri);
                }
            }
        }

        // ── Plan mode: Auto-merge user feedback into task instructions ──
        // When Copilot asks the user mid-task and the user responds,
        // merge the user's response into the task description so context accumulates.
        const mergeTaskId = params.taskId || provider.getActivePlanTaskId();
        if (mergeTaskId && (params.taskStatus === 'in-progress' || (!params.taskStatus && provider.getActivePlanTaskId()))) {
            provider.mergeUserFeedbackIntoTask(mergeTaskId, params.question, responseText);
        }

        // Keep Copilot in the loop when there's an active plan task
        const hasActivePlan = !!provider.getActivePlanTaskId();

        return {
            response: responseText,
            attachments: validAttachments,
            queue: result.queue || hasActivePlan
        };
    } catch (error) {
        // Re-throw cancellation errors without logging (they're expected)
        if (error instanceof vscode.CancellationError) {
            // Signal messaging services that Copilot conversation ended
            provider.getWebexService()?.notifyCopilotStopped();
            provider.getTelegramService()?.notifyCopilotStopped();
            throw error;
        }
        // Log other errors
        console.error('[AskAway] askUser error:', error instanceof Error ? error.message : error);
        // Show error to user so they know something went wrong
        vscode.window.showErrorMessage(`AskAway: ${error instanceof Error ? error.message : 'Failed to show question'}`);
        return {
            response: '',
            attachments: [],
            queue: false
        };
    } finally {
        // Always clean up the cancellation listener to prevent memory leaks
        cancellation.dispose();
    }
}

// ── ripgrep helpers ──────────────────────────────────────────────────────────

interface RgSearchInput {
    pattern: string;
    path?: string;
    fileType?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    contextLines?: number;
    maxResults?: number;
    includeGlob?: string;
    excludeGlob?: string;
}

function findRgBinary(): string | undefined {
    // 1. System PATH
    const pathDirs = (process.env.PATH ?? '').split(':');
    for (const dir of pathDirs) {
        const candidate = path.join(dir, 'rg');
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
    }
    // 2. VS Code's bundled ripgrep (covers macOS arm64 and x64)
    const appRoot = vscode.env.appRoot;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const plaform = process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin';
    for (const pkg of ['@vscode/ripgrep-universal', '@vscode/ripgrep']) {
        const candidate = path.join(appRoot, 'node_modules', pkg, 'bin', `${plaform}-${arch}`, 'rg');
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
    }
    return undefined;
}

async function runRgSearch(input: RgSearchInput): Promise<string> {
    const rgBin = findRgBinary();
    if (!rgBin) {
        return 'Error: ripgrep (rg) not found. Install with: brew install ripgrep';
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const searchPath = input.path
        ? (path.isAbsolute(input.path) ? input.path : path.join(workspaceRoot, input.path))
        : workspaceRoot;

    const maxResults = typeof input.maxResults === 'number' ? Math.max(1, Math.min(200, input.maxResults)) : 50;
    const contextLines = typeof input.contextLines === 'number' ? Math.max(0, Math.min(10, input.contextLines)) : 2;

    const args: string[] = ['--json', '--line-number', `--max-count=${maxResults}`];
    if (contextLines > 0) { args.push(`-C${contextLines}`); }
    if (!input.caseSensitive) { args.push('--ignore-case'); }
    if (input.wholeWord) { args.push('--word-regexp'); }
    if (input.fileType) {
        for (const t of input.fileType.split(',').map(s => s.trim()).filter(Boolean)) {
            args.push('--type', t);
        }
    }
    if (input.includeGlob) { args.push('--glob', input.includeGlob); }
    if (input.excludeGlob) { args.push('--glob', `!${input.excludeGlob}`); }
    args.push('--', input.pattern, searchPath);

    return new Promise((resolve) => {
        const proc = childProcess.spawn(rgBin, args, { timeout: 15000 });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
        proc.on('close', (code) => {
            if (code !== 0 && code !== 1) {
                // rg exit 1 = no matches (normal), 2+ = error
                const errMsg = Buffer.concat(errChunks).toString().trim();
                resolve(`Error (rg exit ${code}): ${errMsg || 'unknown'}`);
                return;
            }
            const raw = Buffer.concat(chunks).toString();
            if (!raw.trim()) {
                resolve(`No matches for pattern "${input.pattern}"`);
                return;
            }
            // Parse --json output: lines of type match, begin, end, summary
            const lines = raw.split('\n').filter(Boolean);
            let totalMatches = 0;
            let currentFile = '';
            const parts: string[] = [];

            for (const line of lines) {
                try {
                    const obj = JSON.parse(line) as { type: string; data: Record<string, unknown> };
                    if (obj.type === 'begin') {
                        const p = (obj.data as { path: { text: string } }).path?.text ?? '';
                        currentFile = vscode.workspace.asRelativePath(p, false);
                        parts.push(`\n${currentFile}`);
                    } else if (obj.type === 'match') {
                        const d = obj.data as {
                            line_number: number;
                            lines: { text: string };
                            submatches: Array<{ match: { text: string } }>;
                        };
                        const ln = d.line_number;
                        const text = (d.lines?.text ?? '').replace(/\n$/, '');
                        parts.push(`  ${ln}: ${text}`);
                        totalMatches++;
                    } else if (obj.type === 'context') {
                        const d = obj.data as { line_number: number; lines: { text: string } };
                        const text = (d.lines?.text ?? '').replace(/\n$/, '');
                        parts.push(`  ${d.line_number}- ${text}`);
                    } else if (obj.type === 'summary') {
                        const s = obj.data as { stats: { matches: number; files_searched: number } };
                        const stats = s.stats;
                        parts.push(`\n--- ${stats?.matches ?? totalMatches} match(es) in ${stats?.files_searched ?? '?'} files searched ---`);
                    }
                } catch { /* skip malformed line */ }
            }
            resolve(parts.join('\n'));
        });
        proc.on('error', (err) => resolve(`Error spawning rg: ${err.message}`));
    });
}

// ── read_doc: progressive reader for markdown / logs / long text files ──────────
// Instead of dumping an entire file into context, this returns a cheap "gist" first
// (a heading outline for markdown, or a head/tail + error index for logs) with line
// numbers, so the agent can then request only the specific section / range / matches
// it needs. Same philosophy as code_nav: find WHERE, then read the narrow slice.
interface ReadDocInput {
    filePath: string;
    mode?: 'outline' | 'section' | 'search';
    heading?: string;
    startLine?: number;
    endLine?: number;
    query?: string;
    maxResults?: number;
    maxLevel?: number;
}

const READ_DOC_MAX_LINES = 400;      // cap a single section/range read
const READ_DOC_ERROR_RE = /\b(error|exception|fatal|fail(?:ed|ure)?|traceback|panic|warn(?:ing)?)\b/i;

function resolveDocPath(filePath: string): string {
    if (!filePath) { return ''; }
    if (filePath.startsWith('~')) { filePath = path.join(os.homedir(), filePath.slice(1)); }
    if (path.isAbsolute(filePath)) { return filePath; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return path.join(root, filePath);
}

function readDocLines(abs: string): string[] {
    const raw = fs.readFileSync(abs, 'utf8');
    return raw.split('\n');
}

function runReadDoc(input: ReadDocInput): string {
    const abs = resolveDocPath(input.filePath);
    if (!abs) { return 'Error: filePath is required.'; }
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return `Error: file not found: ${input.filePath}`; }
    if (!st.isFile()) { return `Error: not a file: ${input.filePath}`; }
    if (st.size > 32 * 1024 * 1024) { return `Error: file too large (${(st.size / 1048576).toFixed(1)}MB > 32MB).`; }

    let lines: string[];
    try { lines = readDocLines(abs); } catch (e) { return `Error reading file: ${(e as Error).message}`; }
    const total = lines.length;
    const rel = vscode.workspace.asRelativePath(abs, false);
    const mode = input.mode ?? 'outline';

    // ── SECTION: return a specific heading block or an explicit line range ──
    if (mode === 'section') {
        let start = 1, end = total;
        if (input.heading) {
            const want = input.heading.trim().toLowerCase();
            let hIdx = -1, hLevel = 6;
            for (let i = 0; i < total; i++) {
                const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
                if (m && m[2].trim().toLowerCase() === want) { hIdx = i; hLevel = m[1].length; break; }
            }
            if (hIdx < 0) {
                // fall back to first heading that CONTAINS the query
                for (let i = 0; i < total; i++) {
                    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
                    if (m && m[2].trim().toLowerCase().includes(want)) { hIdx = i; hLevel = m[1].length; break; }
                }
            }
            if (hIdx < 0) { return `Heading "${input.heading}" not found in ${rel}. Run mode:"outline" to list headings.`; }
            start = hIdx + 1;
            end = total;
            for (let i = hIdx + 1; i < total; i++) {
                const m = /^(#{1,6})\s+/.exec(lines[i]);
                if (m && m[1].length <= hLevel) { end = i; break; }
            }
        } else {
            start = Math.max(1, input.startLine ?? 1);
            end = Math.min(total, input.endLine ?? Math.min(total, start + READ_DOC_MAX_LINES - 1));
        }
        if (end - start + 1 > READ_DOC_MAX_LINES) { end = start + READ_DOC_MAX_LINES - 1; }
        const body = lines.slice(start - 1, end)
            .map((l, i) => `${start + i}: ${l}`).join('\n');
        const more = end < total ? `\n… (${total - end} more lines; request the next range with mode:"section")` : '';
        return `${rel}  [lines ${start}-${end} of ${total}]\n${body}${more}`;
    }

    // ── SEARCH: return matching lines with line numbers (great for logs) ──
    if (mode === 'search') {
        if (!input.query) { return 'Error: mode "search" requires a query.'; }
        const max = Math.max(1, Math.min(200, input.maxResults ?? 50));
        let re: RegExp;
        try { re = new RegExp(input.query, 'i'); } catch { re = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
        const hits: string[] = [];
        for (let i = 0; i < total && hits.length < max; i++) {
            if (re.test(lines[i])) { hits.push(`${i + 1}: ${lines[i]}`); }
        }
        if (!hits.length) { return `No matches for /${input.query}/ in ${rel} (${total} lines).`; }
        const capped = hits.length >= max ? ` (first ${max}; refine query for more)` : '';
        return `${rel}  [${hits.length} match(es)${capped} of ${total} lines]\n${hits.join('\n')}\n\nUse mode:"section" with startLine/endLine to read around any hit.`;
    }

    // ── OUTLINE (default): headings for markdown, or head/tail + error index for logs ──
    const maxLevel = Math.max(1, Math.min(6, input.maxLevel ?? 3));
    let inFence = false;
    const headings: string[] = [];
    for (let i = 0; i < total; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
        if (inFence) { continue; }
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m && m[1].length <= maxLevel) {
            const level = m[1].length;
            headings.push(`${'  '.repeat(level - 1)}L${i + 1}  ${'#'.repeat(level)} ${m[2].trim()}`);
        }
    }

    if (headings.length >= 2) {
        return `${rel}  [${total} lines · ${headings.length} headings (≤ H${maxLevel})]\n`
            + `Outline (read a block with mode:"section" heading:"…" or startLine/endLine):\n\n`
            + headings.join('\n');
    }

    // No usable heading structure → treat as a log / plain text: gist = head + tail + error index.
    const headN = Math.min(15, total);
    const tailN = Math.min(15, Math.max(0, total - headN));
    const head = lines.slice(0, headN).map((l, i) => `${i + 1}: ${l}`).join('\n');
    const tail = tailN > 0
        ? lines.slice(total - tailN).map((l, i) => `${total - tailN + i + 1}: ${l}`).join('\n')
        : '';
    const errIdx: string[] = [];
    for (let i = 0; i < total && errIdx.length < 40; i++) {
        if (READ_DOC_ERROR_RE.test(lines[i])) { errIdx.push(`${i + 1}: ${lines[i].trim().slice(0, 160)}`); }
    }
    const sizeKb = (st.size / 1024).toFixed(1);
    return `${rel}  [${total} lines · ${sizeKb} KB · no markdown headings → log/text gist]\n\n`
        + `── head (1-${headN}) ──\n${head}\n\n`
        + (tail ? `── tail (${total - tailN + 1}-${total}) ──\n${tail}\n\n` : '')
        + (errIdx.length
            ? `── error/warn lines (${errIdx.length}${errIdx.length >= 40 ? '+' : ''}) ──\n${errIdx.join('\n')}\n\n`
            : `── no error/warn lines matched ──\n\n`)
        + `Read any span with mode:"section" (startLine/endLine) or filter with mode:"search" query:"…".`;
}

export function registerTools(context: vscode.ExtensionContext, provider: AskAwayWebviewProvider) {
    let askUserTool: vscode.Disposable | undefined;
    try {
        askUserTool = vscode.lm.registerTool('ask_user', {
        prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<Input>) {
            const rawQuestion = typeof options?.input?.question === 'string' ? options.input.question : '';
            const questionPreview = rawQuestion.trim().replace(/\s+/g, ' ');

            const MAX_PREVIEW_LEN = 40;
            const truncated = questionPreview.length > MAX_PREVIEW_LEN
                ? questionPreview.slice(0, MAX_PREVIEW_LEN - 3) + '...'
                : questionPreview;

            return {
                invocationMessage: truncated ? `ask_user: ${truncated}` : 'ask_user'
            };
        },
        async invoke(options: vscode.LanguageModelToolInvocationOptions<Input>, token: vscode.CancellationToken) {
            const params = options.input;

            try {
                const result = await askUser(params, provider, token);

                // Force queued:true when plan mode is active, so Copilot keeps calling
                const isQueued = result.queue || !!provider.getActivePlanTaskId();
                const rtkEnabled = provider.isRtkCompressionEnabled();
                const rtkDocPrompt = rtkEnabled ? await provider.getRtkInstructionPrompt() : '';
                const nextInstructions: string[] = [
                    'Do the work, then call ask_user again to report result and get next instruction.'
                ];
                if (rtkEnabled) {
                    nextInstructions.push(
                        'RTK is enabled: for shell/file-inspection/build/test work, use regular command-capable tools with explicitly rtk-prefixed simple command parameters, such as `rtk git status`. Do not prefix a compound command; split it into separate simple command tool calls.'
                    );
                    if (rtkDocPrompt) {
                        nextInstructions.push(rtkDocPrompt);
                    }
                }

                // Build result parts - text first, then images
                // Always include next=true and instruction to enforce the recursive loop
                const resultParts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [
                    new vscode.LanguageModelTextPart(JSON.stringify({
                        r: result.response,
                        q: true,  // always loop — call ask_user again after processing this response
                        ...(isQueued && result.taskId && { taskId: result.taskId }),
                        ...(result.attachments.length > 0 && { a: result.attachments.length }),
                        next: nextInstructions.join(' ')
                    }))
                ];

                // Add image attachments as LanguageModelDataPart for vision models
                if (result.attachments && result.attachments.length > 0) {
                    const imagePromises = result.attachments.map(async (uri) => {
                        try {
                            // Handle both URI strings (file:///...) and plain local paths (/tmp/...)
                            const filePath = uri.startsWith('/') ? uri : vscode.Uri.parse(uri).fsPath;

                            // Check if file exists
                            if (!fs.existsSync(filePath)) {
                                console.error('[AskAway] Attachment file does not exist:', filePath);
                                return null;
                            }

                            const mimeType = getImageMimeType(filePath);

                            // Only process image files (skip non-image attachments)
                            if (mimeType !== 'application/octet-stream') {
                                const data = await readFileAsBuffer(filePath);
                                const dataPart = vscode.LanguageModelDataPart.image(data, mimeType);
                                return dataPart;
                            }
                            return null;
                        } catch (error) {
                            console.error('[AskAway] Failed to read image attachment:', error);
                            return null;
                        }
                    });

                    const imageParts = await Promise.all(imagePromises);
                    for (const part of imageParts) {
                        if (part !== null) {
                            resultParts.push(part);
                        }
                    }
                }

                return new vscode.LanguageModelToolResult(resultParts);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown error';
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart("Error: " + message)
                ]);
            }
        }
    });

    } catch (regError) {
        console.warn('[AskAway] ask_user tool already registered by another extension, skipping registration');

        // This is the most common cause of "works in debug, fails when installed":
        // another extension has already claimed ask_user, so AskAway never receives tool calls.
        vscode.window.showWarningMessage(
            'AskAway could not register ask_user because another extension already registered it. Disable conflicting extensions (for example TaskSync) to enable AskAway Telegram/Webex routing.',
            'Open Extensions',
            'Open Settings'
        ).then(selection => {
            if (selection === 'Open Extensions') {
                vscode.commands.executeCommand('workbench.view.extensions');
            } else if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'askaway');
            }
        });
    }

    if (askUserTool) {
        context.subscriptions.push(askUserTool);
    }

    // ── bash_task + research_on delegated worker tools are DISABLED for shipping ──
    // Kept in source for future re-enable, but not registered so they never appear to the
    // agent. Also removed from package.json languageModelTools. Flip to true to restore.
    const WORKER_TOOLS_ENABLED: boolean = false;

    // ── Register bash_task tool ──
    let bashTaskTool: vscode.Disposable | undefined;
    if (WORKER_TOOLS_ENABLED) try {
        bashTaskTool = vscode.lm.registerTool('bash_task', {
            prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ explanation?: string; task: string; cwd?: string }>) {
                const cmd = typeof options?.input?.task === 'string' ? options.input.task : '';
                const preview = cmd.trim().replace(/\s+/g, ' ').slice(0, 40);
                return { invocationMessage: preview ? `⚡ ${preview}` : '⚡ bash_task' };
            },
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ explanation?: string; task: string; cwd?: string }>, token: vscode.CancellationToken) {
                const { task, cwd } = options.input;
                if (!task) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: task is required')
                    ]);
                }

                // Send a task objective, not a shell command. The bash worker decides which
                // commands to run, and its run_terminal tool handles cwd + RTK wrapping.
                const taskText = cwd
                    ? `Working directory: ${cwd}\nTask objective: ${task}`
                    : `Task objective: ${task}`;

                try {
                    const resultPromise = provider.sendTaskToWorker('command', taskText);
                    const cancellation = createCancellationPromise(token);
                    try {
                        const result = await Promise.race([resultPromise, cancellation.promise]);
                        logToolCall('bash_task', result as string);
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(result as string)
                        ]);
                    } finally {
                        cancellation.dispose();
                    }
                } catch (err: unknown) {
                    if (err instanceof vscode.CancellationError) { throw err; }
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: ' + message)
                    ]);
                }
            }
        });
    } catch (e) {
        console.warn('[AskAway] bash_task tool already registered, skipping');
    }
    if (bashTaskTool) { context.subscriptions.push(bashTaskTool); }

    // ── Register research_on tool ──
    let researchOnTool: vscode.Disposable | undefined;
    if (WORKER_TOOLS_ENABLED) try {
        researchOnTool = vscode.lm.registerTool('research_on', {
            prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ explanation?: string; topic: string; modelId?: string }>) {
                const exp = typeof options?.input?.explanation === 'string' ? options.input.explanation : '';
                const preview = exp.trim().replace(/\s+/g, ' ').slice(0, 40);
                return { invocationMessage: preview ? `🤖 ${preview}` : '🤖 research_on' };
            },
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ explanation?: string; topic: string; modelId?: string }>, token: vscode.CancellationToken) {
                const { topic, modelId } = options.input;
                if (!topic) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: topic is required')
                    ]);
                }

                try {
                    // Queue the task — the Agents tab will run it with a full agentic loop.
                    // Memory capture happens generically when the sub-agent worker
                    // task resolves (see resolveWorkerTask), so it covers research_on
                    // and any other sub-agent path uniformly.
                    const resultPromise = provider.sendTaskToWorker('subagent', topic, modelId);
                    const cancellation = createCancellationPromise(token);
                    try {
                        const result = await Promise.race([resultPromise, cancellation.promise]);
                        logToolCall('research_on', result as string);
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(result as string)
                        ]);
                    } finally {
                        cancellation.dispose();
                    }
                } catch (err: unknown) {
                    if (err instanceof vscode.CancellationError) { throw err; }
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: ' + message)
                    ]);
                }
            }
        });
    } catch (e) {
        console.warn('[AskAway] research_on tool already registered, skipping');
    }
    if (researchOnTool) { context.subscriptions.push(researchOnTool); }

    // lsp_bridge is a VS Code Copilot built-in agent tool — registering a duplicate
    // with the same name silently fails. AskAway exposes the same operations as
    // `code_nav` so the tool is always explicitly callable without collision.

    // ── Register code_nav tool (LSP navigation — avoids collision with Copilot built-in lsp_bridge) ──
    let codeNavTool: vscode.Disposable | undefined;
    try {
        codeNavTool = vscode.lm.registerTool('code_nav', {
            prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<LspBridgeInput>) {
                const op = options?.input?.operation ?? 'lsp';
                const fp = options?.input?.filePath ? ` ${path.basename(options.input.filePath)}` : '';
                return { invocationMessage: `🔍 code_nav: ${op}${fp}` };
            },
            async invoke(options: vscode.LanguageModelToolInvocationOptions<LspBridgeInput>, token: vscode.CancellationToken) {
                try {
                    const result = await runLspBridge(options.input, token);
                    const codeNavText = JSON.stringify(result);
                    logToolCall('code_nav', codeNavText, options?.input?.operation);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(codeNavText)
                    ]);
                } catch (err: unknown) {
                    if (err instanceof vscode.CancellationError) { throw err; }
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: ' + message)
                    ]);
                }
            }
        });
    } catch (e) {
        console.warn('[AskAway] code_nav tool already registered, skipping');
    }
    if (codeNavTool) { context.subscriptions.push(codeNavTool); }

    // ── Register rg_search tool (ripgrep-backed fast text search) ──
    let rgSearchTool: vscode.Disposable | undefined;
    try {
        rgSearchTool = vscode.lm.registerTool('rg_search', {
            prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RgSearchInput>) {
                const p = options?.input?.pattern ?? '';
                return { invocationMessage: `🔎 rg: ${p.slice(0, 50)}` };
            },
            async invoke(options: vscode.LanguageModelToolInvocationOptions<RgSearchInput>, _token: vscode.CancellationToken) {
                try {
                    const result = await runRgSearch(options.input);
                    logToolCall('rg_search', result, options?.input?.pattern);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(result)
                    ]);
                } catch (err: unknown) {
                    if (err instanceof vscode.CancellationError) { throw err; }
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: ' + message)
                    ]);
                }
            }
        });
    } catch (e) {
        console.warn('[AskAway] rg_search tool already registered, skipping');
    }
    if (rgSearchTool) { context.subscriptions.push(rgSearchTool); }

    // ── Register read_doc tool (progressive markdown / log / long-text reader) ──
    // Returns a cheap gist first (heading outline or log head/tail + error index)
    // so the agent reads only the section it needs instead of the whole file.
    let readDocTool: vscode.Disposable | undefined;
    try {
        readDocTool = vscode.lm.registerTool('read_doc', {
            prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ReadDocInput>) {
                const mode = options?.input?.mode ?? 'outline';
                const fp = options?.input?.filePath ? ` ${path.basename(options.input.filePath)}` : '';
                return { invocationMessage: `📄 read_doc: ${mode}${fp}` };
            },
            async invoke(options: vscode.LanguageModelToolInvocationOptions<ReadDocInput>, _token: vscode.CancellationToken) {
                try {
                    const result = runReadDoc(options.input);
                    logToolCall('read_doc', result, options?.input?.mode ?? 'outline');
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(result)
                    ]);
                } catch (err: unknown) {
                    if (err instanceof vscode.CancellationError) { throw err; }
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: ' + message)
                    ]);
                }
            }
        });
    } catch (e) {
        console.warn('[AskAway] read_doc tool already registered, skipping');
    }
    if (readDocTool) { context.subscriptions.push(readDocTool); }

    // ── Register gradle tool (async id-based Gradle build control) ──
    // Uses the SAME shared engine (dispatchGradle) as the MCP `gradle` tool.
    // This LM-tool surface makes gradle behave like the other tools inside VS
    // Code (auto-visible in every workspace); the MCP surface keeps it usable
    // from external clients (Kiro/Antigravity/CLI). Same engine, no shortcut.
    let gradleTool: vscode.Disposable | undefined;
    try {
        gradleTool = vscode.lm.registerTool('gradle', {
            prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<GradleInput>) {
                const action = options?.input?.action ?? 'gradle';
                const detail = options?.input?.tasks?.join(' ') ?? options?.input?.buildId ?? '';
                return { invocationMessage: `🐘 gradle: ${action}${detail ? ' ' + detail : ''}` };
            },
            async invoke(options: vscode.LanguageModelToolInvocationOptions<GradleInput>, _token: vscode.CancellationToken) {
                try {
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
                    const result = await dispatchGradle(options.input, root);
                    const gradleText = JSON.stringify(result, null, 2);
                    logToolCall('gradle', gradleText, options?.input?.action);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(gradleText)
                    ]);
                } catch (err: unknown) {
                    if (err instanceof vscode.CancellationError) { throw err; }
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart('Error: ' + message)
                    ]);
                }
            }
        });
    } catch (e) {
        console.warn('[AskAway] gradle tool already registered, skipping');
    }
    if (gradleTool) { context.subscriptions.push(gradleTool); }

    // ── Register turn_budget tool (self-reported per-turn spend + soft limit) ──
    // Lets the agent check how many credits (AIU) it has burned this turn and
    // compare against a user-configured soft budget (askaway.turnBudgetAiu) so it
    // can self-regulate (wrap up) before overspending. Advisory only — never blocks.
    let turnBudgetTool: vscode.Disposable | undefined;
    try {
        turnBudgetTool = vscode.lm.registerTool('turn_budget', {
            prepareInvocation() {
                return { invocationMessage: '💰 checking turn budget' };
            },
            async invoke(_options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, _token: vscode.CancellationToken) {
                const spend = await computeTurnSpend(context);
                const spentAiu = spend.nanoAiu / 1e9;
                const limit = Number(vscode.workspace.getConfiguration('askaway').get('turnBudgetAiu', 0)) || 0;
                const remaining = limit > 0 ? Math.max(0, limit - spentAiu) : null;
                const exceeded = limit > 0 && spentAiu >= limit;
                const pct = limit > 0 ? Math.round(spentAiu / limit * 100) : 0;
                const result = {
                    spentAiu: Number(spentAiu.toFixed(2)),
                    requestCount: spend.requestCount,
                    softLimitAiu: limit > 0 ? limit : null,
                    remainingAiu: remaining !== null ? Number(remaining.toFixed(2)) : null,
                    usedPct: limit > 0 ? pct : null,
                    exceeded,
                    note: limit <= 0
                        ? 'No soft budget set (askaway.turnBudgetAiu = 0 in Settings). Spend shown is informational only.'
                        : exceeded
                            ? `SOFT BUDGET EXCEEDED: ${spentAiu.toFixed(2)}/${limit} AIU this turn. Wrap up now — stop exploring, finalize the task, and avoid further large/expensive requests.`
                            : `Within budget: ${spentAiu.toFixed(2)}/${limit} AIU (${pct}%). ${remaining!.toFixed(2)} AIU remaining this turn.`,
                };
                const text = JSON.stringify(result, null, 2);
                logToolCall('turn_budget', text);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(text)
                ]);
            }
        });
    } catch (e) {
        console.warn('[AskAway] turn_budget tool already registered, skipping');
    }
    if (turnBudgetTool) { context.subscriptions.push(turnBudgetTool); }
}

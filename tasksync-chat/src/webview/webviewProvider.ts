import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CONFIG_NAMESPACE, VIEW_TYPE, VIEW_FOCUS_COMMAND } from '../constants/branding';
import { FILE_EXCLUSION_PATTERNS, FILE_SEARCH_EXCLUSION_PATTERNS, formatExcludePattern } from '../constants/fileExclusions';
import { ContextManager, ContextReferenceType, ContextReference } from '../context';
import { Plan, PlanTask, PlanTaskStatus, createPlan, createTask, findTaskById, getNextPendingTask, countByStatus } from '../plan/planTypes';
import { PlanEditorProvider } from '../plan/planEditorProvider';
import { getUserMemoryDir, summarizeAndStoreMemory, listMemories } from '../memory/memoryStore';

// Exact token counting via the o200k_base BPE (GPT-4o / GPT-5 family, which Copilot uses).
// Lazily loaded on first use to avoid paying the encoding-table init cost at activation.
type TokenEncodeFn = (text: string) => number[];
let _o200kEncode: TokenEncodeFn | undefined;
function countTokens(text: string): number {
    if (!text) { return 0; }
    try {
        if (!_o200kEncode) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            _o200kEncode = (require('gpt-tokenizer/encoding/o200k_base') as { encode: TokenEncodeFn }).encode;
        }
        return _o200kEncode(text).length;
    } catch {
        return Math.ceil(text.length / 4); // fallback if the tokenizer is unavailable
    }
}


// Queued prompt interface
export interface QueuedPrompt {
    id: string;
    prompt: string;
    attachments?: AttachmentInfo[];  // Optional attachments (images, files) included with the prompt
}

// Attachment info
export interface AttachmentInfo {
    id: string;
    name: string;
    uri: string;
    isTemporary?: boolean;
    isFolder?: boolean;
    isTextReference?: boolean;
}

// File search result (also used for context items like #terminal, #problems)
export interface FileSearchResult {
    name: string;
    path: string;
    uri: string;
    icon: string;
    isFolder?: boolean;
    isContext?: boolean; // true for #terminal, #problems context items
}

// User response result
export interface UserResponseResult {
    value: string;
    queue: boolean;
    attachments: AttachmentInfo[];
    cancelled?: boolean;  // Indicates if the request was superseded by a new one
}

// Tool call history entry
export interface ToolCallEntry {
    id: string;
    prompt: string;
    response: string;
    timestamp: number;
    askedAt?: number;
    isFromQueue: boolean;
    status: 'pending' | 'completed' | 'cancelled';
    attachments?: AttachmentInfo[];
}

// Parsed choice from question
export interface ParsedChoice {
    label: string;      // Display text (e.g., "1" or "Test functionality")
    value: string;      // Response value to send (e.g., "1" or full text)
    shortLabel?: string; // Short version for button (e.g., "1" for numbered)
}

// Reusable prompt interface
export interface ReusablePrompt {
    id: string;
    name: string;       // Short name for /slash command (e.g., "fix", "test", "refactor")
    prompt: string;     // Full prompt text
}

interface ScopeMetrics {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    nanoAiu: number;
    /** Count of requests whose cached portion was < 50% of input (cache miss). Optional/back-compat. */
    cacheMisses?: number;
}

interface ModelBreakdown extends ScopeMetrics {
    model: string;
}

interface ObservabilityMetrics {
    // Flat fields mirror the workspace cumulative scope (kept for backward compatibility).
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    nanoAiu: number;
    // Scoped breakdowns for the metrics table.
    lastRequest: ScopeMetrics;   // current turn (reset on each user submit)
    workspace: ScopeMetrics;     // cumulative for this workspace
    overall: ScopeMetrics;       // current calendar month across all workspaces
    perModel: ModelBreakdown[];  // current calendar month across all workspaces (debug)
    /** Current-month context-compaction (summarizeConversationHistory) request count + credits. */
    overallCompaction: { count: number; nanoAiu: number };
    turnRequests: TurnRequest[]; // individual requests of the current turn (newest last)
    turnEvents: TurnEvent[];     // chronological current-turn LLM/tool timeline
    turnSubagents: TurnSubagentSummary[]; // sub-agent instance headers for grouping the timeline
    rtkCommandCount: number;
    rtkSavedTokens: number;
    rtkSavingsPct: number;
    gradle: { runs: number; optimizedRuns: number; tasksAvoided: number; configCacheReuses: number; savedTokens: number };
    toolCalls: ToolCallMetrics;
    /** Epoch ms of the newest llm_request seen — powers the live prompt-cache age clock. */
    lastRequestTs: number;
    source: string;
    updatedAt: number;
}

/** Per-tool aggregate exposed to the UI. Durations in ms; tokens ≈ chars/4. */
interface ToolStat {
    tool: string;
    calls: number;
    outputTokens: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    errors: number;
    /** True when this tool's max/avg duration risks blowing the ~5 min prompt-cache TTL. */
    cacheRisk: boolean;
    /** Top input categories (for grouping) → call count. */
    groups: Array<{ group: string; calls: number }>;
}

interface ToolScope {
    totalCalls: number;
    totalOutputTokens: number;
    byTool: ToolStat[];
}

/** Month (durable) + current-turn tool telemetry. */
interface ToolCallMetrics extends ToolScope {
    /** Tool calls since the last user submit (current request). */
    turn: ToolScope;
}

/** Compact per-request summary used to attach before/after context to cache-miss records. */
interface ReqSummary {
    ts: number;
    sid: string;
    li: number;              // debug-log line index (locator into the master table)
    responseId: string | null;
    model: string;
    role: string;            // debugName (panel/editAgent, summarizeConversationHistory, …)
    inputTokens: number;
    cachedTokens: number;
    cacheHitPct: number;
    nanoAiu: number;
    miss: boolean;
}

/** One row in the current-turn requests table (individual model call). */
interface TurnRequest {
    id: string;              // stable 5-char locator (hash of sid:li) — user can ask to investigate it
    ts: number;
    model: string;
    nanoAiu: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheHitPct: number;
    /** debugName-derived class: 'compaction' (summarizeConversationHistory), 'retry', or 'normal'. */
    kindTag?: 'compaction' | 'retry' | 'normal';
    /** Sub-agent label when this request came from a runSubagent-*.jsonl child session (else undefined). */
    subagent?: string;
    /** Stable per-instance group key (short hash of the child session id) for parallel sub-agents. */
    subagentId?: string;
}

/** Aggregate header for one sub-agent instance's grouped timeline entry (current turn). */
interface TurnSubagentSummary {
    subagentId: string;      // short group key (matches events' subagentId)
    label: string;           // agent name (Explore, AskAway Build, …)
    done: boolean;           // true once the parent runSubagent tool_call has completed
    durMs: number;           // authoritative total wall time from the parent tool_call (0 while running)
    outputTokens: number;    // authoritative output tokens from the parent tool_call result (0 while running)
    status: string;          // parent tool_call status ('ok' | error)
    startedTs: number;       // first observed activity ts (for ordering)
}

type TurnEvent = TurnRequestEvent | TurnToolEvent;

/** Exact composition of a request's input. system/tools are tokenized precisely (o200k);
 *  conversation is derived so the parts reconcile to the model-reported total exactly. */
interface TurnInputSplit {
    systemTokens: number;        // exact tokens of the system prompt content
    toolsTokens: number;         // exact tokens of the tool-definitions content
    conversationTokens: number;  // total - system - tools (cached prior history + new delta)
    newMessageTokens: number;    // exact tokens of this request's fresh messages + user text
    cachedPriorTokens: number;   // conversation - newMessage (cached prior context, not in sidecars)
    userTokens: number;          // exact tokens of the latest user request text
    totalInputTokens: number;    // model-reported inputTokens (authoritative)
    skillsCount: number;         // # of <skill> entries in the system prompt
    toolsCount: number;          // # of tool definitions
    messageCount: number;        // # of messages in inputMessages
    cachedTokens: number;        // model-reported cached tokens
    composition?: SystemPromptComposition; // which files/blocks make up the system prompt
    contributors?: RequestContributors;    // full-request breakdown (system+tools+conversation)
}

/** One contributor to the FULL request input (a category or a specific attached file). */
interface RequestContributor {
    label: string;
    kind: 'system' | 'tools' | 'memory' | 'attachment' | 'context' | 'toolResult' | 'toolCall' | 'reasoning' | 'dialogue';
    tokens: number;
    path?: string;   // attached-file absolute path (link target), when kind === 'attachment'
    count?: number;  // # of underlying items (e.g. memory files, attachments)
}

/** Full literal breakdown of everything in a request: system prompt + tools + the entire
 *  conversation (memories, attached files, context framing, tool results, dialogue). Parsed
 *  from the request's own `inputMessages` sidecar so it reflects THAT request exactly. */
interface RequestContributors {
    totalInputTokens: number;      // model-reported input (authoritative)
    cachedTokens: number;          // model-reported cached portion
    accountedTokens: number;       // Σ items.tokens (should ≈ totalInputTokens)
    items: RequestContributor[];   // sorted desc by tokens
    files: string[];               // distinct attached-file paths present in this request
    memoryFiles: string[];         // distinct `## <file>` headers inside <userMemory> blocks
}

/** One attributable piece of the assembled system prompt (a file attachment or a catalog block). */
interface SystemPromptSegment {
    label: string;                // display name (file basename or catalog name)
    kind: 'attachment' | 'instruction' | 'skills' | 'agents' | 'mode' | 'framing';
    path?: string;                // absolute fs path for file segments (link target)
    workspaceFolder?: string;     // owning workspace folder name, if Copilot reported one
    tokens: number;               // exact tokens contributed by this segment
    children?: SystemPromptChild[]; // per-item breakdown (individual skills / agents)
}

/** A single entry inside a catalog segment (one skill or one agent). */
interface SystemPromptChild {
    label: string;                // skill/agent name
    path?: string;                // SKILL.md path for skills (link target)
    tokens: number;               // exact tokens for this entry
}

/** Reverse-engineered breakdown of what the system prompt is composed of, in order. */
interface SystemPromptComposition {
    totalTokens: number;          // = TurnInputSplit.systemTokens (whole system prompt)
    baseTokens: number;           // remainder attributed to Copilot's own base + framing text
    segments: SystemPromptSegment[]; // attachments + catalogs, in the order they appear
}

interface TurnRequestEvent extends TurnRequest {
    kind: 'request';
    /** Per-request input breakdown powering the expandable detail row. */
    split?: TurnInputSplit;
    /** The turn's initiating request (user submission). Pinned to the top of the timeline. */
    firstOfTurn?: boolean;
}

interface TurnToolEvent {
    kind: 'tool';
    id: string;
    ts: number;
    tool: string;
    status: string;
    durMs: number;
    inputTokens: number;
    outputTokens: number;
    group: string;
    inputPreview: string;
    outputPreview: string;
    /** Sub-agent label when this tool call ran inside a runSubagent-*.jsonl child session. */
    subagent?: string;
    /** Stable per-instance group key (short hash of the child session id) for parallel sub-agents. */
    subagentId?: string;
}

/** Per-entry metadata stored in the seen map (version 2+). */
interface SeenMeta {
    ts: number;    // epoch ms — used for month bucketing
    model: string;
    nano: number;  // nanoAiu
    in: number;    // inputTokens
    out: number;   // outputTokens
    cached?: number; // cachedTokens (added v3; absent on older entries)
}

interface ObservabilityLedger {
    version: 1;
    workspaceKey: string;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    nanoAiu: number;
    /** Cumulative count of cache-miss requests (cached < 50% of input). Optional/back-compat. */
    cacheMisses?: number;
    /** Values are SeenMeta for entries written by v2+ code; `true` for legacy entries. */
    seen: Record<string, SeenMeta | true>;
    updatedAt: number;
}

interface MonthBucket extends ScopeMetrics {
    perModel: Record<string, ScopeMetrics>;
    /** Requests whose debugName is a summarizeConversationHistory* (context compaction). */
    compactionCount?: number;
    compactionNanoAiu?: number;
}

/** Per-file, per-month aggregate for the stateless month recompute (memoized in _monthFileCache). */
interface FileMonthAgg {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    nanoAiu: number;
    cacheMisses: number;
    compactionCount: number;
    compactionNanoAiu: number;
    perModel: Map<string, ScopeMetrics>;
}

interface MonthShard {
    version: 1;
    workspaceKey: string;
    months: Record<string, MonthBucket>;
    updatedAt: number;
    /** Bytes consumed from the append-only usage-requests jsonl (persisted cursor). */
    rawOffset?: number;
    /** (Global shard only) responseId → monthKey, persisted for cross-restart dedup. Pruned to recent months. */
    seenIds?: Record<string, string>;
    /** (Global shard only) fold-logic version; a bump forces a one-time clean rebuild. */
    foldVersion?: number;
}

/** Durable per-tool aggregate for one tool within one month. Durations in ms. */
interface ToolAggregate {
    calls: number;
    errors: number;
    totalDurMs: number;
    minDurMs: number;
    maxDurMs: number;
    outputChars: number;
    inputChars: number;
    byGroup: Record<string, number>;
}

interface ToolMonthBucket {
    tools: Record<string, ToolAggregate>;
}

/** Durable, additive per-workspace tool telemetry. Never rewritten downward. */
interface ToolShard {
    version: 1;
    workspaceKey: string;
    /** Bytes consumed from the append-only usage-tools jsonl (persisted cursor). */
    rawOffset: number;
    months: Record<string, ToolMonthBucket>;
    updatedAt: number;
}

const execFileAsync = promisify(execFile);
/** Bump to force a one-time clean rebuild of the global month shard when fold logic changes. */
const GLOBAL_FOLD_VERSION = 4;
// Message types
type ToWebviewMessage =
    | { type: 'updateQueue'; queue: QueuedPrompt[]; enabled: boolean }
    | { type: 'updateWorkerQueue'; tasks: Array<{ id: string; role: 'command' | 'subagent'; task: string; status: 'pending' | 'running' | 'done'; createdAt: number }> }
    | { type: 'availableModels'; models: Array<{ id: string; name: string; vendor: string; family: string; maxInputTokens: number }> }
    | { type: 'availableTools'; tools: Array<{ name: string; description: string; tags: string[] }> }
    | { type: 'toolCallPending'; id: string; prompt: string; isApprovalQuestion: boolean; choices?: ParsedChoice[] }
    | { type: 'toolCallCompleted'; entry: ToolCallEntry }
    | { type: 'updateCurrentSession'; history: ToolCallEntry[] }
    | { type: 'updatePersistedHistory'; history: ToolCallEntry[] }
    | { type: 'fileSearchResults'; files: FileSearchResult[] }
    | { type: 'updateAttachments'; attachments: AttachmentInfo[] }
    | { type: 'imageSaved'; attachment: AttachmentInfo }
    | { type: 'openSettingsModal' }
    | {
        type: 'updateSettings';
        soundEnabled: boolean;
        interactiveApprovalEnabled: boolean;
        webexEnabled: boolean;
        telegramEnabled: boolean;
        autopilotEnabled: boolean;
        autopilotText: string;
        reusablePrompts: ReusablePrompt[];
        autopilotPrompts?: string[];
        responseTimeout?: number;
        sessionWarningHours?: number;
        maxConsecutiveAutoResponses?: number;
        turnBudgetAiu?: number;
        humanLikeDelayEnabled?: boolean;
        humanLikeDelayMin?: number;
        humanLikeDelayMax?: number;
        sendWithCtrlEnter?: boolean;
        webexStatus?: unknown;
        telegramStatus?: unknown;
        debugLoggingEnabled?: boolean;
        rtkCompressionEnabled?: boolean;
        rtkInstalled?: boolean;
        autoCompactionDisabled?: boolean;
        extendedCacheTtl?: boolean;
        extendedCacheTtlMessages?: boolean;
        cacheKeepWarmEnabled?: boolean;
        cacheKeepWarmProbes?: number;
    }
    | { type: 'updateObservabilityMetrics'; metrics: ObservabilityMetrics }
    | { type: 'updateMemoriesList'; memories: Array<{ file: string; title: string; size: number; modified: number }> }
    | { type: 'slashCommandResults'; prompts: ReusablePrompt[] }
    | { type: 'playNotificationSound' }
    | { type: 'contextSearchResults'; suggestions: Array<{ type: string; label: string; description: string; detail: string }> }
    | { type: 'contextReferenceAdded'; reference: { id: string; type: string; label: string; content: string } }
    | { type: 'voiceStart'; taskId: string; question: string }
    | { type: 'voiceSpeakingDone'; taskId: string }
    | { type: 'voiceStop' }
    | { type: 'updatePlan'; plan: Plan | null }
    | { type: 'planTaskStatusChanged'; taskId: string; status: PlanTaskStatus; note?: string }
    | { type: 'planAutoAdvancing'; taskId: string; nextTaskId: string; nextTaskTitle: string }
    | { type: 'planExecutionStarted' }
    | { type: 'planExecutionPaused' }
    | { type: 'triggerSendFromShortcut' }
    | { type: 'clear' };

type FromWebviewMessage =
    | { type: 'submit'; value: string; attachments: AttachmentInfo[] }
    | { type: 'addQueuePrompt'; prompt: string; id: string; attachments?: AttachmentInfo[] }
    | { type: 'removeQueuePrompt'; promptId: string }
    | { type: 'editQueuePrompt'; promptId: string; newPrompt: string }
    | { type: 'reorderQueue'; fromIndex: number; toIndex: number }
    | { type: 'toggleQueue'; enabled: boolean }
    | { type: 'clearQueue' }
    | { type: 'addAttachment' }
    | { type: 'removeAttachment'; attachmentId: string }
    | { type: 'removeHistoryItem'; callId: string }
    | { type: 'workerResolveManual'; taskId: string; result: string }
    | {
        type: 'workerRunAutopilot';
        taskId: string;
        modelId?: string;
        agentName?: string;
        thinkingEffort?: 'low' | 'medium' | 'high';
    }
    | { type: 'configureWorkerTools' }
    | { type: 'changeWorkerModel'; role: 'command' | 'subagent' }
    | { type: 'requestModels' }
    | { type: 'clearPersistedHistory' }
    | { type: 'openHistoryModal' }
    | { type: 'searchFiles'; query: string }
    | { type: 'saveImage'; data: string; mimeType: string }
    | { type: 'addFileReference'; file: FileSearchResult }
    | { type: 'webviewReady'; uiVersion?: string }
    | { type: 'openSettingsModal' }
    | { type: 'updateSoundSetting'; enabled: boolean }
    | { type: 'updateInteractiveApprovalSetting'; enabled: boolean }
    | { type: 'updateWebexSetting'; enabled: boolean }
    | { type: 'updateTelegramSetting'; enabled: boolean }
    | { type: 'updateAutopilotSetting'; enabled: boolean }
    | { type: 'updateAutopilotText'; text: string }
    | { type: 'addReusablePrompt'; name: string; prompt: string }
    | { type: 'editReusablePrompt'; id: string; name: string; prompt: string }
    | { type: 'removeReusablePrompt'; id: string }
    | { type: 'searchSlashCommands'; query: string }
    | { type: 'openExternal'; url: string }
    | { type: 'openFile'; path: string }
    | { type: 'searchContext'; query: string }
    | { type: 'selectContextReference'; contextType: string; options?: Record<string, unknown> }
    | { type: 'voiceResponse'; taskId: string; transcription: string }
    | { type: 'voiceError'; taskId: string; error: string }
    | { type: 'micButtonClicked' }
    | { type: 'voiceInterrupt' }
    | { type: 'planAddTask'; title: string; description: string; requiresReview: boolean; afterTaskId?: string }
    | { type: 'planEditTask'; taskId: string; title: string; description: string; requiresReview: boolean }
    | { type: 'planDeleteTask'; taskId: string }
    | { type: 'planReorderTask'; taskId: string; newOrder: number }
    | { type: 'planSetMode'; enabled: boolean }
    | { type: 'planSplitTask'; taskId: string }
    | { type: 'planAcceptSplit'; taskId: string; subtasks: Array<{ title: string; description: string }> }
    | { type: 'planRejectSplit'; taskId: string }
    | { type: 'planReviewApprove'; taskId: string }
    | { type: 'planReviewReject'; taskId: string; feedback: string }
    | { type: 'planToggleAutoAdvance'; enabled: boolean }
    | { type: 'planStartExecution' }
    | { type: 'planPauseExecution' }
    | { type: 'openPlanBoard' }
    | { type: 'updateSendWithCtrlEnterSetting'; enabled: boolean }
    | { type: 'updateDebugLoggingSetting'; enabled: boolean }
    | { type: 'updateRtkCompressionSetting'; enabled: boolean }
    | { type: 'updateAutoCompactionDisabled'; disabled: boolean }
    | { type: 'updateExtendedCacheTtl'; enabled: boolean }
    | { type: 'updateExtendedCacheTtlMessages'; enabled: boolean }
    | { type: 'updateCacheKeepWarm'; enabled: boolean }
    | { type: 'updateCacheKeepWarmProbes'; value: number }
    | { type: 'pingCache' }
    | { type: 'updateCavemanSetting'; enabled: boolean }
    | { type: 'updateResponseTimeout'; value: number }
    | { type: 'updateSessionWarningHours'; value: number }
    | { type: 'updateMaxConsecutiveAutoResponses'; value: number }
    | { type: 'updateTurnBudgetAiu'; value: number }
    | { type: 'updateHumanDelaySetting'; enabled: boolean }
    | { type: 'updateHumanDelayMin'; value: number }
    | { type: 'updateHumanDelayMax'; value: number }
    | { type: 'addAutopilotPrompt'; prompt: string }
    | { type: 'editAutopilotPrompt'; index: number; prompt: string }
    | { type: 'removeAutopilotPrompt'; index: number }
    | { type: 'reorderAutopilotPrompts'; fromIndex: number; toIndex: number }
    | { type: 'copyToClipboard'; text: string };


export class TaskSyncWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = VIEW_TYPE;

    private _view?: vscode.WebviewView;
    private _pendingRequests: Map<string, (result: UserResponseResult) => void> = new Map();

    // ── Concurrent ask_user queue (prevents one conversation from cancelling another) ──
    /** Callbacks waiting to become the active pending request when the current one resolves */
    private _waitingRequests: Array<() => void> = [];
    /** Number of ask_user calls currently waiting behind the active one (for UI indicator) */
    private _concurrentWaitingCount: number = 0;

    // Prompt queue state
    private _promptQueue: QueuedPrompt[] = [];
    private _queueEnabled: boolean = true; // Default to queue mode

    // Attachments state
    private _attachments: AttachmentInfo[] = [];

    // Current session tool calls (memory only - not persisted during session)
    private _currentSessionCalls: ToolCallEntry[] = [];
    // Persisted history from past sessions (loaded from disk)
    private _persistedHistory: ToolCallEntry[] = [];
    private _currentToolCallId: string | null = null;

    // Webview ready state - prevents race condition on first message
    private _webviewReady: boolean = false;
    private _pendingToolCallMessage: { id: string; prompt: string } | null = null;

    private _observabilityPollInterval: ReturnType<typeof setInterval> | null = null;
    private readonly _OBSERVABILITY_POLL_MS = 2000;
    /** Tracks byte + line offsets already consumed per log file so we only read new lines on each poll. */
    private readonly _logFileReadOffsets = new Map<string, { byteOffset: number; lineCount: number }>();
    /** Guards one-time load of persisted read offsets (survives extension restart → no re-scan / duplicate appends). */
    private _logOffsetsLoaded = false;
    /** Persisted per-file read cursors for the ALL-workspace global credit ingest (separate from the workspace scan). */
    private readonly _globalLogOffsets = new Map<string, { byteOffset: number; lineCount: number }>();
    private _globalOffsetsLoaded = false;

    private readonly _WEBVIEW_UI_VERSION = 'workers-tools-hierarchy-v7-memories-list';

    private _observabilityLastReadAt: number = 0;
    /** Re-entrancy guard: prevents overlapping poll scans from double-counting the turn accumulator. */
    private _observabilityScanning = false;
    private _observabilityCache: ObservabilityMetrics = {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        nanoAiu: 0,
        lastRequest: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        workspace: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        overall: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        perModel: [],
        overallCompaction: { count: 0, nanoAiu: 0 },
        turnRequests: [],
        turnEvents: [],
        turnSubagents: [],
        rtkCommandCount: 0,
        rtkSavedTokens: 0,
        rtkSavingsPct: 0,
        gradle: { runs: 0, optimizedRuns: 0, tasksAvoided: 0, configCacheReuses: 0, savedTokens: 0 },
        toolCalls: { totalCalls: 0, totalOutputTokens: 0, byTool: [], turn: { totalCalls: 0, totalOutputTokens: 0, byTool: [] } },
        lastRequestTs: 0,
        source: 'unavailable',
        updatedAt: 0
    };

    // Accumulator for credits consumed since the last user submit.
    // Grows as new log lines are processed; finalized and reset on each submit.
    private _lastRequestMetrics: ScopeMetrics = { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 };
    /** Per-tool aggregates for the CURRENT turn (reset on each user submit). tool → aggregate. */
    private _turnToolAgg = new Map<string, ToolAggregate>();
    /** Individual requests of the current turn (reset each submit), newest last. Capped to bound memory. */
    private _turnRequests: TurnRequest[] = [];
    /** Chronological current-turn request/tool events for optimization debugging. */
    private _turnEvents: TurnEvent[] = [];
    /** Sub-agent instance headers (current turn), keyed by subagentId, for timeline grouping. */
    private _turnSubagents = new Map<string, TurnSubagentSummary>();
    /** parentSpanId (from child_session_ref) → subagentId, to link the parent runSubagent tool_call. */
    private _turnSpanToSubagent = new Map<string, string>();
    /** subagentId → label learned from child_session_ref (used to label the finalize summary). */
    private _turnSubagentLabelById = new Map<string, string>();
    /** Epoch ms of the newest llm_request ever observed (any session) — for the cache-age clock. */
    private _newestRequestTs = 0;
    /** True once the turn's first (initiating) request has been seen — used to pin it on top. */
    private _turnFirstReqSeen = false;
    /** Cache of sidecar-file stats (system prompt / tools files) keyed by absolute path. */
    private _splitFileCache = new Map<string, { tokens: number; count: number }>();
    /** Cache of parsed system-prompt composition keyed by `<sidecarPath>:<systemTokens>`. */
    private _promptCompositionCache = new Map<string, SystemPromptComposition>();
    private _contributorCache = new Map<string, RequestContributors>();
    /** Rolling tail of recent request summaries (across polls) for cache-miss "before" context. */
    private _recentReqs: ReqSummary[] = [];
    /** Compact projection of a request summary for embedding as a neighbor in a cache-miss record. */
    private _neighbor = (r: ReqSummary) => ({
        ts: r.ts, role: r.role, model: r.model,
        cacheHitPct: r.cacheHitPct, inputTokens: r.inputTokens,
        cachedTokens: r.cachedTokens, nanoAiu: r.nanoAiu,
        sid: r.sid, li: r.li, responseId: r.responseId,
    });
    /** Wall-clock of the last user submit; "This turn" aggregates llm_requests with ts >= this. */
    private _lastSubmitTs = Date.now();
    /** Highest user_message.ts seen in log files — prevents duplicate turn resets on re-scan. */
    private _logTurnStartTs: number = 0;
    // Throttle the cross-workspace overall(month) computation (reads all month shards).
    private _overallLastComputedAt: number = 0;
    private _overallCache: { totals: ScopeMetrics; perModel: ModelBreakdown[]; compaction: { count: number; nanoAiu: number } } = {
        totals: { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 },
        perModel: [],
        compaction: { count: 0, nanoAiu: 0 }
    };
    private readonly _OVERALL_RECOMPUTE_MS = 5000;
    /**
     * Per-file memoized month sums for the STATELESS month recompute. Keyed by absolute log path.
     * Each entry caches the file's size+mtime and its per-month aggregates; a file is only re-read
     * when it grows/changes. This replaces the fragile byte-cursor + additive shard (which drifted
     * on log rotation and latched bad values). The total is recomputed from current on-disk data
     * every cycle, so it always self-heals to reality — no cursors, no fold versions, no latch.
     */
    private _monthFileCache = new Map<string, { size: number; mtime: number; months: Map<string, FileMonthAgg> }>();
    /** True once the persisted month-file cache has been loaded from disk. */
    private _monthCacheLoaded = false;

    // Debounce timer for queue persistence
    private _queueSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _QUEUE_SAVE_DEBOUNCE_MS = 300;

    // Voice mode state
    private _pendingVoiceRequests: Map<string, { resolve: (text: string) => void; reject: (err: Error) => void }> = new Map();

    // Debounce timer for history persistence (async background saves)
    private _historySaveTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _HISTORY_SAVE_DEBOUNCE_MS = 2000; // 2 seconds debounce
    private _historyDirty: boolean = false; // Track if history needs saving

    // ── Worker task queues (Commands + Sub-Agents) ──
    // Tasks are routed to the widget tabs where user can resolve manually or via model.
    private _workerTasks: Map<string, {
        id: string;
        role: 'command' | 'subagent';
        task: string;
        modelId?: string;
        status: 'pending' | 'running' | 'done';
        resolve: (result: string) => void;
        createdAt: number;
    }> = new Map();

    // Legacy worker queue support (keep for backward compat)
    private _workerQueues: Map<string, {
        pendingTask: { task: string; resolve: (result: string) => void } | null;
        workerReady: ((task: string) => void) | null;
    }> = new Map();

    // Performance limits
    private readonly _MAX_HISTORY_ENTRIES = 100;
    private readonly _MAX_FILE_SEARCH_RESULTS = 500;
    private readonly _MAX_QUEUE_PROMPT_LENGTH = 100000; // 100KB for queue prompts
    private readonly _MAX_FOLDER_SEARCH_RESULTS = 1000;
    private readonly _VIEW_OPEN_TIMEOUT_MS = 5000;
    private readonly _VIEW_OPEN_POLL_INTERVAL_MS = 100;
    private readonly _SHORT_QUESTION_THRESHOLD = 100; // chars for approval heuristic

    // File search cache with TTL
    private _fileSearchCache: Map<string, { results: FileSearchResult[], timestamp: number }> = new Map();
    private readonly _FILE_CACHE_TTL_MS = 5000;

    // Map for O(1) lookup of tool calls by ID (synced with _currentSessionCalls array)
    private _currentSessionCallsMap: Map<string, ToolCallEntry> = new Map();

    // Reusable prompts (loaded from VS Code settings)
    private _reusablePrompts: ReusablePrompt[] = [];

    // Notification sound enabled (loaded from VS Code settings)
    private _soundEnabled: boolean = true;

    // Interactive approval buttons enabled (loaded from VS Code settings)
    private _interactiveApprovalEnabled: boolean = true;

    // Webex/Telegram service references (set by extension.ts)
    private _webexService: any = null;
    private _telegramService: any = null;

    private readonly _AUTOPILOT_DEFAULT_TEXT = 'You are temporarily in autonomous mode and must now make your own decision. If another question arises, be sure to ask it, as autonomous mode is temporary.';

    // Autopilot enabled (loaded from VS Code settings)
    private _autopilotEnabled: boolean = false;

    // Autopilot text (loaded from VS Code settings)
    private _autopilotText: string = '';

    // Autopilot prompts array (cycles through in order)
    private _autopilotPrompts: string[] = [];

    // Current index in autopilot prompts cycle (resets on new session)
    private _autopilotIndex: number = 0;

    // Human-like delay settings: adds random jitter before auto-responses
    private _humanLikeDelayEnabled: boolean = true;
    private _humanLikeDelayMin: number = 2;  // seconds
    private _humanLikeDelayMax: number = 6;  // seconds

    // Session warning threshold (hours). 0 disables the warning.
    private _sessionWarningHours: number = 2;

    // Allowed timeout values (minutes)
    private readonly _RESPONSE_TIMEOUT_ALLOWED_MINUTES = new Set<number>([
        0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 180, 210, 240
    ]);
    private readonly _RESPONSE_TIMEOUT_DEFAULT_MINUTES = 60;

    // Send behavior: false => Enter, true => Ctrl/Cmd+Enter
    private _sendWithCtrlEnter: boolean = false;

    // Session termination text
    private readonly _SESSION_TERMINATION_TEXT = 'Session terminated. Do not use askUser tool again.';

    // Response timeout tracking
    private _responseTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private _consecutiveAutoResponses: number = 0;

    // Session timer
    private _sessionStartTime: number | null = null;
    private _sessionFrozenElapsed: number | null = null;
    private _sessionTimerInterval: ReturnType<typeof setInterval> | null = null;
    private _sessionTerminated: boolean = false;
    private _sessionWarningShown: boolean = false;

    // Flag to prevent config reload during our own updates (avoids race condition)
    private _isUpdatingConfig: boolean = false;

    // Disposables to clean up
    private _disposables: vscode.Disposable[] = [];

    // Context manager for #terminal, #problems references
    private readonly _contextManager: ContextManager;

    // Remote broadcast callback (set by RemoteUiServer)
    private _remoteBroadcastCallback: ((message: ToWebviewMessage) => void) | null = null;

    // Current pending request info for remote server
    private _currentPendingRequest: { id: string; prompt: string; isApprovalQuestion: boolean; choices?: ParsedChoice[] } | null = null;

    // ── Plan Mode state ──
    private _planEnabled: boolean = false;
    private _currentPlan: Plan | null = null;
    private _planExecuting: boolean = false;
    private _planPendingReview: Map<string, { resolve: (response: string) => void }> = new Map();
    private _planEditor: PlanEditorProvider | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        contextManager: ContextManager
    ) {
        this._contextManager = contextManager;
        // Load both queue and history async to not block activation
        this._loadQueueFromDiskAsync().catch(err => {
            console.error('Failed to load queue:', err);
        });
        this._loadPersistedHistoryFromDiskAsync().catch(err => {
            console.error('Failed to load history:', err);
        });
        // Load settings (sync - fast operation)
        this._loadSettings();

        // Load plan from disk if available
        this._loadPlanFromDisk();

        // Listen for settings changes
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                // Skip reload if we're the ones updating config (prevents race condition)
                if (this._isUpdatingConfig) {
                    return;
                }
                if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.notificationSound`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.interactiveApproval`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.autopilot`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.autopilotText`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.autopilotPrompts`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.autoAnswer`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.autoAnswerText`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.reusablePrompts`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.humanLikeDelay`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.humanLikeDelayMin`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.humanLikeDelayMax`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.sendWithCtrlEnter`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.responseTimeout`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.sessionWarningHours`) ||
                    e.affectsConfiguration(`${CONFIG_NAMESPACE}.maxConsecutiveAutoResponses`)) {
                    this._loadSettings();
                    this._updateSettingsUI();
                }
            })
        );
    }

    // ================== Remote Server Integration ==================

    /**
     * Set broadcast callback for remote UI server
     * This enables the extension to push updates to connected web/mobile clients
     */
    public setWebexService(service: any): void {
        this._webexService = service;
        // Wire up response callback so Webex replies resolve pending requests
        if (service && typeof service.setResponseCallback === 'function') {
            service.setResponseCallback((taskId: string, response: string, user: string, attachments?: AttachmentInfo[]) => {
                this._handleMessagingResponse(taskId, response, user, attachments);
            });
        }
    }

    public getWebexService(): any {
        return this._webexService;
    }

    public setTelegramService(service: any): void {
        this._telegramService = service;
        // Wire up response callback so Telegram replies resolve pending requests
        if (service && typeof service.setResponseCallback === 'function') {
            service.setResponseCallback((taskId: string, response: string, user: string, attachments?: AttachmentInfo[]) => {
                this._handleMessagingResponse(taskId, response, user, attachments);
            });
        }
        // Wire up history callback so Telegram /history command can fetch conversation data
        if (service && typeof service.setHistoryCallback === 'function') {
            service.setHistoryCallback(() => {
                return this._currentSessionCalls.map(entry => ({
                    prompt: entry.prompt,
                    response: entry.response,
                    timestamp: entry.timestamp,
                    status: entry.status
                }));
            });
        }
    }

    public getTelegramService(): any {
        return this._telegramService;
    }

    /**
     * Set the PlanEditorProvider for editor-tab plan board.
     * The editor handles the board UI; this provider delegates orchestrator calls.
     */
    public setPlanEditor(editor: PlanEditorProvider): void {
        this._planEditor = editor;
        // Wire the enqueue callback so the plan editor can push tasks into the prompt queue
        editor.setEnqueueCallback((prompt: string) => {
            // If there's a pending ask_user request, resolve it immediately with the task
            if (this._pendingRequests.size > 0 && this._currentToolCallId) {
                const toolCallId = this._currentToolCallId;
                const resolver = this._pendingRequests.get(toolCallId);
                if (resolver) {
                    this._pendingRequests.delete(toolCallId);
                    this._currentToolCallId = null;
                    this._signalNextWaiter();

                    // Update the session entry
                    const entry = this._currentSessionCallsMap.get(toolCallId);
                    if (entry) {
                        entry.response = prompt;
                        entry.isFromQueue = true;
                        entry.status = 'completed';
                    }

                    // Broadcast toolCallCompleted to trigger "Processing your response" state
                    if (entry) {
                        this._broadcast({ type: 'toolCallCompleted', entry });
                    }

                    resolver({ value: prompt, queue: true, attachments: [] });
                    this._telegramService?.resolveTask?.(toolCallId);
                    this._webexService?.resolveTask?.(toolCallId);
                    return;
                }
            }
            // No pending request — push to queue for next ask_user call
            this._promptQueue.push({ id: Date.now().toString(), prompt });
            this._queueEnabled = true;
            this._updateQueueUI();
        });
    }

    /**
     * Auto-merge user feedback into a plan task's description.
     * Called when Copilot asks the user mid-task and the user responds.
     * Uses AI to merge the Q&A into the task instructions so context accumulates.
     * Fire-and-forget — doesn't block the main tool flow.
     */
    public mergeUserFeedbackIntoTask(taskId: string, copilotQuestion: string, userResponse: string): void {
        if (this._planEditor) {
            this._planEditor.mergeUserFeedback(taskId, copilotQuestion, userResponse);
        }
    }

    // ── Worker task broker (Commands + Sub-Agents tabs) ──

    /**
     * Queue a task for the Commands or Sub-Agents tab.
     * Blocks until the user (or selected model) resolves it.
     */
    public sendTaskToWorker(role: 'command' | 'subagent', task: string, modelId?: string): Promise<string> {
        return new Promise<string>((resolve) => {
            const id = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            this._workerTasks.set(id, { id, role, task, modelId, status: 'pending', resolve, createdAt: Date.now() });
            this._broadcastWorkerQueue();
        });
    }

    /**
     * Resolve a worker task (called from webview: manual submit or autopilot result).
     */
    public resolveWorkerTask(id: string, result: string): void {
        const entry = this._workerTasks.get(id);
        if (!entry) { return; }
        entry.status = 'done';
        entry.resolve(result);
        // Generic memory capture: distill ANY completed sub-agent task into a
        // durable memory note (covers research_on and any other tool that
        // delegates to a sub-agent worker). Best-effort, fire-and-forget so it
        // never blocks or fails the task resolution. Uses the local model only.
        if (entry.role === 'subagent') {
            void summarizeAndStoreMemory(getUserMemoryDir(this._context), entry.task, result)
                .catch(err => console.warn('[AskAway] sub-agent memory capture failed:', err));
        }
        // Remove after brief delay so user sees "done"
        setTimeout(() => {
            this._workerTasks.delete(id);
            this._broadcastWorkerQueue();
        }, 1500);
        this._broadcastWorkerQueue();
    }

    /** Broadcast current worker tasks to the webview */
    private _broadcastWorkerQueue(): void {
        const tasks = Array.from(this._workerTasks.values()).map(t => ({
            id: t.id, role: t.role, task: t.task, status: t.status, createdAt: t.createdAt
        }));
        this._broadcast({ type: 'updateWorkerQueue', tasks });
    }

    /**
     * Minimal built-in tool set for worker tabs.
     * Keeps the UI and runtime focused on core Copilot built-ins only.
     */
    private _getMinimalWorkerTools(): readonly {
        name: string;
        description?: string;
        inputSchema?: unknown;
        tags?: readonly string[];
    }[] {
        // Explicit minimal set only. This avoids huge catalogs from other extensions
        // and keeps worker tabs focused on core built-in capabilities.
        const ALLOWED_TOOL_NAMES = new Set([
            'execution_subagent',
            'search_subagent',
            'explore_subagent',
            'skill',
            'copilot_findFiles',
            'copilot_findTextInFiles',
            'copilot_readFile',
            'copilot_listDirectory',
            'copilot_getErrors',
            'copilot_getChangedFiles',
            'copilot_searchCodebase',
            'copilot_searchWorkspaceSymbols',
            'copilot_applyPatch',
            'copilot_createFile',
            'copilot_createDirectory',
            'copilot_replaceString',
            'copilot_multiReplaceString',
            'copilot_viewImage',
            'copilot_fetchWebPage',
            'copilot_runVscodeCommand',
            'copilot_getVSCodeAPI',
        ]);

        return vscode.lm.tools.filter(t => ALLOWED_TOOL_NAMES.has(t.name));
    }

    /** Send available LM models and tool catalog to the webview */
    public async broadcastAvailableModels(): Promise<void> {
        try {
            const models = await vscode.lm.selectChatModels({});
            // Deduplicate by name — keep one entry per display name (prefer the model
            // whose id most closely matches its family, i.e. the canonical/shorter id).
            const seen = new Map<string, typeof models[0]>();
            for (const m of models) {
                const existing = seen.get(m.name);
                if (!existing || m.id.length < existing.id.length) {
                    seen.set(m.name, m);
                }
            }
            const modelList = Array.from(seen.values()).map(m => ({
                id: m.id,
                name: m.name,
                vendor: m.vendor,
                family: m.family,
                maxInputTokens: m.maxInputTokens
            }));
            this._broadcast({ type: 'availableModels', models: modelList });
            const tools = this._getMinimalWorkerTools().map(t => ({
                name: t.name,
                description: t.description || '',
                tags: Array.from(t.tags || [])
            }));
            this._broadcast({ type: 'availableTools', tools });
        } catch {
            // ignore — model list is best-effort
        }
    }

    /**
     * Run a worker task via delegated model execution.
     * Commands and sub-agents both run in the same agentic loop; user picks
     * model/agent/context/thinking from the panel controls.
     */
    public async runWorkerTaskWithModel(
        taskId: string,
        modelId: string,
        opts?: {
            agentName?: string;
            thinkingEffort?: 'low' | 'medium' | 'high';
        }
    ): Promise<void> {
        const entry = this._workerTasks.get(taskId);
        if (!entry) { return; }

        entry.status = 'running';
        this._broadcastWorkerQueue();

        try {
            const resolvedModelId = modelId || entry.modelId || '';
            const models = await vscode.lm.selectChatModels({});
            const model = models.find(m => m.id === resolvedModelId) ?? models[0];
            if (!model) {
                this.resolveWorkerTask(taskId, 'Error: no model available');
                return;
            }

            const cts = new vscode.CancellationTokenSource();

            const rtkEnabledForTools = this.isRtkCompressionEnabled();
            // run_terminal is a worker-local tool we implement ourselves so that, when RTK is
            // enabled, command output is actually routed through the `rtk` binary (real savings).
            const RUN_TERMINAL_TOOL: vscode.LanguageModelChatTool = {
                name: 'run_terminal',
                description: rtkEnabledForTools
                    ? 'Run a single shell command and get its output. RTK compression is ON: simple commands (ls, tree, git, grep, find, cat, diff, wc, env) are automatically routed through the rtk binary to minimize tokens. Use the fewest commands possible. Pass cwd separately instead of prefixing cd &&.'
                    : 'Run a single shell command and get its output. Use the fewest commands possible.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The shell command to run.' },
                        cwd: { type: 'string', description: 'Optional working directory. Prefer this over cd/chaining.' }
                    },
                    required: ['command']
                } as vscode.LanguageModelChatTool['inputSchema']
            };

            const minimalTools: vscode.LanguageModelChatTool[] = this._getMinimalWorkerTools()
                .map(t => ({
                    name: t.name,
                    description: t.description ?? '',
                    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as vscode.LanguageModelChatTool['inputSchema']
                }));

            // Command role: force our rtk-wrapped run_terminal + read-only file tools (no black-box
            // execution_subagent, so shell really goes through rtk). Subagent role: full minimal set.
            const READONLY_FILE_TOOLS = new Set(['copilot_readFile', 'copilot_listDirectory', 'copilot_findFiles', 'copilot_findTextInFiles']);
            const allTools: vscode.LanguageModelChatTool[] = entry.role === 'command'
                ? [RUN_TERMINAL_TOOL, ...minimalTools.filter(t => READONLY_FILE_TOOLS.has(t.name))]
                : minimalTools;

            const thinkingEffort = opts?.thinkingEffort || 'medium';
            const agentName = (opts?.agentName || 'default').trim();
            const rolePrompt = entry.role === 'command'
                ? 'You are a focused execution worker running on a cheaper model. You receive a SMALL TASK OBJECTIVE in plain language, NOT exact commands. Decide and run the minimal shell commands needed via the run_terminal tool, then return only the essential result. Keep commands simple and few. If the task specifies a working directory, pass it as run_terminal.cwd; do not use cd && command chaining.'
                : 'You are a delegated research/implementation agent. Use tools as needed and return concise final results.';
            const effortPrompt = thinkingEffort === 'high'
                ? 'Think deeply and reason thoroughly before finalizing.'
                : thinkingEffort === 'low'
                    ? 'Be brief and fast — skip unnecessary reasoning.'
                    : 'Use balanced reasoning.';
            const agentPrompt = agentName !== 'default'
                ? `Agent profile: ${agentName}. Follow this style profile while solving.`
                : '';

                        // RTK prompt: instruct model to use rtk CLI wrappers when RTK is enabled.
                        // rtk is a proxy CLI that compresses tool output to save tokens.
                        const rtkEnabled = this.isRtkCompressionEnabled();
                        const rtkDocPrompt = rtkEnabled ? await this.getRtkInstructionPrompt() : '';
            const rtkPrompt = rtkEnabled
                ? (entry.role === 'command'
                    ? 'Token optimization: RTK is ON. The run_terminal tool auto-compresses output for simple commands (ls, tree, git, grep, find, cat, diff, wc, env). Prefer those simple forms and avoid pipes/redirects so compression applies.'
                    : 'Token optimization: when running shell commands, prefer rtk wrappers to minimize context usage: ' +
                      '`rtk ls`, `rtk tree`, `rtk git <cmd>`, `rtk find`, `rtk grep`, `rtk diff`, `rtk read <file>`. ' +
                      'Use raw commands only when rtk has no equivalent.')
                : '';

            const systemPrompt = [rolePrompt, agentPrompt, effortPrompt, rtkPrompt, rtkDocPrompt].filter(Boolean).join(' ');

            // Agentic message history
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(entry.task)
            ];

            let finalText = '';
            const MAX_ITERATIONS = 20;

            for (let i = 0; i < MAX_ITERATIONS; i++) {
                const response = await model.sendRequest(
                    messages,
                    { tools: allTools },
                    cts.token
                );

                let turnText = '';
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        turnText += part.value;
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                    }
                }

                if (turnText) { finalText += (finalText ? '\n' : '') + turnText; }
                if (toolCalls.length === 0) { break; }

                messages.push(vscode.LanguageModelChatMessage.Assistant(
                    toolCalls.map(tc => new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input))
                ));

                const resultParts: vscode.LanguageModelToolResultPart[] = [];
                for (const tc of toolCalls) {
                    try {
                        if (tc.name === 'run_terminal') {
                            const input = tc.input as Record<string, unknown> | undefined;
                            const cmd = String(input?.command ?? '').trim();
                            const cwd = typeof input?.cwd === 'string' ? input.cwd.trim() : undefined;
                            const out = cmd
                                ? await this._runShellWithRtk(cmd, cwd)
                                : 'Error: command is required';
                            resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [
                                new vscode.LanguageModelTextPart(out)
                            ]));
                            continue;
                        }
                        const toolResult = await vscode.lm.invokeTool(
                            tc.name,
                            { input: tc.input as Record<string, unknown>, toolInvocationToken: undefined },
                            cts.token
                        );
                        resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, toolResult.content));
                    } catch (toolErr) {
                        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                        resultParts.push(new vscode.LanguageModelToolResultPart(tc.callId, [
                            new vscode.LanguageModelTextPart(`Tool error: ${msg}`)
                        ]));
                    }
                }

                messages.push(vscode.LanguageModelChatMessage.User(resultParts));
            }

            this.resolveWorkerTask(taskId, finalText || '(no output)');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.resolveWorkerTask(taskId, `Error: ${msg}`);
        }
    }

    /**
     * Extract and execute a shell command from a task description.
     * Pulls command from backticks if present, otherwise runs the full text as bash.
     */
    private _executeWorkerShellCommand(taskText: string): Promise<string> {
        // Try to extract command from backticks first
        const backtickMatch = taskText.match(/`([^`\n]+)`/);
        const command = backtickMatch ? backtickMatch[1].trim() : taskText.trim();

        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(command, { shell: '/bin/bash', timeout: 30000, maxBuffer: 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
                if (error && !stdout) {
                    resolve(stderr.trim() || error.message);
                } else {
                    // Return stdout; append stderr if both present
                    const out = stdout.trim();
                    const err2 = stderr.trim();
                    resolve(out + (err2 && out ? '\n--- stderr ---\n' + err2 : err2));
                }
            });
        });
    }

    /**
     * Rewrite a simple shell command to route through the `rtk` binary when RTK compression
     * is enabled, so output is compressed and `rtk gain` records real savings. Only single,
     * pipe-free commands with a known rtk equivalent are wrapped; everything else runs as-is.
     */
    private _wrapCommandWithRtk(command: string): string {
        if (!this.isRtkCompressionEnabled()) { return command; }
        const rtkBinary = this._findRtkBinary();
        if (!rtkBinary) { return command; }
        const rtk = this._shellQuote(rtkBinary);
        const trimmed = command.trim();
        if (/^rtk(\s|$)/.test(trimmed)) { return trimmed; }
        // Stay safe: do not wrap compound commands (pipes, redirects, chaining, subshells).
        if (/[|&;<>$`]/.test(trimmed) || /\$\(/.test(trimmed)) { return command; }
        const parts = trimmed.split(/\s+/);
        const first = parts[0];
        const rest = parts.slice(1).join(' ');
        if (first === 'git') { return `${rtk} git ${rest}`.trim(); }
        if (first === 'cat') { return `${rtk} read ${rest}`.trim(); }
        const directWrap = new Set(['ls', 'tree', 'grep', 'find', 'diff', 'wc', 'env']);
        if (directWrap.has(first)) { return `${rtk} ${trimmed}`; }
        return command;
    }

    private _findRtkBinary(): string | null {
        const pathCandidates = (process.env.PATH ?? '')
            .split(path.delimiter)
            .filter(Boolean)
            .map(dir => path.join(dir, 'rtk'));
        const candidates = [
            '/opt/homebrew/bin/rtk',
            '/usr/local/bin/rtk',
            ...pathCandidates
        ];

        for (const candidate of candidates) {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch {
                // Continue searching.
            }
        }

        return null;
    }

    private _shellQuote(value: string): string {
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    /**
     * Execute a shell command for a worker, routing through rtk when enabled.
     * This is the path that makes RTK savings real (vs. the model calling a black-box subagent).
     */
    private _runShellWithRtk(command: string, requestedCwd?: string): Promise<string> {
        const finalCmd = this._wrapCommandWithRtk(command);
        const cwd = requestedCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(finalCmd, { shell: '/bin/bash', cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
                const out = (stdout || '').trim();
                const err = (stderr || '').trim();
                if (error && !out) {
                    resolve(err || error.message);
                } else {
                    resolve(out + (err && out ? '\n--- stderr ---\n' + err : err));
                }
            });
        });
    }

    // Legacy: keep waitForTask/submitTaskResult for backward compat
    public waitForTask(role: string): Promise<string> {
        return new Promise<string>((resolve) => {
            let queue = this._workerQueues.get(role);
            if (!queue) { queue = { pendingTask: null, workerReady: null }; this._workerQueues.set(role, queue); }
            if (queue.pendingTask) { resolve(queue.pendingTask.task); }
            else { queue.workerReady = resolve; }
        });
    }
    public submitTaskResult(role: string, result: string): void {
        const queue = this._workerQueues.get(role);
        if (queue?.pendingTask) { queue.pendingTask.resolve(result); queue.pendingTask = null; }
    }
    public isWorkerRegistered(role: string): boolean {
        const queue = this._workerQueues.get(role);
        return !!queue && (queue.workerReady !== null || queue.pendingTask !== null);
    }

    /** Get the active plan task ID (if plan is executing) */
    public getActivePlanTaskId(): string | null {
        return this._planEditor?.getActiveTaskId() ?? null;
    }

    /** Classify whether Copilot's message indicates task completion or mid-task question */
    public async classifyTaskProgress(taskId: string, question: string): Promise<'completed' | 'in-progress'> {
        return this._planEditor?.classifyTaskProgress(taskId, question) ?? 'completed';
    }

    /**
     * Handle a response coming from an external messaging service (Webex/Telegram)
     */
    private _handleMessagingResponse(taskId: string, response: string, user: string, attachments?: AttachmentInfo[]): void {
        // The taskId from messaging services is the toolCallId
        if (!this._currentToolCallId) { return; }

        const resolve = this._pendingRequests.get(this._currentToolCallId);
        if (!resolve) { return; }

        // Update the pending entry
        const pendingEntry = this._currentSessionCallsMap.get(this._currentToolCallId);
        if (pendingEntry && pendingEntry.status === 'pending') {
            pendingEntry.response = `${response} [via ${user}]`;
            pendingEntry.status = 'completed';
            pendingEntry.timestamp = Date.now();
        }

        // Clear pending request for remote clients
        this._currentPendingRequest = null;

        // Broadcast completion
        if (pendingEntry) {
            this._broadcast({
                type: 'toolCallCompleted',
                entry: pendingEntry
            });
        }

        this._updateCurrentSessionUI();
        this._resetTurnMetrics();
        const resolvedMsgId = this._currentToolCallId;
        resolve({ value: response, queue: this._queueEnabled, attachments: attachments || [] });
        this._pendingRequests.delete(this._currentToolCallId);
        this._currentToolCallId = null;
        this._signalNextWaiter();
        // Also tell whichever service did NOT deliver this reply to stop polling
        this._telegramService?.resolveTask?.(resolvedMsgId);
        this._webexService?.resolveTask?.(resolvedMsgId);
    }

    public setRemoteBroadcastCallback(callback: ((message: ToWebviewMessage) => void) | null): void {
        this._remoteBroadcastCallback = callback;
    }

    /**
     * Get current state for remote clients (used when a new client connects)
     */
    public getStateForRemote(): {
        queue: QueuedPrompt[];
        queueEnabled: boolean;
        currentSession: ToolCallEntry[];
        persistedHistory: ToolCallEntry[];
        pendingRequest: { id: string; prompt: string; isApprovalQuestion: boolean; choices?: ParsedChoice[] } | null;
        settings: { soundEnabled: boolean; interactiveApprovalEnabled: boolean; webexEnabled: boolean; telegramEnabled: boolean; reusablePrompts: ReusablePrompt[] };
    } {
        const webexEnabled = this._getWebexEnabled();
        const telegramEnabled = this._getTelegramEnabled();
        return {
            queue: this._promptQueue,
            queueEnabled: this._queueEnabled,
            currentSession: this._currentSessionCalls,
            persistedHistory: this._persistedHistory,
            pendingRequest: this._currentPendingRequest,
            settings: {
                soundEnabled: this._soundEnabled,
                interactiveApprovalEnabled: this._interactiveApprovalEnabled,
                webexEnabled,
                telegramEnabled,
                reusablePrompts: this._reusablePrompts
            }
        };
    }

    /**
     * Handle message from remote client (web/mobile)
     * Routes messages to the same handlers as the VS Code webview
     */
    public handleRemoteMessage(message: FromWebviewMessage): void {
        this._handleWebviewMessage(message);
    }

    /**
     * Broadcast message to both VS Code webview and remote clients
     */
    private _broadcast(message: ToWebviewMessage): void {
        // Send to VS Code webview if available
        this._view?.webview.postMessage(message);
        
        // Send to remote clients if callback is set
        if (this._remoteBroadcastCallback) {
            this._remoteBroadcastCallback(message);
        }
    }

    // ================== End Remote Server Integration ==================

    /**
     * Save current tool call history to persisted history (called on deactivate)
     * Uses synchronous save because deactivate cannot await async operations
     */
    public saveCurrentSessionToHistory(): void {
        // Cancel any pending debounced saves
        if (this._historySaveTimer) {
            clearTimeout(this._historySaveTimer);
            this._historySaveTimer = null;
        }

        // Only save completed calls from current session
        const completedCalls = this._currentSessionCalls.filter(tc => tc.status === 'completed');
        if (completedCalls.length > 0) {
            // Prepend current session calls to persisted history, enforce max limit
            this._persistedHistory = [...completedCalls, ...this._persistedHistory].slice(0, this._MAX_HISTORY_ENTRIES);
            this._historyDirty = true;
        }

        // Force sync save on deactivation (async operations can't complete in deactivate)
        this._savePersistedHistoryToDiskSync();
    }

    /**
     * Open history modal (called from view title bar button)
     */
    public openHistoryModal(): void {
        this._view?.webview.postMessage({ type: 'openHistoryModal' });
        this._updatePersistedHistoryUI();
    }

    /**
     * Open settings modal (called from view title bar button)
     */
    public openSettingsModal(): void {
        this._view?.webview.postMessage({ type: 'openSettingsModal' } as ToWebviewMessage);
        this._updateSettingsUI();
    }

    /**
     * Clear current session tool calls (called from view title bar button)
     * Preserves any pending tool call entry so responses don't lose their prompt
     * Cleans up temporary images associated with cleared entries
     */
    public clearCurrentSession(): void {
        // Preserve pending entry if there is one
        let pendingEntry: ToolCallEntry | undefined;
        if (this._currentToolCallId) {
            pendingEntry = this._currentSessionCallsMap.get(this._currentToolCallId);
        }

        // Clean up temp images from entries being cleared (except pending)
        const entriesToClear = pendingEntry
            ? this._currentSessionCalls.filter(e => e.id !== pendingEntry!.id)
            : this._currentSessionCalls;
        this._cleanupTempImagesFromEntries(entriesToClear);

        // Clear all entries
        this._currentSessionCalls = [];
        this._currentSessionCallsMap.clear();

        // Restore pending entry if we had one
        if (pendingEntry) {
            this._currentSessionCalls.push(pendingEntry);
            this._currentSessionCallsMap.set(pendingEntry.id, pendingEntry);
        }

        this._updateCurrentSessionUI();
    }

    /**
     * Trigger send from keyboard shortcut (Ctrl/Cmd+Enter)
     */
    public triggerSendFromShortcut(): void {
        this._view?.webview.postMessage({ type: 'triggerSendFromShortcut' } as ToWebviewMessage);
    }

    /**
     * Start a new session: save current session to history, then clear
     */
    public startNewSession(): void {
        this.saveCurrentSessionToHistory();
        this.clearCurrentSession();

        // Reset session state
        this._sessionStartTime = null;
        this._sessionFrozenElapsed = null;
        this._sessionTerminated = false;
        this._sessionWarningShown = false;
        this._consecutiveAutoResponses = 0;
        this._autopilotIndex = 0;
        if (this._responseTimeoutTimer) {
            clearTimeout(this._responseTimeoutTimer);
            this._responseTimeoutTimer = null;
        }
        this._stopSessionTimerInterval();

        // Show welcome section again
        this._view?.webview.postMessage({ type: 'clear' } as ToWebviewMessage);
    }

    /**
     * Play notification sound (called when ask_user tool is triggered)
     * Works even when webview is not visible by using system sound
     */
    public playNotificationSound(): void {
        if (this._soundEnabled) {
            // Play system sound from extension host (works even when webview is hidden)
            this._playSystemSound();

            // Also try webview audio if visible (better quality)
            this._view?.webview.postMessage({ type: 'playNotificationSound' } as ToWebviewMessage);
        }
    }

    /**
     * Play system sound using OS-native methods
     * Works even when webview is minimized or hidden
     */
    private _playSystemSound(): void {
        const { exec } = require('child_process');
        const platform = process.platform;

        try {
            if (platform === 'win32') {
                // Windows: Use PowerShell to play system exclamation sound
                exec('[System.Media.SystemSounds]::Exclamation.Play()', { shell: 'powershell.exe' });
            } else if (platform === 'darwin') {
                // macOS: Use afplay with system sound
                exec('afplay /System/Library/Sounds/Tink.aiff 2>/dev/null || printf "\\a"');
            } else {
                // Linux: Try multiple methods
                exec('paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null || printf "\\a"');
            }
        } catch (e) {
            // Sound playing failed - not critical
        }
    }

    /**
     * Load settings from VS Code configuration
     */
    private _getAutopilotDefaultText(config?: vscode.WorkspaceConfiguration): string {
        const settings = config ?? vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const inspected = settings.inspect<string>('autopilotText');
        const defaultValue = typeof inspected?.defaultValue === 'string' ? inspected.defaultValue : '';
        return defaultValue.trim().length > 0 ? defaultValue : this._AUTOPILOT_DEFAULT_TEXT;
    }

    private _normalizeAutopilotText(text: string, config?: vscode.WorkspaceConfiguration): string {
        const defaultAutopilotText = this._getAutopilotDefaultText(config);
        return text.trim().length > 0 ? text : defaultAutopilotText;
    }

    private _loadSettings(): void {
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        this._soundEnabled = config.get<boolean>('notificationSound', true);
        this._interactiveApprovalEnabled = config.get<boolean>('interactiveApproval', true);

        // Backward-compatible migration: read old 'autoAnswer'/'autoAnswerText' keys
        // if the new 'autopilot'/'autopilotText' keys have not been explicitly set by the user.
        const inspectedAutopilot = config.inspect<boolean>('autopilot');
        const hasNewAutopilotKey = inspectedAutopilot?.globalValue !== undefined
            || inspectedAutopilot?.workspaceValue !== undefined
            || inspectedAutopilot?.workspaceFolderValue !== undefined;

        if (!hasNewAutopilotKey) {
            const oldVal = config.inspect<boolean>('autoAnswer');
            const hasOldKey = oldVal?.globalValue !== undefined
                || oldVal?.workspaceValue !== undefined
                || oldVal?.workspaceFolderValue !== undefined;
            if (hasOldKey) {
                this._autopilotEnabled = config.get<boolean>('autoAnswer', false);
            } else {
                this._autopilotEnabled = false;
            }
        } else {
            this._autopilotEnabled = config.get<boolean>('autopilot', false);
        }

        const defaultAutopilotText = this._getAutopilotDefaultText(config);

        const inspectedAutopilotText = config.inspect<string>('autopilotText');
        const hasNewAutopilotTextKey = inspectedAutopilotText?.globalValue !== undefined
            || inspectedAutopilotText?.workspaceValue !== undefined
            || inspectedAutopilotText?.workspaceFolderValue !== undefined;

        if (!hasNewAutopilotTextKey) {
            const oldTextVal = config.inspect<string>('autoAnswerText');
            const hasOldTextKey = oldTextVal?.globalValue !== undefined
                || oldTextVal?.workspaceValue !== undefined
                || oldTextVal?.workspaceFolderValue !== undefined;
            if (hasOldTextKey) {
                const oldText = config.get<string>('autoAnswerText', defaultAutopilotText);
                this._autopilotText = this._normalizeAutopilotText(oldText, config);
            } else {
                this._autopilotText = defaultAutopilotText;
            }
        } else {
            const configuredAutopilotText = config.get<string>('autopilotText', defaultAutopilotText);
            this._autopilotText = this._normalizeAutopilotText(configuredAutopilotText, config);
        }

        // Load reusable prompts from settings
        const savedPrompts = config.get<Array<{ name: string; prompt: string }>>('reusablePrompts', []);
        this._reusablePrompts = savedPrompts.map((p, index) => ({
            id: `rp_${index}_${Date.now()}`,
            name: p.name,
            prompt: p.prompt
        }));

        // Load autopilot prompts array (with fallback to autopilotText for migration)
        const savedAutopilotPrompts = config.get<string[]>('autopilotPrompts', []);
        if (savedAutopilotPrompts.length > 0) {
            this._autopilotPrompts = savedAutopilotPrompts.filter(p => p.trim().length > 0);
        } else if (this._autopilotText && this._autopilotText !== defaultAutopilotText) {
            this._autopilotPrompts = [this._autopilotText];
        } else {
            this._autopilotPrompts = [];
        }

        // Load human-like delay settings
        this._humanLikeDelayEnabled = config.get<boolean>('humanLikeDelay', true);
        this._humanLikeDelayMin = config.get<number>('humanLikeDelayMin', 2);
        this._humanLikeDelayMax = config.get<number>('humanLikeDelayMax', 6);
        const configuredWarningHours = config.get<number>('sessionWarningHours', 2);
        this._sessionWarningHours = Number.isFinite(configuredWarningHours)
            ? Math.min(8, Math.max(0, Math.floor(configuredWarningHours)))
            : 2;
        this._sendWithCtrlEnter = config.get<boolean>('sendWithCtrlEnter', false);
        // Ensure min <= max
        if (this._humanLikeDelayMin > this._humanLikeDelayMax) {
            this._humanLikeDelayMin = this._humanLikeDelayMax;
        }
    }

    /**
     * Save reusable prompts to VS Code configuration
     */
    private async _saveReusablePrompts(): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            const promptsToSave = this._reusablePrompts.map(p => ({
                name: p.name,
                prompt: p.prompt
            }));
            await config.update('reusablePrompts', promptsToSave, vscode.ConfigurationTarget.Global);
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    // ── Human-like delay & response timeout helpers (ported from upstream) ──

    /**
     * Generate a random delay (jitter) between min and max seconds.
     * Random delays simulate natural human pacing.
     */
    private _getHumanLikeDelayMs(): number {
        if (!this._humanLikeDelayEnabled) { return 0; }
        const minMs = this._humanLikeDelayMin * 1000;
        const maxMs = this._humanLikeDelayMax * 1000;
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }

    /**
     * Wait a random duration before sending an automated response.
     */
    private async _applyHumanLikeDelay(label?: string): Promise<void> {
        const delayMs = this._getHumanLikeDelayMs();
        if (delayMs > 0) {
            const delaySec = (delayMs / 1000).toFixed(1);
            if (label) {
                vscode.window.setStatusBarMessage(`AskAway: ${label} responding in ${delaySec}s...`, delayMs);
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    private _normalizeResponseTimeout(value: unknown): number {
        let parsedValue: number;
        if (typeof value === 'number') { parsedValue = value; }
        else if (typeof value === 'string') {
            const normalized = value.trim();
            if (normalized.length === 0) { return this._RESPONSE_TIMEOUT_DEFAULT_MINUTES; }
            parsedValue = Number(normalized);
        } else {
            return this._RESPONSE_TIMEOUT_DEFAULT_MINUTES;
        }
        if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue)) {
            return this._RESPONSE_TIMEOUT_DEFAULT_MINUTES;
        }
        if (!this._RESPONSE_TIMEOUT_ALLOWED_MINUTES.has(parsedValue)) {
            return this._RESPONSE_TIMEOUT_DEFAULT_MINUTES;
        }
        return parsedValue;
    }

    private _readResponseTimeoutMinutes(config?: vscode.WorkspaceConfiguration): number {
        const settings = config ?? vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const configuredTimeout = settings.get<string>('responseTimeout', String(this._RESPONSE_TIMEOUT_DEFAULT_MINUTES));
        return this._normalizeResponseTimeout(configuredTimeout);
    }

    /**
     * Start a timer that auto-responds if user doesn't respond within the configured timeout.
     */
    private _startResponseTimeoutTimer(toolCallId: string): void {
        if (this._responseTimeoutTimer) {
            clearTimeout(this._responseTimeoutTimer);
            this._responseTimeoutTimer = null;
        }
        const timeoutMinutes = this._readResponseTimeoutMinutes();
        if (timeoutMinutes <= 0) { return; }
        const timeoutMs = timeoutMinutes * 60 * 1000;
        this._responseTimeoutTimer = setTimeout(() => {
            this._handleResponseTimeout(toolCallId);
        }, timeoutMs);
    }

    /**
     * Handle response timeout — auto-respond after user idle.
     */
    private async _handleResponseTimeout(toolCallId: string): Promise<void> {
        this._responseTimeoutTimer = null;
        if (this._currentToolCallId !== toolCallId || !this._pendingRequests.has(toolCallId)) { return; }

        await this._applyHumanLikeDelay('Timeout');
        if (this._currentToolCallId !== toolCallId || !this._pendingRequests.has(toolCallId)) { return; }

        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const timeoutMinutes = this._readResponseTimeoutMinutes(config);
        const maxConsecutive = config.get<number>('maxConsecutiveAutoResponses', 5);

        this._consecutiveAutoResponses++;
        let responseText: string;
        let isTermination = false;

        if (this._consecutiveAutoResponses > maxConsecutive) {
            responseText = this._SESSION_TERMINATION_TEXT;
            isTermination = true;
            vscode.window.showWarningMessage(`AskAway: Auto-response limit (${maxConsecutive}) reached. Session terminated after ${timeoutMinutes} min idle.`);
        } else if (this._autopilotEnabled) {
            responseText = this._normalizeAutopilotText(this._autopilotText);
            vscode.window.showInformationMessage(`AskAway: Auto-responded after ${timeoutMinutes} min idle. (${this._consecutiveAutoResponses}/${maxConsecutive})`);
        } else {
            responseText = this._SESSION_TERMINATION_TEXT;
            isTermination = true;
            vscode.window.showInformationMessage(`AskAway: Session terminated after ${timeoutMinutes} min idle.`);
        }

        const resolve = this._pendingRequests.get(toolCallId);
        if (resolve) {
            const pendingEntry = this._currentSessionCallsMap.get(toolCallId);
            if (pendingEntry && pendingEntry.status === 'pending') {
                pendingEntry.response = responseText;
                pendingEntry.status = 'completed';
                pendingEntry.timestamp = Date.now();
                this._view?.webview.postMessage({ type: 'toolCallCompleted', entry: pendingEntry } as ToWebviewMessage);
            }
            this._updateCurrentSessionUI();
            this._resetTurnMetrics();
            resolve({ value: responseText, queue: this._queueEnabled && this._promptQueue.length > 0, attachments: [] });
            this._pendingRequests.delete(toolCallId);
            this._currentToolCallId = null;
            this._signalNextWaiter();
            this._telegramService?.resolveTask?.(toolCallId);
            this._webexService?.resolveTask?.(toolCallId);

            if (isTermination) {
                this._sessionTerminated = true;
                if (this._sessionStartTime !== null) {
                    this._sessionFrozenElapsed = Date.now() - this._sessionStartTime;
                    this._stopSessionTimerInterval();
                }
            }
        }
    }

    private _formatElapsed(ms: number): string {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) { return `${h}h ${m}m`; }
        return `${m}m ${s}s`;
    }

    private _startSessionTimerInterval(): void {
        if (this._sessionTimerInterval) return;
        this._sessionTimerInterval = setInterval(() => {
            if (this._sessionStartTime !== null && this._sessionFrozenElapsed === null) {
                const elapsed = Date.now() - this._sessionStartTime;
                if (this._view) { this._view.title = this._formatElapsed(elapsed); }
                const warningThresholdMs = this._sessionWarningHours * 60 * 60 * 1000;
                if (this._sessionWarningHours > 0 && !this._sessionWarningShown && elapsed >= warningThresholdMs) {
                    this._sessionWarningShown = true;
                    const callCount = this._currentSessionCalls.length;
                    const hoursLabel = this._sessionWarningHours === 1 ? 'hour' : 'hours';
                    vscode.window.showWarningMessage(
                        `Your session has been running for over ${this._sessionWarningHours} ${hoursLabel} (${callCount} tool calls). Consider starting a new session.`,
                        'New Session', 'Dismiss'
                    ).then(action => {
                        if (action === 'New Session') { this.startNewSession(); }
                    });
                }
            }
        }, 1000);
    }

    private _stopSessionTimerInterval(): void {
        if (this._sessionTimerInterval) {
            clearInterval(this._sessionTimerInterval);
            this._sessionTimerInterval = null;
        }
    }

    /**
     * Update settings UI in webview
     */
    private _updateSettingsUI(): void {
        // Get status from services if available
        const webexStatus = this._webexService?.getTokenStatus?.() ?? null;
        const telegramStatus = this._telegramService?.getTokenStatus?.() ?? null;
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const responseTimeout = this._readResponseTimeoutMinutes(config);
        const maxConsecutiveAutoResponses = config.get<number>('maxConsecutiveAutoResponses', 5);
        const turnBudgetAiu = config.get<number>('turnBudgetAiu', 0);
        const debugLoggingEnabled = vscode.workspace.getConfiguration('github.copilot.chat')
            .get<boolean>('agentDebugLog.fileLogging.enabled', false);
        const rtkCompressionEnabled = fs.existsSync(path.join(os.homedir(), '.askaway-rtk-enabled')) && this.isRtkInstalled();
        const rtkInstalled = this.isRtkInstalled();
        // Auto-compaction toggle reflects Copilot's summarizeAgentConversationHistory.enabled
        // (default ON). The AskAway switch is inverted: checked = compaction disabled.
        const summarizeEnabled = vscode.workspace.getConfiguration('github.copilot.chat')
            .get<boolean>('summarizeAgentConversationHistory.enabled', true);
        const autoCompactionDisabled = summarizeEnabled === false;
        // Native Copilot prompt-cache levers (both user-settable in the Copilot manifest).
        const copilotChatCfg = vscode.workspace.getConfiguration('github.copilot.chat');
        const extendedCacheTtl = copilotChatCfg.get<boolean>('anthropic.promptCaching.extendedTtl', false);
        const extendedCacheTtlMessages = copilotChatCfg.get<boolean>('anthropic.promptCaching.extendedTtlMessages', false);
        const cacheKeepWarmEnabled = copilotChatCfg.get<boolean>('agent.longToolCallCachePreservation.enabled', false);
        const cacheKeepWarmProbes = copilotChatCfg.get<number>('agent.longToolCallCachePreservation.maxProbes', 1);

        this._broadcast({
            type: 'updateSettings',
            soundEnabled: this._soundEnabled,
            interactiveApprovalEnabled: this._interactiveApprovalEnabled,
            webexEnabled: this._getWebexEnabled(),
            telegramEnabled: this._getTelegramEnabled(),
            autopilotEnabled: this._autopilotEnabled,
            autopilotText: this._autopilotText,
            autopilotPrompts: this._autopilotPrompts,
            reusablePrompts: this._reusablePrompts,
            responseTimeout,
            sessionWarningHours: this._sessionWarningHours,
            maxConsecutiveAutoResponses,
            turnBudgetAiu,
            humanLikeDelayEnabled: this._humanLikeDelayEnabled,
            humanLikeDelayMin: this._humanLikeDelayMin,
            humanLikeDelayMax: this._humanLikeDelayMax,
            sendWithCtrlEnter: this._sendWithCtrlEnter,
            debugLoggingEnabled,
            rtkCompressionEnabled,
            rtkInstalled,
            autoCompactionDisabled,
            extendedCacheTtl,
            extendedCacheTtlMessages,
            cacheKeepWarmEnabled,
            cacheKeepWarmProbes,
            webexStatus,
            telegramStatus
        } as any);

        void this._broadcastObservabilityMetrics();
    }

    private async _broadcastObservabilityMetrics(): Promise<void> {
        // Re-entrancy guard: the async scan (reads debug logs, advances offsets, accumulates
        // the turn totals) can take >1 poll interval. Without this guard, overlapping runs
        // read the same bytes twice and DOUBLE-COUNT the "This turn" credits (2K vs true 1K).
        if (this._observabilityScanning) {
            return;
        }
        this._observabilityScanning = true;
        try {
            const nextMetrics = await this._collectObservabilityMetrics();
            nextMetrics.lastRequest = this._deriveLastRequest();
            this._observabilityCache = this._stabilizeObservabilityMetrics(nextMetrics);
            this._observabilityLastReadAt = Date.now();

            this._broadcast({
                type: 'updateObservabilityMetrics',
                metrics: this._observabilityCache
            });
        } finally {
            this._observabilityScanning = false;
        }

        void this._broadcastMemoriesList();
    }

    private async _broadcastMemoriesList(): Promise<void> {
        try {
            const memories = await listMemories(getUserMemoryDir(this._context));
            this._broadcast({ type: 'updateMemoriesList', memories });
        } catch {
            // Best-effort; memories list is non-critical.
        }
    }

    private _stabilizeObservabilityMetrics(next: ObservabilityMetrics): ObservabilityMetrics {
        const previous = this._observabilityCache;
        if (previous.updatedAt <= 0) {
            return next;
        }

        if (next.source === 'unavailable') {
            return {
                ...previous,
                source: previous.source === 'unavailable' ? 'unavailable' : `${previous.source} (last good)`,
                updatedAt: next.updatedAt
            };
        }

        // Workspace cumulative is monotonic; guard against transient under-reads.
        const workspace: ScopeMetrics = {
            requestCount: Math.max(previous.workspace.requestCount, next.workspace.requestCount),
            inputTokens: Math.max(previous.workspace.inputTokens, next.workspace.inputTokens),
            outputTokens: Math.max(previous.workspace.outputTokens, next.workspace.outputTokens),
            cachedTokens: Math.max(previous.workspace.cachedTokens, next.workspace.cachedTokens),
            nanoAiu: Math.max(previous.workspace.nanoAiu, next.workspace.nanoAiu)
        };

        // Month overall is now a STATELESS recompute from current on-disk logs, so it must be
        // allowed to correct in EITHER direction (self-heal) — do NOT latch it with Math.max,
        // which previously locked in a bad (inflated) value for the whole session. Pass it through.
        const overall: ScopeMetrics = { ...next.overall };

        return {
            ...next,
            workspace,
            overall,
            // Mirror workspace cumulative into the flat fields for backward compatibility.
            requestCount: workspace.requestCount,
            inputTokens: workspace.inputTokens,
            outputTokens: workspace.outputTokens,
            cachedTokens: workspace.cachedTokens,
            nanoAiu: workspace.nanoAiu,
            rtkCommandCount: Math.max(previous.rtkCommandCount, next.rtkCommandCount),
            rtkSavedTokens: Math.max(previous.rtkSavedTokens, next.rtkSavedTokens)
        };
    }

    private _emptyScope(): ScopeMetrics {
        return { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0 };
    }

    private _getMonthKey(ts: number): string {
        const d = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    }

    private async _collectObservabilityMetrics(): Promise<ObservabilityMetrics> {
        const emptyMetrics = (): ObservabilityMetrics => ({
            requestCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            nanoAiu: 0,
            lastRequest: this._emptyScope(),
            workspace: this._emptyScope(),
            overall: this._emptyScope(),
            perModel: [],
            overallCompaction: { count: 0, nanoAiu: 0 },
            turnRequests: [],
            turnEvents: [],
            turnSubagents: [],
            rtkCommandCount: 0,
            rtkSavedTokens: 0,
            rtkSavingsPct: 0,
            gradle: { runs: 0, optimizedRuns: 0, tasksAvoided: 0, configCacheReuses: 0, savedTokens: 0 },
            toolCalls: { totalCalls: 0, totalOutputTokens: 0, byTool: [], turn: { totalCalls: 0, totalOutputTokens: 0, byTool: [] } },
            lastRequestTs: 0,
            source: 'unavailable',
            updatedAt: Date.now()
        });

        try {
            const workspaceKey = this._getObservabilityWorkspaceKey();
            const ledger = await this._loadObservabilityLedger(workspaceKey);
            await this._loadLogOffsets();
            const logFiles = await this._findWorkspaceCopilotDebugLogFiles();
            const currentMonth = this._getMonthKey(Date.now());

            if (logFiles.length === 0) {
                const rtk = await this._collectRtkObservability();
                const gradleObs = await this._collectGradleObservability();
                const toolObs = await this._collectToolCallObservability();
                const overall = await this._computeOverallMonth(currentMonth);
                const workspaceScope: ScopeMetrics = {
                    requestCount: ledger.requestCount,
                    inputTokens: ledger.inputTokens,
                    outputTokens: ledger.outputTokens,
                    cachedTokens: ledger.cachedTokens,
                    nanoAiu: ledger.nanoAiu,
                    cacheMisses: ledger.cacheMisses || 0
                };
                const base = emptyMetrics();
                return {
                    ...base,
                    lastRequestTs: this._effectiveCacheActivityTs(),
                    requestCount: workspaceScope.requestCount,
                    inputTokens: workspaceScope.inputTokens,
                    outputTokens: workspaceScope.outputTokens,
                    cachedTokens: workspaceScope.cachedTokens,
                    nanoAiu: workspaceScope.nanoAiu,
                    workspace: workspaceScope,
                    lastRequest: this._deriveLastRequest(),
                    overall: overall.totals,
                    perModel: overall.perModel,
                    overallCompaction: overall.compaction,
                    turnRequests: [...this._turnRequests],
                    turnEvents: [...this._turnEvents],
                    turnSubagents: Array.from(this._turnSubagents.values()),
                    rtkCommandCount: rtk.commandCount,
                    rtkSavedTokens: rtk.savedTokens,
                    rtkSavingsPct: rtk.savingsPct,
                    gradle: this._gradleWithSavings(gradleObs, toolObs),
                    toolCalls: toolObs,
                    source: ledger.requestCount > 0 ? 'ledger:last good' : 'unavailable'
                };
            }

            const rawRows: string[] = [];
            const toolRows: string[] = [];
            // Ordered summaries of NEW requests this pass — used to attach before/after
            // neighbor context to cache-miss records (so a spike points at its surroundings).
            const scanSummaries: ReqSummary[] = [];
            // "This turn" is accumulated into this._lastRequestMetrics across polls. Because we now
            // read only NEW bytes each poll (incremental), we must ADD to the running total rather
            // than recompute from a full-file scan. The total is reset to empty at each turn
            // boundary (user submit / user_message log line) via _resetTurnMetrics().
            for (const logFile of logFiles) {
                let raw = '';
                let lineIndexBase = 0;
                try {
                    // Incremental read: only consume bytes added since the last poll.
                    // This avoids re-scanning the entire (potentially 10k+ line) JSONL on every tick.
                    const entry = this._logFileReadOffsets.get(logFile);
                    const knownOffset = entry?.byteOffset ?? 0;
                    const knownLineCount = entry?.lineCount ?? 0;
                    const fd = await fs.promises.open(logFile, 'r');
                    try {
                        const fileSize = (await fd.stat()).size;
                        if (fileSize > knownOffset) {
                            const buf = Buffer.allocUnsafe(fileSize - knownOffset);
                            await fd.read(buf, 0, buf.length, knownOffset);
                            // Only consume up to the last complete line (newline boundary) so a
                            // partially-flushed trailing line isn't split across polls, which would
                            // corrupt line indexing and JSON parsing.
                            const lastNl = buf.lastIndexOf(0x0a);
                            if (lastNl < 0) {
                                // No complete line yet; wait for more data.
                                continue;
                            }
                            raw = buf.toString('utf8', 0, lastNl + 1);
                            lineIndexBase = knownLineCount;
                            // Advance offset to the newline boundary; count only complete lines.
                            const consumedLines = raw.split('\n').length - 1; // trailing '' after final \n
                            this._logFileReadOffsets.set(logFile, {
                                byteOffset: knownOffset + lastNl + 1,
                                lineCount: knownLineCount + consumedLines
                            });
                        }
                    } finally {
                        await fd.close();
                    }
                } catch {
                    continue;
                }
                if (!raw) {
                    continue;
                }

                // Parent turn = main.jsonl; child sub-agent sessions (runSubagent-*.jsonl) live in
                // the SAME session dir, so derive a unique sessionId from the child file name to keep
                // dedup keys (sid:li:hash) and short request IDs distinct from the parent's.
                const isChildLog = this._isChildSubagentLog(logFile);
                const sessionId = isChildLog
                    ? path.basename(logFile, '.jsonl')
                    : path.basename(path.dirname(logFile));
                const subagentLabel = isChildLog ? this._parseSubagentLabel(path.basename(logFile)) : undefined;
                // Group key for this sub-agent instance = short hash of its child session id (the
                // trailing filename segment, e.g. `runSubagent-Explore-toolu_01Cha.jsonl`). Stable
                // across polls so parallel sub-agents stay in distinct collapsible groups. NOTE: we
                // do NOT register the sub-agent here — only when it emits an IN-WINDOW event (see
                // the request/tool push below) — otherwise old child files (previous turn) that get
                // read this poll would inflate the header count with no rows to show.
                let subagentId: string | undefined;
                if (isChildLog) {
                    const base = path.basename(logFile, '.jsonl');
                    const childSid = base.split('-').slice(-1)[0] || base;
                    subagentId = this._shortSubagentId(childSid);
                }
                const lines = raw.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const lineIndex = lineIndexBase + i;
                    const line = lines[i];
                    if (!line) {
                        continue;
                    }

                    // ── User-submit boundary: `user_message` fires once per real user
                    // submission (unlike `turn_start`, which fires for every agent iteration).
                    // Use the log timestamp as the precise "This turn" window start.
                    // IMPORTANT: only the PARENT (main.jsonl) user_message is a real turn boundary.
                    // Child sub-agent logs also contain a user_message (the sub-agent's own prompt);
                    // resetting on those would wipe the parent turn's accumulated sub-agent credits.
                    if (!isChildLog && line.indexOf('"type":"user_message"') !== -1) {
                        try {
                            const ts = (JSON.parse(line) as { ts?: number }).ts;
                            if (typeof ts === 'number' && ts > this._logTurnStartTs) {
                                this._logTurnStartTs = ts;
                                this._resetTurnMetrics(ts);
                            }
                        } catch { /* malformed — skip */ }
                        continue;
                    }

                    // ── Sub-agent linkage: `child_session_ref` (in main.jsonl) maps the parent
                    // runSubagent tool_call's span to a child session/log so we can attribute the
                    // parent tool_call's authoritative duration/output to the correct group.
                    if (!isChildLog && line.indexOf('"type":"child_session_ref"') !== -1) {
                        try {
                            const c = JSON.parse(line) as Record<string, unknown>;
                            const cAttrs = (c.attrs as Record<string, unknown> | undefined) ?? {};
                            const childFile = typeof cAttrs.childLogFile === 'string' ? cAttrs.childLogFile : '';
                            const childSid = typeof cAttrs.childSessionId === 'string' ? cAttrs.childSessionId : '';
                            const parentSpan = typeof c.parentSpanId === 'string' ? c.parentSpanId : '';
                            if (childSid && parentSpan) {
                                const saId = this._shortSubagentId(childSid);
                                this._turnSpanToSubagent.set(parentSpan, saId);
                                // Remember the label so a finalize/event can name it — but DON'T create
                                // a header entry here (a spawn ref alone shouldn't inflate the count;
                                // the group appears only once it has an in-window event).
                                if (childFile) { this._turnSubagentLabelById.set(saId, this._parseSubagentLabel(childFile)); }
                            }
                        } catch { /* malformed — skip */ }
                        continue;
                    }

                    // ── Tool-call telemetry: Copilot logs EVERY tool invocation (built-in
                    // + custom) as a `tool_call` entry with name/dur(ms)/status plus
                    // attrs.args (input) and attrs.result (output). Ingest all of them so the
                    // table isn't limited to AskAway's own tools. Append to the durable
                    // append-only usage-tools log and accumulate the current turn.
                    if (line.indexOf('"type":"tool_call"') !== -1) {
                        try {
                            const t = JSON.parse(line) as Record<string, unknown>;
                            const tAttrs = (t.attrs as Record<string, unknown> | undefined) ?? {};
                            const toolName = typeof t.name === 'string' ? t.name : 'unknown';
                            const durMs = typeof t.dur === 'number' ? t.dur : 0;
                            const tStatus = typeof t.status === 'string' ? t.status : 'ok';
                            const tTs = typeof t.ts === 'number' ? t.ts : Date.now();
                            const argsStr = typeof tAttrs.args === 'string'
                                ? tAttrs.args
                                : (tAttrs.args != null ? JSON.stringify(tAttrs.args) : '');
                            const resultStr = typeof tAttrs.result === 'string'
                                ? tAttrs.result
                                : (tAttrs.result != null ? JSON.stringify(tAttrs.result) : '');
                            const group = this._toolInputGroup(toolName, argsStr);
                            toolRows.push(JSON.stringify({
                                ts: tTs, sid: sessionId, li: lineIndex, tool: toolName,
                                dur: durMs, status: tStatus,
                                inChars: argsStr.length, outChars: resultStr.length,
                                group, workspaceKey
                            }));
                            // The parent runSubagent tool_call (in main.jsonl) is the group anchor:
                            // fold its authoritative total duration/output into the sub-agent header
                            // instead of showing it as a flat timeline row (its nested requests/tools
                            // are shown inside the collapsible group).
                            if (!isChildLog && toolName === 'runSubagent') {
                                const spanId = typeof t.spanId === 'string' ? t.spanId : '';
                                const saId = this._turnSpanToSubagent.get(spanId);
                                // Finalize ONLY if the group already exists (it had in-window events).
                                // Don't create a phantom entry — otherwise the header count would
                                // exceed the number of groups actually shown in the timeline.
                                const existing = saId ? this._turnSubagents.get(saId) : undefined;
                                if (saId && existing) {
                                    const label = existing.label
                                        ?? (() => { try { const a = JSON.parse(argsStr) as { agentName?: string }; return a.agentName || 'sub-agent'; } catch { return 'sub-agent'; } })();
                                    this._turnSubagents.set(saId, {
                                        subagentId: saId, label,
                                        done: true,
                                        durMs, outputTokens: countTokens(resultStr), status: tStatus,
                                        startedTs: existing.startedTs ?? tTs,
                                    });
                                }
                                // Still fold into the turn tool aggregate (tool table), but do NOT
                                // push a flat timeline event — the group header represents it.
                                if (tTs >= this._lastSubmitTs) {
                                    this._foldToolAgg(this._turnToolAgg, toolName, durMs, tStatus, argsStr.length, resultStr.length, group);
                                }
                                continue;
                            }
                            if (tTs >= this._lastSubmitTs) {
                                this._foldToolAgg(this._turnToolAgg, toolName, durMs, tStatus, argsStr.length, resultStr.length, group);
                                if (isChildLog && subagentId) { this._ensureTurnSubagent(subagentId, subagentLabel, tTs); }
                                // Copilot truncates attrs.result (~5K chars) in the debug log, so
                                // resultStr undercounts big outputs. Reconcile against the lossless
                                // PostToolUse hook log (~/.askaway/tool-io.jsonl) when available.
                                const io = this._lookupToolIo(toolName, tTs, resultStr.length, argsStr.length);
                                // The hook exists only to RECOVER truncated big outputs, so it may
                                // only ever INCREASE a count — never replace a good debug value with
                                // an empty one. (Copilot's PostToolUse now delivers an empty
                                // tool_response, which would otherwise zero out every tool row.)
                                const debugInTok = countTokens(argsStr);
                                const debugOutTok = countTokens(resultStr);
                                this._pushTurnEvent({
                                    kind: 'tool',
                                    id: this._shortReqId(sessionId, lineIndex),
                                    ts: tTs,
                                    tool: toolName,
                                    status: tStatus,
                                    durMs,
                                    inputTokens: io ? Math.max(io.inTok, debugInTok) : debugInTok,
                                    outputTokens: io ? Math.max(io.outTok, debugOutTok) : debugOutTok,
                                    group,
                                    inputPreview: this._previewToolPayload(argsStr),
                                    outputPreview: this._previewToolPayload(resultStr) + (io && io.truncated ? `\n… [debug-log preview truncated; full output ≈ ${io.outTok.toLocaleString()} tok / ${io.outChars.toLocaleString()} chars]` : ''),
                                    subagent: subagentLabel,
                                    subagentId,
                                });
                            }
                        } catch { /* malformed tool_call — skip */ }
                        continue;
                    }

                    if (line.indexOf('llm_request') === -1) {
                        continue;
                    }

                    let parsed: Record<string, unknown>;
                    try {
                        parsed = JSON.parse(line) as Record<string, unknown>;
                    } catch {
                        // Ignore malformed lines and continue collecting from others.
                        continue;
                    }
                    const attrs = parsed.attrs as Record<string, unknown> | undefined;
                    if (!attrs || typeof attrs !== 'object') {
                        continue;
                    }

                    const inputTokens = typeof attrs.inputTokens === 'number' ? attrs.inputTokens : 0;
                    const outputTokens = typeof attrs.outputTokens === 'number' ? attrs.outputTokens : 0;
                    const cachedTokens = typeof attrs.cachedTokens === 'number' ? attrs.cachedTokens : 0;
                    const nanoAiu = typeof attrs.copilotUsageNanoAiu === 'number' ? attrs.copilotUsageNanoAiu : 0;
                    const model = typeof attrs.model === 'string' ? attrs.model : 'unknown';
                    const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
                    const debugName = typeof attrs.debugName === 'string' ? attrs.debugName : '';
                    const billableOrIdentified = model !== 'unknown' || inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || nanoAiu > 0;
                    if (!billableOrIdentified) {
                        continue;
                    }
                    // Track the newest request time (any session) for the live prompt-cache age clock.
                    if (ts > this._newestRequestTs) { this._newestRequestTs = ts; }

                    // NOTE: we deliberately do NOT skip `summarize*` (compaction) or retry calls —
                    // they consume real credits (copilotUsageNanoAiu), so counting them keeps
                    // turn/workspace totals consistent with Copilot's own billed figure.

                    // Current user turn: aggregate EVERY llm_request since the last submit.
                    // Accumulated into the persistent field so incremental reads don't reset it;
                    // _resetTurnMetrics() clears it at each turn boundary.
                    const isMiss = this._isCacheMiss(inputTokens, cachedTokens);
                    if (ts >= this._lastSubmitTs) {
                        if (isChildLog && subagentId) { this._ensureTurnSubagent(subagentId, subagentLabel, ts); }
                        this._lastRequestMetrics.requestCount += 1;
                        this._lastRequestMetrics.inputTokens += inputTokens;
                        this._lastRequestMetrics.outputTokens += outputTokens;
                        this._lastRequestMetrics.cachedTokens += cachedTokens;
                        this._lastRequestMetrics.nanoAiu += nanoAiu;
                        if (isMiss) { this._lastRequestMetrics.cacheMisses = (this._lastRequestMetrics.cacheMisses || 0) + 1; }
                        // Individual row for the "This turn" requests table (capped to bound memory).
                        const turnRequest: TurnRequest = {
                            id: this._shortReqId(sessionId, lineIndex),
                            ts, model, nanoAiu,
                            inputTokens, outputTokens, cachedTokens,
                            cacheHitPct: inputTokens > 0 ? Math.round(cachedTokens / inputTokens * 100) : 100,
                            kindTag: this._classifyRole(debugName),
                            subagent: subagentLabel,
                            subagentId,
                        };
                        this._turnRequests.push(turnRequest);
                        if (this._turnRequests.length > 500) { this._turnRequests.shift(); }
                        const reqEvent: TurnRequestEvent = { kind: 'request', ...turnRequest };
                        // Per-request input breakdown (system prompt + tool defs + history),
                        // powering the expandable detail row. Sidecar reads are cached.
                        const split = this._computeInputSplit(path.dirname(logFile), attrs, inputTokens, cachedTokens);
                        if (split) { reqEvent.split = split; }
                        // The first request of the turn is the user submission — Copilot may log
                        // its ts AFTER an early tool call it emitted, so pin it to the top.
                        if (!this._turnFirstReqSeen) { this._turnFirstReqSeen = true; reqEvent.firstOfTurn = true; }
                        this._pushTurnEvent(reqEvent);
                    }

                    // Stable dedup key: session + line index + content hash. Must be identical
                    // whether the line was read in a full scan or an incremental scan, otherwise
                    // the same request would be counted twice across restarts. Incremental reads
                    // only reach this hash for the handful of NEW lines per poll, so it's cheap.
                    const recordKey = `${sessionId}:${lineIndex}:${this._hashText(line)}`;
                    if (ledger.seen[recordKey] === true) {
                        // Upgrade legacy boolean entry to full SeenMeta.
                        ledger.seen[recordKey] = { ts, model, nano: nanoAiu, in: inputTokens, out: outputTokens, cached: cachedTokens };
                        ledger.requestCount += 1;
                        ledger.inputTokens += inputTokens;
                        ledger.outputTokens += outputTokens;
                        ledger.cachedTokens += cachedTokens;
                        ledger.nanoAiu += nanoAiu;
                        if (isMiss) { ledger.cacheMisses = (ledger.cacheMisses || 0) + 1; }
                        continue;
                    }
                    if (ledger.seen[recordKey]) {
                        continue;
                    }
                    ledger.seen[recordKey] = { ts, model, nano: nanoAiu, in: inputTokens, out: outputTokens, cached: cachedTokens };

                    // Workspace cumulative ledger.
                    ledger.requestCount += 1;
                    ledger.inputTokens += inputTokens;
                    ledger.outputTokens += outputTokens;
                    ledger.cachedTokens += cachedTokens;
                    ledger.nanoAiu += nanoAiu;
                    if (isMiss) { ledger.cacheMisses = (ledger.cacheMisses || 0) + 1; }

                    const cacheHitPct = inputTokens > 0 ? Math.round(cachedTokens / inputTokens * 100) : 100;

                    // Full per-request row for the master table (usage-requests jsonl).
                    rawRows.push(JSON.stringify({
                        ts,
                        id: this._shortReqId(sessionId, lineIndex),
                        dur: typeof parsed.dur === 'number' ? parsed.dur : null,
                        ttft: typeof attrs.ttft === 'number' ? attrs.ttft : null,
                        status: typeof parsed.status === 'string' ? parsed.status : null,
                        sid: sessionId,
                        li: lineIndex,
                        responseId: typeof attrs.responseId === 'string' ? attrs.responseId : null,
                        model,
                        role: debugName,
                        inputTokens,
                        outputTokens,
                        cachedTokens,
                        cacheHitPct,
                        nanoAiu,
                        workspaceKey
                    }));

                    // Parallel summary for neighbor (before/after) context on cache-miss records.
                    scanSummaries.push({
                        ts, sid: sessionId, li: lineIndex,
                        responseId: typeof attrs.responseId === 'string' ? attrs.responseId : null,
                        model, role: debugName,
                        inputTokens, cachedTokens, cacheHitPct, nanoAiu, miss: isMiss
                    });
                }
                // Read offset was already advanced (newline-aligned) when the bytes were read.
            }

            // Emit cache-miss records with before/after neighbor context. `window` prepends the
            // previous poll's tail so an early-in-batch spike still gets "before" context, and we
            // save the new tail for the next poll. Each record points back to the master table.
            if (scanSummaries.length > 0) {
                const window = [...this._recentReqs, ...scanSummaries];
                const base = this._recentReqs.length;
                for (let k = 0; k < scanSummaries.length; k++) {
                    if (!scanSummaries[k].miss) { continue; }
                    const idx = base + k;
                    const before = window.slice(Math.max(0, idx - 3), idx).map(this._neighbor);
                    const after = window.slice(idx + 1, idx + 4).map(this._neighbor);
                    const cur = scanSummaries[k];
                    void this._recordCacheMissSpike({
                        ts: cur.ts, model: cur.model, role: cur.role,
                        inputTokens: cur.inputTokens, cachedTokens: cur.cachedTokens,
                        cacheHitPct: cur.cacheHitPct, nanoAiu: cur.nanoAiu,
                        sid: cur.sid, responseId: cur.responseId,
                        workspaceKey,
                        // Pointer into the master table (append-only per-request log) for full context.
                        master: { file: `usage-requests/${workspaceKey}.jsonl`, sid: cur.sid, li: cur.li, responseId: cur.responseId },
                        before, after,
                    });
                }
                this._recentReqs = window.slice(-3);
            }

            ledger.updatedAt = Date.now();
            // _lastRequestMetrics is accumulated in-place during the scan above; no reassignment.
            await this._saveObservabilityLedger(ledger);
            await this._saveLogOffsets();
            if (rawRows.length > 0) {
                await this._appendRawRequestRows(workspaceKey, rawRows);
            }
            if (toolRows.length > 0) {
                await this._appendRawToolRows(workspaceKey, toolRows);
            }

            const workspaceScope: ScopeMetrics = {
                requestCount: ledger.requestCount,
                inputTokens: ledger.inputTokens,
                outputTokens: ledger.outputTokens,
                cachedTokens: ledger.cachedTokens,
                nanoAiu: ledger.nanoAiu,
                cacheMisses: ledger.cacheMisses || 0
            };
            const overall = await this._computeOverallMonth(currentMonth);
            const rtk = await this._collectRtkObservability();
            const gradleObs = await this._collectGradleObservability();
            const toolObs = await this._collectToolCallObservability();

            return {
                requestCount: workspaceScope.requestCount,
                inputTokens: workspaceScope.inputTokens,
                outputTokens: workspaceScope.outputTokens,
                cachedTokens: workspaceScope.cachedTokens,
                nanoAiu: workspaceScope.nanoAiu,
                lastRequest: this._deriveLastRequest(),
                workspace: workspaceScope,
                overall: overall.totals,
                perModel: overall.perModel,
                overallCompaction: overall.compaction,
                turnRequests: [...this._turnRequests],
                turnEvents: [...this._turnEvents],
                turnSubagents: Array.from(this._turnSubagents.values()),
                rtkCommandCount: rtk.commandCount,
                rtkSavedTokens: rtk.savedTokens,
                rtkSavingsPct: rtk.savingsPct,
                gradle: this._gradleWithSavings(gradleObs, toolObs),
                toolCalls: toolObs,
                lastRequestTs: this._newestRequestTs,
                source: `ledger:${logFiles.length} logs`,
                updatedAt: Date.now()
            };
        } catch {
            return emptyMetrics();
        }
    }

    /** Returns the aggregate of all llm_requests since the user's last submit (current turn). */
    private _deriveLastRequest(): ScopeMetrics {
        return { ...this._lastRequestMetrics };
    }

    /**
     * Current-month totals across all workspaces, read from ONE durable, additive "global"
     * month shard. The shard is fed by streaming EVERY workspace's Copilot debug log
     * (`main.jsonl`) through persisted per-file byte cursors — the debug logs are the
     * comprehensive, append-only source Copilot maintains, so this captures every request
     * (not just the ones AskAway happened to mirror). The shard only ever grows and is
     * persisted, so the credit figure can never drop even if debug logs later rotate away.
     */
    private async _computeOverallMonth(currentMonth: string): Promise<{ totals: ScopeMetrics; perModel: ModelBreakdown[]; compaction: { count: number; nanoAiu: number } }> {
        const now = Date.now();
        if (now - this._overallLastComputedAt < this._OVERALL_RECOMPUTE_MS) {
            return this._overallCache;
        }
        this._overallLastComputedAt = now;

        // Durable-but-safe month source. Each debug-log file's per-month sums are memoized by
        // size+mtime and persisted. A file is re-summed ONLY when it changes (whole-file re-sum →
        // no double count, self-healing); when Copilot ROTATES a file away we KEEP its last-known
        // sum so the month total never shrinks. This is corruption-proof: keyed by file path with
        // whole-file sums — no byte cursors, no additive drift, no monotonic latch.
        await this._loadMonthFileCache();
        let changed = false;
        let files: string[] = [];
        try { files = await this._findAllCopilotDebugLogFiles(); } catch { /* keep cached */ }
        for (const file of files) {
            try {
                const st = await fs.promises.stat(file);
                const cached = this._monthFileCache.get(file);
                if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) { continue; }
                const agg = await this._sumFileByMonth(file);
                this._monthFileCache.set(file, { size: st.size, mtime: st.mtimeMs, months: agg });
                changed = true;
            } catch {
                // Transient stat/read failure: keep the last-good cached entry (no flicker).
            }
        }

        // Prune entries with no activity in the current or previous month (bounds growth). This
        // keeps rotated-away files that still contribute to the visible window.
        const keep = new Set<string>([currentMonth, this._prevMonthKey(currentMonth)]);
        for (const [key, entry] of Array.from(this._monthFileCache.entries())) {
            let relevant = false;
            for (const mk of entry.months.keys()) { if (keep.has(mk)) { relevant = true; break; } }
            if (!relevant) { this._monthFileCache.delete(key); changed = true; }
        }

        // Aggregate the target month across ALL cached files (current + rotated-away).
        const totals = this._emptyScope();
        const perModelMap = new Map<string, ScopeMetrics>();
        const compaction = { count: 0, nanoAiu: 0 };
        for (const entry of this._monthFileCache.values()) {
            const bucket = entry.months.get(currentMonth);
            if (!bucket) { continue; }
            totals.requestCount += bucket.requestCount;
            totals.inputTokens += bucket.inputTokens;
            totals.outputTokens += bucket.outputTokens;
            totals.cachedTokens += bucket.cachedTokens;
            totals.nanoAiu += bucket.nanoAiu;
            totals.cacheMisses = (totals.cacheMisses || 0) + bucket.cacheMisses;
            compaction.count += bucket.compactionCount;
            compaction.nanoAiu += bucket.compactionNanoAiu;
            for (const [model, s] of bucket.perModel) {
                const acc = perModelMap.get(model) ?? this._emptyScope();
                acc.requestCount += s.requestCount;
                acc.inputTokens += s.inputTokens;
                acc.outputTokens += s.outputTokens;
                acc.cachedTokens += s.cachedTokens;
                acc.nanoAiu += s.nanoAiu;
                acc.cacheMisses = (acc.cacheMisses || 0) + (s.cacheMisses || 0);
                perModelMap.set(model, acc);
            }
        }
        if (changed) { void this._saveMonthFileCache(); }

        const perModel: ModelBreakdown[] = Array.from(perModelMap.entries())
            .map(([model, s]) => ({ model, ...s }))
            .sort((a, b) => b.nanoAiu - a.nanoAiu);

        this._overallCache = { totals, perModel, compaction };
        return this._overallCache;
    }

    /** Month key one month before the given `YYYY-MM`. */
    private _prevMonthKey(monthKey: string): string {
        const [y, m] = monthKey.split('-').map(Number);
        if (!y || !m) { return monthKey; }
        const d = new Date(y, m - 2, 1); // m is 1-based; m-2 = previous month 0-based
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    private _getMonthCachePath(): string {
        return path.join(this._context.globalStorageUri.fsPath, 'observability-monthcache.json');
    }

    /** Load the persisted per-file month sums once. Corrupt/missing → start empty (self-heals). */
    private async _loadMonthFileCache(): Promise<void> {
        if (this._monthCacheLoaded) { return; }
        this._monthCacheLoaded = true;
        try {
            const raw = await fs.promises.readFile(this._getMonthCachePath(), 'utf8');
            const parsed = JSON.parse(raw) as { files?: Record<string, { size: number; mtime: number; months: Record<string, unknown> }> };
            for (const [file, e] of Object.entries(parsed.files || {})) {
                const months = new Map<string, FileMonthAgg>();
                for (const [mk, b] of Object.entries(e.months || {})) {
                    const bb = b as Record<string, unknown>;
                    const perModel = new Map<string, ScopeMetrics>();
                    for (const [model, s] of Object.entries((bb.perModel as Record<string, unknown>) || {})) {
                        const ss = s as Record<string, number>;
                        perModel.set(model, { requestCount: ss.requestCount || 0, inputTokens: ss.inputTokens || 0, outputTokens: ss.outputTokens || 0, cachedTokens: ss.cachedTokens || 0, nanoAiu: ss.nanoAiu || 0, cacheMisses: ss.cacheMisses || 0 });
                    }
                    months.set(mk, {
                        requestCount: Number(bb.requestCount) || 0, inputTokens: Number(bb.inputTokens) || 0,
                        outputTokens: Number(bb.outputTokens) || 0, cachedTokens: Number(bb.cachedTokens) || 0,
                        nanoAiu: Number(bb.nanoAiu) || 0, cacheMisses: Number(bb.cacheMisses) || 0,
                        compactionCount: Number(bb.compactionCount) || 0, compactionNanoAiu: Number(bb.compactionNanoAiu) || 0,
                        perModel,
                    });
                }
                this._monthFileCache.set(file, { size: Number(e.size) || 0, mtime: Number(e.mtime) || 0, months });
            }
        } catch { /* none yet / corrupt → rebuild from logs */ }
    }

    private async _saveMonthFileCache(): Promise<void> {
        try {
            const files: Record<string, unknown> = {};
            for (const [file, e] of this._monthFileCache.entries()) {
                const months: Record<string, unknown> = {};
                for (const [mk, b] of e.months.entries()) {
                    const perModel: Record<string, unknown> = {};
                    for (const [model, s] of b.perModel.entries()) { perModel[model] = s; }
                    months[mk] = {
                        requestCount: b.requestCount, inputTokens: b.inputTokens, outputTokens: b.outputTokens,
                        cachedTokens: b.cachedTokens, nanoAiu: b.nanoAiu, cacheMisses: b.cacheMisses,
                        compactionCount: b.compactionCount, compactionNanoAiu: b.compactionNanoAiu, perModel,
                    };
                }
                files[file] = { size: e.size, mtime: e.mtime, months };
            }
            const p = this._getMonthCachePath();
            await fs.promises.mkdir(path.dirname(p), { recursive: true });
            await fs.promises.writeFile(p, JSON.stringify({ version: 1, files }));
        } catch { /* best-effort */ }
    }

    /** Read one debug-log file fully and bucket its llm_requests by month (stateless month recompute). */
    private async _sumFileByMonth(file: string): Promise<Map<string, FileMonthAgg>> {
        const out = new Map<string, FileMonthAgg>();
        let data: string;
        try { data = await fs.promises.readFile(file, 'utf8'); } catch { return out; }
        const empty = (): FileMonthAgg => ({
            requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0,
            cacheMisses: 0, compactionCount: 0, compactionNanoAiu: 0, perModel: new Map(),
        });
        for (const line of data.split('\n')) {
            if (!line || line.indexOf('llm_request') === -1) { continue; }
            let p: Record<string, unknown>;
            try { p = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
            const attrs = p.attrs as Record<string, unknown> | undefined;
            if (!attrs) { continue; }
            const ts = typeof p.ts === 'number' ? p.ts : 0;
            const inTok = typeof attrs.inputTokens === 'number' ? attrs.inputTokens : 0;
            const outTok = typeof attrs.outputTokens === 'number' ? attrs.outputTokens : 0;
            const cachedTok = typeof attrs.cachedTokens === 'number' ? attrs.cachedTokens : 0;
            const nano = typeof attrs.copilotUsageNanoAiu === 'number' ? attrs.copilotUsageNanoAiu : 0;
            const model = typeof attrs.model === 'string' ? attrs.model : 'unknown';
            const role = typeof attrs.debugName === 'string' ? attrs.debugName : '';
            if (model === 'unknown' && inTok === 0 && outTok === 0 && cachedTok === 0 && nano === 0) { continue; }
            const mk = this._getMonthKey(ts);
            let b = out.get(mk);
            if (!b) { b = empty(); out.set(mk, b); }
            b.requestCount += 1; b.inputTokens += inTok; b.outputTokens += outTok; b.cachedTokens += cachedTok; b.nanoAiu += nano;
            if (this._isCacheMiss(inTok, cachedTok)) { b.cacheMisses += 1; }
            if (this._classifyRole(role) === 'compaction') { b.compactionCount += 1; b.compactionNanoAiu += nano; }
            let pm = b.perModel.get(model);
            if (!pm) { pm = this._emptyScope(); b.perModel.set(model, pm); }
            pm.requestCount += 1; pm.inputTokens += inTok; pm.outputTokens += outTok; pm.cachedTokens += cachedTok; pm.nanoAiu += nano;
            if (this._isCacheMiss(inTok, cachedTok)) { pm.cacheMisses = (pm.cacheMisses || 0) + 1; }
        }
        return out;
    }

    /** Path of the persisted cursor file for the all-workspace global ingest. */
    private _getGlobalOffsetsPath(): string {
        return path.join(this._context.globalStorageUri.fsPath, 'observability-global-offsets.json');
    }

    private async _loadGlobalOffsets(): Promise<void> {
        if (this._globalOffsetsLoaded) { return; }
        this._globalOffsetsLoaded = true;
        try {
            const raw = await fs.promises.readFile(this._getGlobalOffsetsPath(), 'utf8');
            const parsed = JSON.parse(raw) as Record<string, { byteOffset: number; lineCount: number }>;
            for (const [file, off] of Object.entries(parsed)) {
                if (off && typeof off.byteOffset === 'number') {
                    this._globalLogOffsets.set(file, { byteOffset: off.byteOffset, lineCount: Number(off.lineCount) || 0 });
                }
            }
        } catch { /* none yet */ }
    }

    private async _saveGlobalOffsets(): Promise<void> {
        try {
            const obj: Record<string, { byteOffset: number; lineCount: number }> = {};
            for (const [file, off] of this._globalLogOffsets.entries()) { obj[file] = off; }
            const p = this._getGlobalOffsetsPath();
            await fs.promises.mkdir(path.dirname(p), { recursive: true });
            await fs.promises.writeFile(p, JSON.stringify(obj));
        } catch { /* best-effort */ }
    }

    /** Find EVERY workspace's Copilot debug-log main.jsonl under the shared workspaceStorage dir. */
    private async _findAllCopilotDebugLogFiles(): Promise<string[]> {
        // globalStorage/<ext> → ../.. → User/ ; sibling User/workspaceStorage holds all workspaces.
        const userDir = path.dirname(path.dirname(this._context.globalStorageUri.fsPath));
        const wsStorage = path.join(userDir, 'workspaceStorage');
        const out: string[] = [];
        let wsDirs: fs.Dirent[] = [];
        try { wsDirs = await fs.promises.readdir(wsStorage, { withFileTypes: true }); } catch { return out; }
        for (const ws of wsDirs) {
            if (!ws.isDirectory()) { continue; }
            const debugRoot = path.join(wsStorage, ws.name, 'GitHub.copilot-chat', 'debug-logs');
            let sessions: fs.Dirent[] = [];
            try { sessions = await fs.promises.readdir(debugRoot, { withFileTypes: true }); } catch { continue; }
            for (const s of sessions) {
                if (!s.isDirectory()) { continue; }
                // Include the parent main.jsonl AND every runSubagent-*.jsonl child session
                // so sub-agent credits are folded into the month total (see finder above).
                let entries: fs.Dirent[] = [];
                try { entries = await fs.promises.readdir(path.join(debugRoot, s.name), { withFileTypes: true }); } catch { continue; }
                for (const f of entries) {
                    if (f.isFile() && this._isRequestLogFile(f.name)) {
                        out.push(path.join(debugRoot, s.name, f.name));
                    }
                }
            }
        }
        return out;
    }

    /** A request is a "cache miss" when its cached portion is < 50% of its input tokens. */
    private _isCacheMiss(inputTokens: number, cachedTokens: number): boolean {
        return inputTokens > 0 && cachedTokens < inputTokens * 0.5;
    }

    /** Classify a request by its Copilot debugName. Compaction = summarizeConversationHistory*;
     *  retry = retry-*; everything else is a normal agent/model call. */
    private _classifyRole(role: string): 'compaction' | 'retry' | 'normal' {
        const r = (role || '').toLowerCase();
        if (r.indexOf('summarize') !== -1) { return 'compaction'; }
        if (r.indexOf('retry') !== -1) { return 'retry'; }
        return 'normal';
    }

    /** Fold one request's usage into the global month shard (dedup handled by caller). */
    private _foldReqIntoShard(shard: MonthShard, ts: number, model: string, inTok: number, outTok: number, cachedTok: number, nano: number, role?: string): void {
        const monthKey = this._getMonthKey(ts);
        const miss = this._isCacheMiss(inTok, cachedTok) ? 1 : 0;
        let bucket = shard.months[monthKey];
        if (!bucket) { bucket = { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0, cacheMisses: 0, perModel: {} }; shard.months[monthKey] = bucket; }
        bucket.requestCount += 1; bucket.inputTokens += inTok; bucket.outputTokens += outTok; bucket.cachedTokens += cachedTok; bucket.nanoAiu += nano;
        bucket.cacheMisses = (bucket.cacheMisses || 0) + miss;
        if (role && this._classifyRole(role) === 'compaction') {
            bucket.compactionCount = (bucket.compactionCount || 0) + 1;
            bucket.compactionNanoAiu = (bucket.compactionNanoAiu || 0) + nano;
        }
        let pm = bucket.perModel[model];
        if (!pm) { pm = { requestCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, nanoAiu: 0, cacheMisses: 0 }; bucket.perModel[model] = pm; }
        pm.requestCount += 1; pm.inputTokens += inTok; pm.outputTokens += outTok; pm.cachedTokens += cachedTok; pm.nanoAiu += nano;
        pm.cacheMisses = (pm.cacheMisses || 0) + miss;
    }

    /**
     * Incrementally fold new requests into the durable global month shard from every
     * workspace's Copilot debug log. IMPORTANT: each `llm_request` line is a DISTINCT billed
     * model call — an agent turn's iterations share one `responseId` but are separate charges
     * (verified: a 7-line responseId had nano 50, 6.6, 5.8, 4.4, 5.1, 4.5, 4.4). So we SUM every
     * line's `copilotUsageNanoAiu` with NO dedup; deduping by responseId undercounted ~5×.
     * Per-file persisted byte cursors count each line exactly once (even across restarts); the
     * shard is additive + persisted, so counts survive after debug logs rotate away.
     */
    private async _ingestGlobalDebugLogs(): Promise<MonthShard> {
        await this._loadGlobalOffsets();
        let shard = await this._loadMonthShard('_global');
        // One-time clean rebuild when the fold logic changes (here: removed the wrong
        // responseId dedup). Reset buckets + cursors and re-fold every line from offset 0.
        if (shard.foldVersion !== GLOBAL_FOLD_VERSION) {
            shard = { version: 1, workspaceKey: '_global', months: {}, rawOffset: 0, foldVersion: GLOBAL_FOLD_VERSION, updatedAt: 0 };
            this._globalLogOffsets.clear();
        }
        const MAX_PASS = 24 * 1024 * 1024;
        let dirty = false;

        for (const file of await this._findAllCopilotDebugLogFiles()) {
            const known = this._globalLogOffsets.get(file);
            const from = known?.byteOffset ?? 0;
            let size = 0;
            try { size = (await fs.promises.stat(file)).size; } catch { continue; }
            if (size <= from) { continue; }
            const fd = await fs.promises.open(file, 'r');
            try {
                const readLen = Math.min(size - from, MAX_PASS);
                const buf = Buffer.allocUnsafe(readLen);
                await fd.read(buf, 0, buf.length, from);
                const lastNl = buf.lastIndexOf(0x0a);
                if (lastNl < 0) { continue; }
                const text = buf.toString('utf8', 0, lastNl + 1);
                for (const line of text.split('\n')) {
                    if (!line || line.indexOf('llm_request') === -1) { continue; }
                    let parsed: Record<string, unknown>;
                    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
                    const attrs = parsed.attrs as Record<string, unknown> | undefined;
                    if (!attrs) { continue; }
                    // No summarize filter: compaction/retry calls ARE billed, so include every
                    // request with a copilotUsageNanoAiu to match Copilot's own credit figure.
                    this._foldReqIntoShard(
                        shard,
                        typeof parsed.ts === 'number' ? parsed.ts : 0,
                        typeof attrs.model === 'string' ? attrs.model : 'unknown',
                        typeof attrs.inputTokens === 'number' ? attrs.inputTokens : 0,
                        typeof attrs.outputTokens === 'number' ? attrs.outputTokens : 0,
                        typeof attrs.cachedTokens === 'number' ? attrs.cachedTokens : 0,
                        typeof attrs.copilotUsageNanoAiu === 'number' ? attrs.copilotUsageNanoAiu : 0,
                        typeof attrs.debugName === 'string' ? attrs.debugName : '',
                    );
                }
                const consumedLines = text.split('\n').length - 1;
                this._globalLogOffsets.set(file, { byteOffset: from + lastNl + 1, lineCount: (known?.lineCount ?? 0) + consumedLines });
                dirty = true;
            } finally {
                await fd.close();
            }
        }

        if (dirty) {
            shard.updatedAt = Date.now();
            await this._saveMonthShard(shard);
            await this._saveGlobalOffsets();
        }
        return shard;
    }

    private _getMonthShardPath(workspaceKey: string): string {
        return path.join(this._context.globalStorageUri.fsPath, 'observability-months', `${workspaceKey}.json`);
    }

    private async _loadMonthShard(workspaceKey: string): Promise<MonthShard> {
        try {
            const raw = await fs.promises.readFile(this._getMonthShardPath(workspaceKey), 'utf8');
            const parsed = JSON.parse(raw) as Partial<MonthShard>;
            // Migration: shards written before the durable-cursor rewrite have no `rawOffset`.
            // Their month buckets came from the old (buggy) path, so discard them and rebuild
            // cleanly from the append-only usage-requests log (rawOffset:0 → full re-fold).
            if (parsed.version === 1 && parsed.months && typeof parsed.months === 'object' && typeof parsed.rawOffset === 'number') {
                return {
                    version: 1, workspaceKey,
                    months: parsed.months as Record<string, MonthBucket>,
                    rawOffset: parsed.rawOffset,
                    seenIds: (parsed.seenIds && typeof parsed.seenIds === 'object') ? parsed.seenIds as Record<string, string> : undefined,
                    foldVersion: typeof parsed.foldVersion === 'number' ? parsed.foldVersion : undefined,
                    updatedAt: Number(parsed.updatedAt) || 0
                };
            }
        } catch {
            // Fresh shard.
        }
        return { version: 1, workspaceKey, months: {}, rawOffset: 0, updatedAt: 0 };
    }

    private async _saveMonthShard(shard: MonthShard): Promise<void> {
        const shardPath = this._getMonthShardPath(shard.workspaceKey);
        await fs.promises.mkdir(path.dirname(shardPath), { recursive: true });
        await fs.promises.writeFile(shardPath, JSON.stringify(shard));
    }

    private async _appendRawRequestRows(workspaceKey: string, rows: string[]): Promise<void> {
        const rawPath = path.join(this._context.globalStorageUri.fsPath, 'usage-requests', `${workspaceKey}.jsonl`);
        await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
        await fs.promises.appendFile(rawPath, rows.join('\n') + '\n');
    }

    /** Append-only durable log of every tool_call (built-in + custom). Never rewritten. */
    private async _appendRawToolRows(workspaceKey: string, rows: string[]): Promise<void> {
        const rawPath = path.join(this._context.globalStorageUri.fsPath, 'usage-tools', `${workspaceKey}.jsonl`);
        await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
        await fs.promises.appendFile(rawPath, rows.join('\n') + '\n');
    }

    private _getLogOffsetsPath(): string {
        return path.join(this._context.globalStorageUri.fsPath, 'observability-logoffsets.json');
    }

    /**
     * Load persisted per-debug-log read cursors ONCE. Persisting these across restarts is
     * what prevents the append-only usage logs from getting duplicate rows on restart
     * (an in-memory-only cursor would reset to 0 and re-append every historical line).
     */
    private async _loadLogOffsets(): Promise<void> {
        if (this._logOffsetsLoaded) { return; }
        this._logOffsetsLoaded = true;
        try {
            const raw = await fs.promises.readFile(this._getLogOffsetsPath(), 'utf8');
            const parsed = JSON.parse(raw) as Record<string, { byteOffset: number; lineCount: number }>;
            for (const [file, off] of Object.entries(parsed)) {
                if (off && typeof off.byteOffset === 'number' && typeof off.lineCount === 'number') {
                    this._logFileReadOffsets.set(file, { byteOffset: off.byteOffset, lineCount: off.lineCount });
                }
            }
        } catch { /* no persisted offsets yet */ }
    }

    private async _saveLogOffsets(): Promise<void> {
        try {
            const obj: Record<string, { byteOffset: number; lineCount: number }> = {};
            for (const [file, off] of this._logFileReadOffsets.entries()) { obj[file] = off; }
            const p = this._getLogOffsetsPath();
            await fs.promises.mkdir(path.dirname(p), { recursive: true });
            await fs.promises.writeFile(p, JSON.stringify(obj));
        } catch { /* best-effort */ }
    }

    /**
     * Derive a coarse input category for grouping tool calls, so a tool with thousands
     * of calls can be broken down by what it was doing (e.g. `run_in_terminal` by the
     * leading command word, `read_file` by extension). Never includes secrets/paths in full.
     */
    private _toolInputGroup(tool: string, argsStr: string): string {
        if (!argsStr) { return 'default'; }
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(argsStr) as Record<string, unknown>; } catch { return 'default'; }
        const cmd = typeof args.command === 'string' ? args.command : '';
        if (cmd) {
            const toks = cmd.trim().split(/\s+/);
            let head = toks[0] || 'cmd';
            if (head === 'rtk' && toks[1]) { head = `rtk ${toks[1]}`; }
            return head.slice(0, 24);
        }
        const fp = typeof args.filePath === 'string' ? args.filePath
            : typeof args.path === 'string' ? args.path : '';
        if (fp) {
            const ext = path.extname(fp);
            return ext ? `*${ext}` : 'file';
        }
        if (typeof args.query === 'string' || typeof args.pattern === 'string') { return 'query'; }
        if (typeof args.prompt === 'string' || typeof args.description === 'string') { return 'prompt'; }
        return 'default';
    }

    private _previewToolPayload(payload: string, maxLen = 180): string {
        if (!payload) { return ''; }
        let text = payload;
        try {
            const parsed = JSON.parse(payload) as unknown;
            text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        } catch { /* keep raw text */ }
        text = text.replace(/\s+/g, ' ').trim();
        return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
    }

    /** Exact composition of a request's input. System prompt + tool definitions are tokenized
     *  precisely (o200k); the remaining "conversation" (cached prior history + fresh delta) is
     *  derived as total - system - tools so the parts reconcile to the model total exactly.
     *  Sidecar tokenization is cached by path (content is stable once written). */
    private _computeInputSplit(
        sessionDir: string, attrs: Record<string, unknown>, totalInputTokens: number, cachedTokens: number
    ): TurnInputSplit | undefined {
        try {
            const sys = this._readSidecarStats(sessionDir, attrs.systemPromptFile, /<skill>/g);
            const tools = this._readSidecarStats(sessionDir, attrs.toolsFile);
            const inputMessages = typeof attrs.inputMessages === 'string' ? attrs.inputMessages : '';
            const userRequest = typeof attrs.userRequest === 'string' ? attrs.userRequest : '';
            const userTokens = countTokens(userRequest);
            const newMessageTokens = countTokens(inputMessages) + userTokens;
            let messageCount = 0;
            if (inputMessages) {
                try { const a = JSON.parse(inputMessages); if (Array.isArray(a)) { messageCount = a.length; } } catch { /* keep 0 */ }
            }
            if (!sys.tokens && !tools.tokens && !totalInputTokens) { return undefined; }
            // Conversation = everything that isn't the (exactly tokenized) system prompt or tools.
            // Derived from the authoritative reported total, so system+tools+conversation === total.
            const conversationTokens = Math.max(0, totalInputTokens - sys.tokens - tools.tokens);
            const cachedPriorTokens = Math.max(0, conversationTokens - newMessageTokens);
            return {
                systemTokens: sys.tokens, toolsTokens: tools.tokens,
                conversationTokens, newMessageTokens, cachedPriorTokens,
                userTokens, totalInputTokens,
                skillsCount: sys.count, toolsCount: tools.count,
                messageCount, cachedTokens: cachedTokens || 0,
                composition: this._analyzeSystemPromptComposition(sessionDir, attrs.systemPromptFile, sys.tokens),
                contributors: this._analyzeRequestContributors(inputMessages, sys.tokens, tools.tokens, totalInputTokens, cachedTokens || 0),
            };
        } catch {
            return undefined;
        }
    }

    /** Read a debug-log sidecar file once (cached): exactly tokenize its `.content` text and a
     *  count (regex matches if `countPattern` given, else JSON array length of the content). */
    private _readSidecarStats(sessionDir: string, name: unknown, countPattern?: RegExp): { tokens: number; count: number } {
        if (typeof name !== 'string' || !name) { return { tokens: 0, count: 0 }; }
        const p = path.join(sessionDir, name);
        const cached = this._splitFileCache.get(p);
        if (cached) { return cached; }
        const stats = { tokens: 0, count: 0 };
        try {
            const raw = fs.readFileSync(p, 'utf8');
            // Sidecars are { content: "<the actual text/JSON sent>" }.
            let content = raw;
            try { const outer = JSON.parse(raw); if (outer && typeof outer.content === 'string') { content = outer.content; } } catch { /* use raw */ }
            stats.tokens = countTokens(content);
            if (countPattern) {
                stats.count = (content.match(countPattern) || []).length;
            } else {
                try { const arr = JSON.parse(content); if (Array.isArray(arr)) { stats.count = arr.length; } } catch { /* not a JSON array */ }
            }
        } catch { /* unreadable — zeros */ }
        if (this._splitFileCache.size > 200) { this._splitFileCache.clear(); }
        this._splitFileCache.set(p, stats);
        return stats;
    }

    /**
     * Effective prompt-cache activity time = max of the newest llm_request ts (from debug
     * logs) and the event-driven sentinel `~/.askaway/cache-activity-ts` written by the
     * cache-timer hook on UserPromptSubmit/PostToolUse/Stop. The hook resets the clock the
     * instant you submit (no 2s poll lag) and marks each model round precisely.
     */
    private _effectiveCacheActivityTs(): number {
        let sentinel = 0;
        try {
            const raw = fs.readFileSync(path.join(os.homedir(), '.askaway', 'cache-activity-ts'), 'utf8');
            sentinel = parseInt(raw.trim(), 10) || 0;
        } catch { /* sentinel absent until the first hook fires */ }
        return Math.max(this._newestRequestTs, sentinel);
    }

    /** Reverse-engineer the assembled system prompt into its source pieces. Copilot wraps every
     *  included instruction file in `<attachment filePath="…">…</attachment>` and its skill/agent
     *  catalogs in `<skills>`/`<agents>` blocks, so we attribute those precisely and treat the
     *  remaining tokens as Copilot's own (closed) base + framing text. Cached by sidecar path. */
    private _analyzeSystemPromptComposition(
        sessionDir: string, name: unknown, systemTokens: number
    ): SystemPromptComposition | undefined {
        if (typeof name !== 'string' || !name || !systemTokens) { return undefined; }
        const p = path.join(sessionDir, name);
        const cacheKey = `${p}:${systemTokens}`;
        const hit = this._promptCompositionCache.get(cacheKey);
        if (hit) { return hit; }
        let text = '';
        try {
            const raw = fs.readFileSync(p, 'utf8');
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    text = parsed.map((x) => (x && typeof x.content === 'string') ? x.content : '').join('\n');
                } else if (parsed && typeof parsed.content === 'string') {
                    text = parsed.content;
                } else { text = raw; }
            } catch { text = raw; }
        } catch { return undefined; }
        if (!text) { return undefined; }
        // Sidecars can be double-JSON-encoded, so unescape quotes/newlines before matching.
        const norm = text.replace(/\\"/g, '"').replace(/\\n/g, '\n');
        const segments: (SystemPromptSegment & { order: number })[] = [];
        const consumedRanges: { start: number; end: number }[] = [];
        const attRe = /<attachment\s+filePath="([^"]+)"(?:\s+workspaceFolder="([^"]+)")?>([\s\S]*?)<\/attachment>/g;
        let m: RegExpExecArray | null;
        while ((m = attRe.exec(norm)) !== null) {
            const filePath = m[1];
            consumedRanges.push({ start: m.index, end: m.index + m[0].length });
            segments.push({
                label: filePath.split('/').pop() || filePath,
                kind: 'attachment', path: filePath,
                workspaceFolder: m[2] || undefined,
                tokens: countTokens(m[3] || ''), order: m.index,
            });
        }
        // Custom instruction files (applyTo-based): <instruction><file>PATH</file>…</instruction>.
        const insRe = /<instruction>\s*<file>([^<]+)<\/file>([\s\S]*?)<\/instruction>/g;
        while ((m = insRe.exec(norm)) !== null) {
            const filePath = m[1].trim();
            consumedRanges.push({ start: m.index, end: m.index + m[0].length });
            segments.push({
                label: filePath.split('/').pop() || filePath,
                kind: 'instruction', path: filePath,
                tokens: countTokens(m[0]), order: m.index,
            });
        }
        // Skills catalog — itemize each skill (name + SKILL.md link + tokens).
        const sk = /<skills>([\s\S]*?)<\/skills>/.exec(norm);
        if (sk) {
            const inner = sk[1];
            const children: SystemPromptChild[] = [];
            const skRe = /<skill>([\s\S]*?)<\/skill>/g;
            let s: RegExpExecArray | null;
            while ((s = skRe.exec(inner)) !== null) {
                const block = s[1];
                const nm = /<name>([^<]*)<\/name>/.exec(block);
                const fl = /<file>([^<]*)<\/file>/.exec(block);
                children.push({
                    label: (nm && nm[1].trim()) || 'skill',
                    path: fl ? fl[1].trim() : undefined,
                    tokens: countTokens(s[0]),
                });
            }
            segments.push({ label: `Skills (${children.length})`, kind: 'skills', tokens: countTokens(inner), order: sk.index, children });
        }
        // Agents catalog — itemize each agent (name + tokens; no file to link).
        const ag = /<agents>([\s\S]*?)<\/agents>/.exec(norm);
        if (ag) {
            const inner = ag[1];
            const children: SystemPromptChild[] = [];
            const agRe = /<agent>([\s\S]*?)<\/agent>/g;
            let a: RegExpExecArray | null;
            while ((a = agRe.exec(inner)) !== null) {
                const nm = /<name>([^<]*)<\/name>/.exec(a[1]);
                children.push({ label: (nm && nm[1].trim()) || 'agent', tokens: countTokens(a[0]) });
            }
            segments.push({ label: `Agents (${children.length})`, kind: 'agents', tokens: countTokens(inner), order: ag.index, children });
        }
        // Itemize the remaining outermost tagged sections (agent-mode instructions + Copilot
        // framing) instead of dumping them all into "base". These are the biggest source of
        // apparent inaccuracy: e.g. a custom agent's <modeInstructions> can be ~20% of the whole
        // prompt yet was previously hidden inside the opaque base bucket. Skills/agents live
        // nested inside an <instructions> block, so subtract their (already-attributed) tokens
        // from any section that contains them to avoid double counting.
        const FRIENDLY: Record<string, string> = {
            modeInstructions: 'Agent mode instructions',
            instructions: 'Copilot instructions framing',
            toolUseInstructions: 'Tool-use instructions',
            memoryInstructions: 'Memory instructions',
            outputFormatting: 'Output formatting',
            notebookInstructions: 'Notebook instructions',
            communicationStyle: 'Communication style',
            operationalSafety: 'Operational safety',
            securityRequirements: 'Security requirements',
            implementationDiscipline: 'Implementation discipline',
            taskTracking: 'Task tracking',
            parallelizationStrategy: 'Parallelization strategy',
        };
        const alreadyHandled = new Set(['attachment', 'instruction', 'skills', 'agents']);
        const nestedAttributed: { start: number; end: number; tokens: number }[] = [];
        if (sk) { nestedAttributed.push({ start: sk.index, end: sk.index + sk[0].length, tokens: countTokens(sk[0]) }); }
        if (ag) { nestedAttributed.push({ start: ag.index, end: ag.index + ag[0].length, tokens: countTokens(ag[0]) }); }
        const secRe = /<([a-zA-Z_][\w]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
        while ((m = secRe.exec(norm)) !== null) {
            const tag = m[1];
            if (alreadyHandled.has(tag)) { continue; }
            const start = m.index;
            const end = m.index + m[0].length;
            // Skip tags that live inside an already-attributed attachment/instruction block.
            if (consumedRanges.some((r) => start >= r.start && end <= r.end)) { continue; }
            let tok = countTokens(m[0]);
            for (const n of nestedAttributed) {
                if (n.start >= start && n.end <= end) { tok -= n.tokens; }
            }
            if (tok <= 0) { continue; }
            segments.push({
                label: FRIENDLY[tag] || tag,
                kind: tag === 'modeInstructions' ? 'mode' : 'framing',
                tokens: tok, order: start,
            });
        }
        segments.sort((a, b) => a.order - b.order);
        const attributed = segments.reduce((s, x) => s + x.tokens, 0);
        const comp: SystemPromptComposition = {
            totalTokens: systemTokens,
            baseTokens: Math.max(0, systemTokens - attributed),
            segments: segments.map(({ order, ...s }) => s),
        };
        if (this._promptCompositionCache.size > 200) { this._promptCompositionCache.clear(); }
        this._promptCompositionCache.set(cacheKey, comp);
        return comp;
    }

    /** Break the FULL request into what actually contributed: system prompt, tool defs, and the
     *  entire conversation split into user memory, attached files, context framing, tool results
     *  and dialogue. Parsed from the request's own `inputMessages` (the complete messages array),
     *  so it reflects THAT request literally — not a guess. Cached by content signature since the
     *  input is large (a full conversation can be hundreds of KB). */
    private _analyzeRequestContributors(
        inputMessages: string, systemTokens: number, toolsTokens: number,
        totalInputTokens: number, cachedTokens: number
    ): RequestContributors | undefined {
        if (!inputMessages || !totalInputTokens) { return undefined; }
        const cacheKey = `${inputMessages.length}:${systemTokens}:${toolsTokens}:${totalInputTokens}`;
        const hit = this._contributorCache.get(cacheKey);
        if (hit) { return hit; }
        let arr: unknown;
        try { arr = JSON.parse(inputMessages); } catch { return undefined; }
        if (!Array.isArray(arr)) { return undefined; }
        // Separate each message PART by its real shape. Copilot logs the messages array with
        // distinct part types — a plain `content` string is ONLY present on `text`/`reasoning`
        // parts. Tool traffic uses different fields with NO `content`:
        //   - `tool_call`          → the model's tool invocation; payload in `p.arguments`
        //   - `tool_call_response` → the tool's OUTPUT (role:user); payload in `p.response`
        //     (an array of `{type:'text',text}` parts)
        //   - `reasoning`          → the model's hidden chain-of-thought; `p.content`
        // Older/other shapes (`tool_result`, role `tool`) are handled as a fallback. Reading
        // only `p.content` (the previous behaviour) dropped every tool_call/tool_call_response
        // to 0, so their (usually dominant) tokens were swept into the dialogue residual and
        // mislabeled "Conversation (user + assistant)".
        let toolResultTokens = 0;   // tool OUTPUTS (read_file/terminal/etc. responses)
        let toolCallTokens = 0;     // the model's tool-call ARGUMENTS
        let reasoningTokens = 0;    // assistant chain-of-thought
        const texts: string[] = []; // genuine user + assistant TEXT only
        const toolNameById = new Map<string, string>();          // tool_call id → tool name
        const toolResultByName = new Map<string, { calls: number; tokens: number }>(); // per-tool output weight
        const toolResponseText = (r: unknown): string => {
            if (Array.isArray(r)) {
                return (r as Array<Record<string, unknown>>).map(x =>
                    x && typeof x.text === 'string' ? x.text
                        : (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
            }
            return typeof r === 'string' ? r : (r ? JSON.stringify(r) : '');
        };
        const addToolResult = (name: string, tokens: number): void => {
            toolResultTokens += tokens;
            const e = toolResultByName.get(name) || { calls: 0, tokens: 0 };
            e.calls += 1; e.tokens += tokens;
            toolResultByName.set(name, e);
        };
        for (const msg of arr as Array<Record<string, unknown>>) {
            const role = typeof msg.role === 'string' ? msg.role : '';
            const parts = Array.isArray(msg.parts) ? msg.parts
                : (typeof msg.content === 'string' ? [{ type: 'text', content: msg.content }] : []);
            for (const p of parts as Array<Record<string, unknown>>) {
                const t = typeof p.type === 'string' ? p.type : '';
                const c = typeof p.content === 'string' ? p.content : '';
                if (t === 'tool_call') {
                    // Assistant's tool invocation — precedes its response, so record the name now.
                    if (typeof p.id === 'string' && typeof p.name === 'string') { toolNameById.set(p.id, p.name); }
                    toolCallTokens += countTokens(JSON.stringify(p.arguments ?? {}));
                } else if (t === 'tool_call_response') {
                    const nm = (typeof p.id === 'string' && toolNameById.get(p.id)) || 'tool';
                    addToolResult(nm, countTokens(toolResponseText(p.response)));
                } else if (t === 'tool_result' || role === 'tool') {
                    addToolResult('tool', countTokens(c || toolResponseText(p.response)));
                } else if (t === 'reasoning') { reasoningTokens += countTokens(c); }
                else if (c) { texts.push(c); }
            }
        }
        const joined = texts.join('\n');
        // User memory blocks (+ the `## <file>` headers name the contributing memory files).
        let memoryTokens = 0;
        const memoryFiles = new Set<string>();
        let m: RegExpExecArray | null;
        const memRe = /<userMemory>([\s\S]*?)<\/userMemory>/g;
        while ((m = memRe.exec(joined)) !== null) {
            memoryTokens += countTokens(m[1]);
            // User memory injects one `## <file>.md` header per contributing memory file; inner
            // sub-sections are also `##`, so match only headers that are a bare `.md` filename.
            const hdrRe = /^##\s+([^\s#][^\n]*?\.md)\s*$/gm;
            let h: RegExpExecArray | null;
            while ((h = hdrRe.exec(m[1])) !== null) { memoryFiles.add(h[1].trim()); }
        }
        // Attached files (deduped by path, tokens summed across occurrences).
        const fileTokens = new Map<string, number>();
        const attRe = /<attachment\s+filePath="([^"]+)"(?:\s+workspaceFolder="[^"]+")?>([\s\S]*?)<\/attachment>/g;
        while ((m = attRe.exec(joined)) !== null) {
            fileTokens.set(m[1], (fileTokens.get(m[1]) || 0) + countTokens(m[2]));
        }
        const attachmentTokens = Array.from(fileTokens.values()).reduce((s, v) => s + v, 0);
        // Context/framing blocks injected around the user's turns.
        let contextTokens = 0;
        for (const tag of ['environment_info', 'workspace_info', 'context', 'reminderInstructions', 'userRequest']) {
            const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
            while ((m = re.exec(joined)) !== null) { contextTokens += countTokens(m[0]); }
        }
        // Plain dialogue = genuine user/assistant TEXT minus the framing blocks that live inside
        // it (memory/attachments/context). Measured directly — NOT a residual — so tool outputs,
        // tool-call arguments and reasoning are no longer mislabeled as conversation.
        const textTotal = countTokens(joined);
        const dialogueTokens = Math.max(0, textTotal - memoryTokens - attachmentTokens - contextTokens);
        const items: RequestContributor[] = [];
        if (systemTokens > 0) { items.push({ label: 'System prompt', kind: 'system', tokens: systemTokens }); }
        if (toolsTokens > 0) { items.push({ label: 'Tool definitions', kind: 'tools', tokens: toolsTokens }); }
        if (memoryTokens > 0) { items.push({ label: `User memory (${memoryFiles.size} file${memoryFiles.size === 1 ? '' : 's'})`, kind: 'memory', tokens: memoryTokens, count: memoryFiles.size }); }
        for (const [p, t] of Array.from(fileTokens.entries())) {
            items.push({ label: p.split('/').pop() || p, kind: 'attachment', tokens: t, path: p });
        }
        if (contextTokens > 0) { items.push({ label: 'Context / environment framing', kind: 'context', tokens: contextTokens }); }
        // Tool OUTPUTS broken down per tool (descending) so the heavy hitter is obvious — e.g. a
        // single `memory view` of a large file can dwarf everything. Each line shows call count.
        for (const [name, e] of Array.from(toolResultByName.entries()).sort((a, b) => b[1].tokens - a[1].tokens)) {
            items.push({ label: `Tool output: ${name} (${e.calls} call${e.calls === 1 ? '' : 's'})`, kind: 'toolResult', tokens: e.tokens, count: e.calls });
        }
        if (toolCallTokens > 0) { items.push({ label: 'Tool calls (arguments)', kind: 'toolCall', tokens: toolCallTokens }); }
        if (reasoningTokens > 0) { items.push({ label: 'Assistant reasoning', kind: 'reasoning', tokens: reasoningTokens }); }
        if (dialogueTokens > 0) { items.push({ label: 'Conversation (user + assistant text)', kind: 'dialogue', tokens: dialogueTokens }); }
        items.sort((a, b) => b.tokens - a.tokens);
        const result: RequestContributors = {
            totalInputTokens, cachedTokens,
            accountedTokens: items.reduce((s, x) => s + x.tokens, 0),
            items, files: Array.from(fileTokens.keys()), memoryFiles: Array.from(memoryFiles),
        };
        if (this._contributorCache.size > 200) { this._contributorCache.clear(); }
        this._contributorCache.set(cacheKey, result);
        return result;
    }

    private _pushTurnEvent(event: TurnEvent): void {
        this._turnEvents.push(event);
        // Pin the turn's initiating request to the top (sort key = just before the turn start),
        // since Copilot may timestamp it after an early tool call it spawned.
        const key = (e: TurnEvent): number =>
            (e.kind === 'request' && (e as TurnRequestEvent).firstOfTurn) ? this._lastSubmitTs - 1 : e.ts;
        this._turnEvents.sort((a, b) => key(a) === key(b) ? a.id.localeCompare(b.id) : key(a) - key(b));
        if (this._turnEvents.length > 1000) { this._turnEvents.splice(0, this._turnEvents.length - 1000); }
    }

    /** Fold one tool call into an aggregate map (used for both turn + durable shard). */
    private _foldToolAgg(
        map: Map<string, ToolAggregate>, tool: string, durMs: number,
        status: string, inChars: number, outChars: number, group: string
    ): void {
        let a = map.get(tool);
        if (!a) {
            a = { calls: 0, errors: 0, totalDurMs: 0, minDurMs: Number.POSITIVE_INFINITY, maxDurMs: 0, outputChars: 0, inputChars: 0, byGroup: {} };
            map.set(tool, a);
        }
        a.calls += 1;
        if (status && status !== 'ok' && status !== 'success') { a.errors += 1; }
        a.totalDurMs += durMs;
        if (durMs < a.minDurMs) { a.minDurMs = durMs; }
        if (durMs > a.maxDurMs) { a.maxDurMs = durMs; }
        a.outputChars += outChars;
        a.inputChars += inChars;
        a.byGroup[group] = (a.byGroup[group] || 0) + 1;
    }

    private _getToolShardPath(workspaceKey: string): string {
        return path.join(this._context.globalStorageUri.fsPath, 'observability-tools', `${workspaceKey}.json`);
    }

    private async _loadToolShard(workspaceKey: string): Promise<ToolShard> {
        try {
            const raw = await fs.promises.readFile(this._getToolShardPath(workspaceKey), 'utf8');
            const parsed = JSON.parse(raw) as Partial<ToolShard>;
            if (parsed.version === 1 && parsed.months && typeof parsed.rawOffset === 'number') {
                return { version: 1, workspaceKey, rawOffset: parsed.rawOffset, months: parsed.months as Record<string, ToolMonthBucket>, updatedAt: Number(parsed.updatedAt) || 0 };
            }
        } catch { /* fresh */ }
        return { version: 1, workspaceKey, rawOffset: 0, months: {}, updatedAt: 0 };
    }

    private async _saveToolShard(shard: ToolShard): Promise<void> {
        const p = this._getToolShardPath(shard.workspaceKey);
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, JSON.stringify(shard));
    }

    /**
     * Incrementally fold new rows of a workspace's append-only usage-tools jsonl into its
     * durable tool shard via a persisted byte cursor. Additive only; never drops data.
     */
    private async _ingestToolsIntoShard(workspaceKey: string): Promise<ToolShard> {
        const shard = await this._loadToolShard(workspaceKey);
        const rawPath = path.join(this._context.globalStorageUri.fsPath, 'usage-tools', `${workspaceKey}.jsonl`);
        let size = 0;
        try { size = (await fs.promises.stat(rawPath)).size; } catch { return shard; }
        if (size <= shard.rawOffset) { return shard; }
        const fd = await fs.promises.open(rawPath, 'r');
        let consumed = shard.rawOffset;
        try {
            const buf = Buffer.allocUnsafe(size - shard.rawOffset);
            await fd.read(buf, 0, buf.length, shard.rawOffset);
            const lastNl = buf.lastIndexOf(0x0a);
            if (lastNl < 0) { return shard; }
            const text = buf.toString('utf8', 0, lastNl + 1);
            consumed = shard.rawOffset + lastNl + 1;
            for (const line of text.split('\n')) {
                if (!line) { continue; }
                let row: Record<string, unknown>;
                try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
                const ts = typeof row.ts === 'number' ? row.ts : 0;
                const monthKey = this._getMonthKey(ts);
                const tool = typeof row.tool === 'string' ? row.tool : 'unknown';
                const durMs = Number(row.dur) || 0;
                const status = typeof row.status === 'string' ? row.status : 'ok';
                const inChars = Number(row.inChars) || 0;
                const outChars = Number(row.outChars) || 0;
                const group = typeof row.group === 'string' ? row.group : 'default';
                let bucket = shard.months[monthKey];
                if (!bucket) { bucket = { tools: {} }; shard.months[monthKey] = bucket; }
                const map = new Map<string, ToolAggregate>();
                if (bucket.tools[tool]) { map.set(tool, bucket.tools[tool]); }
                this._foldToolAgg(map, tool, durMs, status, inChars, outChars, group);
                bucket.tools[tool] = map.get(tool)!;
            }
        } finally {
            await fd.close();
        }
        shard.rawOffset = consumed;
        shard.updatedAt = Date.now();
        await this._saveToolShard(shard);
        return shard;
    }

    private _getObservabilityWorkspaceKey(): string {
        const folders = (vscode.workspace.workspaceFolders ?? [])
            .map(folder => folder.uri.fsPath)
            .sort()
            .join('|');
        const storage = this._context.storageUri?.fsPath ?? '';
        return this._hashText(folders || storage || 'no-workspace');
    }

    private _getObservabilityLedgerPath(workspaceKey: string): string {
        return path.join(this._context.globalStorageUri.fsPath, 'observability-ledgers', `${workspaceKey}.json`);
    }

    private async _loadObservabilityLedger(workspaceKey: string): Promise<ObservabilityLedger> {
        const ledgerPath = this._getObservabilityLedgerPath(workspaceKey);
        try {
            const raw = await fs.promises.readFile(ledgerPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<ObservabilityLedger>;
            if (parsed.version === 1 && parsed.workspaceKey === workspaceKey && parsed.seen && typeof parsed.seen === 'object') {
                const seen = parsed.seen as Record<string, SeenMeta | true>;

                // Migration: drop transient ":new" keys written by a prior build. Those used a
                // different key shape than the stable content-hash keys, so the same request could
                // be stored under both — inflating totals ~2x. Removing them lets the next full
                // scan (offset resets on restart) re-add each request once under its hash key.
                for (const key of Object.keys(seen)) {
                    if (key.endsWith(':new')) {
                        delete seen[key];
                    }
                }

                // Recompute cumulative totals from seen metadata so they stay consistent
                // even after a past duplication bug inflated the on-disk counts.
                let requestCount = 0, inputTokens = 0, outputTokens = 0, cachedTokens = 0, nanoAiu = 0, cacheMisses = 0;
                for (const meta of Object.values(seen)) {
                    if (meta === true || typeof meta !== 'object') {
                        continue; // legacy entry — counted once, no metadata
                    }
                    requestCount += 1;
                    inputTokens += meta.in || 0;
                    outputTokens += meta.out || 0;
                    cachedTokens += meta.cached || 0;
                    nanoAiu += meta.nano || 0;
                    if (this._isCacheMiss(meta.in || 0, meta.cached || 0)) { cacheMisses += 1; }
                }

                return {
                    version: 1,
                    workspaceKey,
                    requestCount,
                    inputTokens,
                    outputTokens,
                    cachedTokens,
                    nanoAiu,
                    cacheMisses,
                    seen,
                    updatedAt: Number(parsed.updatedAt) || 0
                };
            }
        } catch {
            // Start a fresh ledger when no prior ledger exists or the file is unreadable.
        }

        return {
            version: 1,
            workspaceKey,
            requestCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            nanoAiu: 0,
            cacheMisses: 0,
            seen: {},
            updatedAt: 0
        };
    }

    private async _saveObservabilityLedger(ledger: ObservabilityLedger): Promise<void> {
        const ledgerPath = this._getObservabilityLedgerPath(ledger.workspaceKey);
        await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true });
        await fs.promises.writeFile(ledgerPath, JSON.stringify(ledger));
    }

    private _hashText(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }

    /** Append a cache-miss spike record to ~/.askaway/cache-miss-spikes.jsonl for offline analysis. */
    private async _recordCacheMissSpike(record: Record<string, unknown>): Promise<void> {
        try {
            const dir = path.join(os.homedir(), '.askaway');
            await fs.promises.mkdir(dir, { recursive: true });
            const file = path.join(dir, 'cache-miss-spikes.jsonl');
            await fs.promises.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
        } catch {
            // Best-effort — never let spike logging affect observability.
        }
    }

    private async _collectRtkObservability(): Promise<{ commandCount: number; savedTokens: number; savingsPct: number }> {
        const sentinelPath = path.join(os.homedir(), '.askaway-rtk-enabled');
        if (!fs.existsSync(sentinelPath)) {
            return { commandCount: 0, savedTokens: 0, savingsPct: 0 };
        }

        const rtkBinary = this._findRtkBinary();
        if (!rtkBinary) {
            return { commandCount: 0, savedTokens: 0, savingsPct: 0 };
        }

        try {
            const result = await execFileAsync(rtkBinary, ['gain', '--daily', '--format', 'json'], {
                timeout: 2000,
                maxBuffer: 1024 * 1024
            });
            const parsed = JSON.parse(result.stdout || '{}') as {
                summary?: { total_commands?: number; total_saved?: number; avg_savings_pct?: number };
            };
            const summary = parsed.summary ?? {};
            return {
                commandCount: typeof summary.total_commands === 'number' ? summary.total_commands : 0,
                savedTokens: typeof summary.total_saved === 'number' ? summary.total_saved : 0,
                savingsPct: typeof summary.avg_savings_pct === 'number' ? summary.avg_savings_pct : 0
            };
        } catch {
            return { commandCount: 0, savedTokens: 0, savingsPct: 0 };
        }
    }

    /** Read the last N lines of a JSONL file (best-effort, bounded memory). */
    private async _tailJsonl(file: string, maxLines: number): Promise<Record<string, unknown>[]> {
        try {
            const content = await fs.promises.readFile(file, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines;
            const out: Record<string, unknown>[] = [];
            for (const l of slice) {
                try { out.push(JSON.parse(l)); } catch { /* skip malformed */ }
            }
            return out;
        } catch {
            return [];
        }
    }

    /**
     * Aggregate the gradle "success story" log (~/.askaway/gradle-runs.jsonl):
     * how many runs were auto-optimized and how much work the cache/daemon avoided.
     */
    private async _collectGradleObservability(): Promise<{ runs: number; optimizedRuns: number; tasksAvoided: number; configCacheReuses: number; rawOutputTokens: number }> {
        const rows = await this._tailJsonl(path.join(os.homedir(), '.askaway', 'gradle-runs.jsonl'), 5000);
        let runs = 0, optimizedRuns = 0, tasksAvoided = 0, configCacheReuses = 0, rawOutputTokens = 0;
        for (const r of rows) {
            runs += 1;
            if (Array.isArray(r.optimizations) && r.optimizations.length > 0) { optimizedRuns += 1; }
            tasksAvoided += (Number(r.tasksUpToDate) || 0) + (Number(r.tasksFromCache) || 0);
            if (r.configCacheReused === true) { configCacheReuses += 1; }
            rawOutputTokens += Number(r.rawOutputTokens) || 0;
        }
        return { runs, optimizedRuns, tasksAvoided, configCacheReuses, rawOutputTokens };
    }

    /**
     * Combine the gradle-run aggregate with the tool-call log to estimate tokens
     * saved by the async gradle design. Baseline: if the agent had run gradle in a
     * plain terminal and read the WHOLE output, it would cost `rawOutputTokens`.
     * Actual: the agent only received compact status + bounded/paginated logs,
     * which is exactly what the gradle tool-call log records. Saved = baseline - actual.
     */
    private _gradleWithSavings(
        gradleObs: { runs: number; optimizedRuns: number; tasksAvoided: number; configCacheReuses: number; rawOutputTokens: number },
        toolObs: { byTool: Array<{ tool: string; outputTokens: number }> }
    ): ObservabilityMetrics['gradle'] {
        const gradleSent = toolObs.byTool.find(t => t.tool === 'gradle')?.outputTokens ?? 0;
        const savedTokens = Math.max(0, gradleObs.rawOutputTokens - gradleSent);
        return {
            runs: gradleObs.runs,
            optimizedRuns: gradleObs.optimizedRuns,
            tasksAvoided: gradleObs.tasksAvoided,
            configCacheReuses: gradleObs.configCacheReuses,
            savedTokens,
        };
    }

    /**
     * Aggregate the tool-call log (~/.askaway/tool-calls.jsonl): per-tool call
     * counts and approximate output token totals, to spot where output tokens go.
     */
    /**
     * Build the tool-call telemetry payload. The MONTH scope is summed from the durable,
     * additive per-workspace tool shards (fed by the append-only usage-tools logs); the
     * TURN scope is the in-memory accumulator since the last user submit. Reports per-tool
     * count, avg/min/max duration (to spot tools that may blow the ~5 min cache TTL),
     * output tokens (≈chars/4), error count, and top input groups.
     */
    private async _collectToolCallObservability(): Promise<ToolCallMetrics> {
        const currentMonth = this._getMonthKey(Date.now());
        const monthAgg = new Map<string, ToolAggregate>();

        // Ingest every workspace's append-only usage-tools log into its durable shard, then
        // sum the current month across all shards.
        const toolsDir = path.join(this._context.globalStorageUri.fsPath, 'usage-tools');
        let files: fs.Dirent[] = [];
        try { files = await fs.promises.readdir(toolsDir, { withFileTypes: true }); } catch { files = []; }
        for (const f of files) {
            if (!f.isFile() || !f.name.endsWith('.jsonl')) { continue; }
            const workspaceKey = f.name.replace(/\.jsonl$/, '');
            let shard: ToolShard;
            try { shard = await this._ingestToolsIntoShard(workspaceKey); } catch { continue; }
            const bucket = shard.months[currentMonth];
            if (!bucket) { continue; }
            for (const [tool, a] of Object.entries(bucket.tools)) {
                const acc = monthAgg.get(tool);
                if (!acc) {
                    monthAgg.set(tool, { ...a, byGroup: { ...a.byGroup } });
                } else {
                    acc.calls += a.calls; acc.errors += a.errors;
                    acc.totalDurMs += a.totalDurMs;
                    acc.minDurMs = Math.min(acc.minDurMs, a.minDurMs);
                    acc.maxDurMs = Math.max(acc.maxDurMs, a.maxDurMs);
                    acc.outputChars += a.outputChars; acc.inputChars += a.inputChars;
                    for (const [g, n] of Object.entries(a.byGroup)) { acc.byGroup[g] = (acc.byGroup[g] || 0) + n; }
                }
            }
        }

        return { ...this._aggToScope(monthAgg), turn: this._aggToScope(this._turnToolAgg) };
    }

    /** Convert an aggregate map to the UI ToolScope shape (sorted, with cache-risk flags). */
    private _aggToScope(map: Map<string, ToolAggregate>): ToolScope {
        // A tool call that takes longer than this risks the ~5 min prompt-cache TTL expiring
        // before the next request, causing a cache miss on the following turn.
        const CACHE_RISK_MS = 240000; // 4 min
        let totalCalls = 0, totalOutputTokens = 0;
        const byTool: ToolStat[] = [];
        for (const [tool, a] of map.entries()) {
            const outputTokens = Math.ceil(a.outputChars / 4);
            const avgMs = a.calls > 0 ? Math.round(a.totalDurMs / a.calls) : 0;
            const minMs = a.minDurMs === Number.POSITIVE_INFINITY ? 0 : Math.round(a.minDurMs);
            const maxMs = Math.round(a.maxDurMs);
            totalCalls += a.calls;
            totalOutputTokens += outputTokens;
            const groups = Object.entries(a.byGroup)
                .map(([group, calls]) => ({ group, calls }))
                .sort((x, y) => y.calls - x.calls)
                .slice(0, 5);
            byTool.push({
                tool, calls: a.calls, outputTokens, avgMs, minMs, maxMs,
                errors: a.errors, cacheRisk: maxMs >= CACHE_RISK_MS, groups
            });
        }
        byTool.sort((a, b) => b.calls - a.calls);
        return { totalCalls, totalOutputTokens, byTool };
    }

    /** RTK compression is enabled when the sentinel file exists AND the rtk binary is installed.
     *  Guards against prefixing commands with `rtk` on machines that don't have it. */
    public isRtkCompressionEnabled(): boolean {
        const sentinelPath = path.join(os.homedir(), '.askaway-rtk-enabled');
        return fs.existsSync(sentinelPath) && this.isRtkInstalled();
    }

    /** Whether the `rtk` CLI is installed (checked across common locations + PATH). Cached. */
    public isRtkInstalled(): boolean {
        if (this._rtkInstalledCache !== undefined) { return this._rtkInstalledCache; }
        const candidates = [
            '/opt/homebrew/bin/rtk', '/usr/local/bin/rtk', path.join(os.homedir(), '.local', 'bin', 'rtk')
        ];
        for (const dir of (process.env.PATH || '').split(path.delimiter)) {
            if (dir) { candidates.push(path.join(dir, 'rtk')); }
        }
        this._rtkInstalledCache = candidates.some(c => { try { return fs.existsSync(c); } catch { return false; } });
        return this._rtkInstalledCache;
    }
    private _rtkInstalledCache: boolean | undefined;

    /**
     * Return a short RTK guidance snippet from RTK.md/skill docs when present.
     * This keeps behavior aligned with `rtk init -g` style instructions without
     * hard-coding a full vendor doc into prompts.
     */
    public async getRtkInstructionPrompt(): Promise<string> {
        const candidates = [
            path.join(os.homedir(), '.codex', 'RTK.md'),
            path.join(os.homedir(), '.claude', 'RTK.md'),
            path.join(os.homedir(), '.askaway', 'skills', 'rtk-integration.md'),
            path.join(os.homedir(), '.askaway', 'RTK.md'),
        ];

        for (const candidate of candidates) {
            try {
                if (!fs.existsSync(candidate)) {
                    continue;
                }
                const raw = await fs.promises.readFile(candidate, 'utf8');
                const cleaned = raw
                    .split(/\r?\n/)
                    .filter(line => line.trim() && !line.trim().startsWith('#'))
                    .slice(0, 8)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (cleaned) {
                    return `RTK.md guidance: ${cleaned.slice(0, 480)}`;
                }
            } catch {
                // Continue fallback chain.
            }
        }

        return '';
    }

    /** True for debug-log files that contain llm_request lines: the parent `main.jsonl` and
     *  `runSubagent-*.jsonl` child sub-agent sessions. Excludes `title-*.jsonl` (chat titles). */
    private _isRequestLogFile(name: string): boolean {
        if (!name.endsWith('.jsonl')) { return false; }
        if (name.startsWith('title-')) { return false; }
        return name === 'main.jsonl' || name.startsWith('runSubagent');
    }

    /** A debug-log file is a CHILD sub-agent session (not the parent agent turn) when it is not
     *  `main.jsonl`. Child logs carry their own `user_message` (the sub-agent's prompt) which must
     *  NOT reset the parent "This turn" window. */
    private _isChildSubagentLog(logFile: string): boolean {
        return path.basename(logFile) !== 'main.jsonl';
    }

    /** Extract the sub-agent label from a child log filename, e.g.
     *  `runSubagent-Explore-toolu_01Cha.jsonl` → `Explore`. Drops the `runSubagent-` prefix and the
     *  trailing session-id segment; preserves multi-part labels (`AskAway-Build`). */
    private _parseSubagentLabel(fileName: string): string {
        const base = fileName.replace(/\.jsonl$/i, '');
        const parts = base.split('-');
        if (parts.length >= 3 && parts[0] === 'runSubagent') {
            return parts.slice(1, -1).join('-') || 'sub-agent';
        }
        return 'sub-agent';
    }

    private async _findWorkspaceCopilotDebugLogFiles(): Promise<string[]> {
        const candidates: string[] = [];

        // Workspace-scoped observability:
        // context.storageUri points to .../workspaceStorage/<workspace-id>/<extension-id>
        // so we can resolve sibling GitHub.copilot-chat logs for THIS workspace only.
        const storageUriPath = this._context.storageUri?.fsPath;
        if (storageUriPath) {
            const workspaceStorageDir = path.dirname(storageUriPath);
            const debugRoot = path.join(workspaceStorageDir, 'GitHub.copilot-chat', 'debug-logs');
            let sessionDirs: fs.Dirent[] = [];
            try {
                sessionDirs = await fs.promises.readdir(debugRoot, { withFileTypes: true });
            } catch {
                return [];
            }

            for (const sessionDir of sessionDirs) {
                if (!sessionDir.isDirectory()) {
                    continue;
                }

                // main.jsonl is the parent agent session; runSubagent-*.jsonl are child
                // sub-agent sessions (their LLM requests are billed but logged separately).
                // Include BOTH so sub-agent credits are counted. Exclude title-*.jsonl (chat
                // titles, not requests).
                let entries: fs.Dirent[] = [];
                try {
                    entries = await fs.promises.readdir(path.join(debugRoot, sessionDir.name), { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const f of entries) {
                    if (!f.isFile() || !this._isRequestLogFile(f.name)) { continue; }
                    const logFile = path.join(debugRoot, sessionDir.name, f.name);
                    try {
                        await fs.promises.access(logFile, fs.constants.R_OK);
                        candidates.push(logFile);
                    } catch {
                        // Skip unreadable candidate.
                    }
                }
            }
        }

        return candidates.sort();
    }

    /**
     * Read webex enabled state from VS Code config
     */
    private _getWebexEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('askaway.webex');
        return config.get<boolean>('enabled', false);
    }

    /**
     * Read telegram enabled state from VS Code config
     */
    private _getTelegramEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('askaway.telegram');
        return config.get<boolean>('enabled', false);
    }

    /**
     * Clean up resources when the provider is disposed
     */
    public dispose(): void {
        // Save session history BEFORE clearing arrays
        // This ensures tool calls are persisted when VS Code reloads
        this.saveCurrentSessionToHistory();

        // Clear debounce timer
        if (this._queueSaveTimer) {
            clearTimeout(this._queueSaveTimer);
            this._queueSaveTimer = null;
        }

        // Clear response timeout timer
        if (this._responseTimeoutTimer) {
            clearTimeout(this._responseTimeoutTimer);
            this._responseTimeoutTimer = null;
        }

        // Clear session timer interval
        this._stopSessionTimerInterval();
        this._stopObservabilityPolling();

        // Clear file search cache
        this._fileSearchCache.clear();

        // Clear session calls map (O(1) lookup cache)
        this._currentSessionCallsMap.clear();

        // Clear pending requests (reject any waiting promises)
        this._pendingRequests.clear();

        // Clean up temp images from current session before clearing
        this._cleanupTempImagesFromEntries(this._currentSessionCalls);

        // Clear session data
        this._currentSessionCalls = [];
        this._attachments = [];

        // Dispose all registered disposables
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];

        this._view = undefined;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._webviewReady = false; // Reset ready state when view is resolved

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);

        // Register message handler (disposable is tracked via this._disposables)
        webviewView.webview.onDidReceiveMessage(
            (message: FromWebviewMessage) => this._handleWebviewMessage(message),
            undefined,
            this._disposables
        );

        // Clean up when webview is disposed
        webviewView.onDidDispose(() => {
            this._stopObservabilityPolling();
            this._webviewReady = false;
            this._view = undefined;
            // Clear file search cache when view is hidden
            this._fileSearchCache.clear();
            // Save current session to persisted history when view is disposed
            this.saveCurrentSessionToHistory();
        }, null, this._disposables);

        // Save history when webview visibility changes (backup for reload)
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                this._stopObservabilityPolling();
                // Save current session when switching away
                this.saveCurrentSessionToHistory();
            } else {
                // Rebuild HTML on every show so stale retained DOM can't keep old worker layouts alive.
                this._webviewReady = false;
                webviewView.webview.html = this._getHtmlContent(webviewView.webview);
                this._startObservabilityPolling();
            }
        }, null, this._disposables);

        // Don't send initial state here - wait for webviewReady message
        // This prevents race condition where messages are sent before JS is initialized
    }

    /**
     * Wait for user response
     */
    private _cancelSupersededPendingRequest(): void {
        if (!this._currentToolCallId || !this._pendingRequests.has(this._currentToolCallId)) {
            return;
        }

        const oldToolCallId = this._currentToolCallId;
        const oldResolve = this._pendingRequests.get(oldToolCallId);
        if (oldResolve) {
            // Resolve the orphaned promise with a cancellation indicator
            oldResolve({
                value: '[CANCELLED: New request superseded this one]',
                queue: this._queueEnabled && this._promptQueue.length > 0,
                attachments: [],
                cancelled: true
            });
            this._pendingRequests.delete(oldToolCallId);

            // Update the old entry status to indicate it was superseded
            const oldEntry = this._currentSessionCallsMap.get(oldToolCallId);
            if (oldEntry && oldEntry.status === 'pending') {
                oldEntry.status = 'cancelled';
                oldEntry.response = '[Superseded by new request]';
                this._updateCurrentSessionUI();
            }
            // Notify messaging services so the superseded task stops polling
            this._telegramService?.resolveTask?.(oldToolCallId);
            this._webexService?.resolveTask?.(oldToolCallId);
            console.warn(`[TaskSync] Previous request ${oldToolCallId} was superseded by new request`);
        }
    }

    /**
     * Signal the next queued waitForUserResponse call that it can proceed.
     * Called every time the active request resolves (any path).
     */
    private _signalNextWaiter(): void {
        const next = this._waitingRequests.shift();
        if (next) { next(); }
    }

    public async waitForUserResponse(question: string): Promise<UserResponseResult> {
        // Auto-start new session if previous session was terminated
        if (this._sessionTerminated) {
            this.startNewSession();
        }

        // Start session timer on first tool call
        if (this._sessionStartTime === null) {
            this._sessionStartTime = Date.now();
            this._sessionFrozenElapsed = null;
            this._startSessionTimerInterval();
        }

        if (this._autopilotEnabled && !(this._queueEnabled && this._promptQueue.length > 0)) {
            // Race condition prevention: If there's already a pending request, cancel it
            this._cancelSupersededPendingRequest();

            // Increment consecutive auto-response counter
            this._consecutiveAutoResponses++;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            const maxConsecutive = config.get<number>('maxConsecutiveAutoResponses', 5);

            // Check if limit reached BEFORE auto-responding
            if (this._consecutiveAutoResponses > maxConsecutive) {
                this._autopilotEnabled = false;
                await config.update('autopilot', false, vscode.ConfigurationTarget.Workspace);
                this._updateSettingsUI();
                vscode.window.showWarningMessage(`AskAway: Auto-response limit (${maxConsecutive}) reached. Waiting for response or timeout.`);
                // Fall through to pending request flow with timeout timer
            } else {
                const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                this._currentToolCallId = toolCallId;

                // Random delay simulates human reading/response time
                await this._applyHumanLikeDelay('Autopilot');

                // Re-check after delay: user may have disabled autopilot or responded manually
                if (!this._autopilotEnabled || this._currentToolCallId !== toolCallId) {
                    // State changed during delay — fall through to normal pending request flow
                } else {
                    // Get the next prompt from cycling array (or fallback to default)
                    let effectiveText: string;
                    if (this._autopilotPrompts.length > 0) {
                        effectiveText = this._autopilotPrompts[this._autopilotIndex];
                        this._autopilotIndex = (this._autopilotIndex + 1) % this._autopilotPrompts.length;
                    } else {
                        effectiveText = this._normalizeAutopilotText(this._autopilotText);
                    }

                    vscode.window.showInformationMessage(`AskAway: Autopilot auto-responded. (${this._consecutiveAutoResponses}/${maxConsecutive})`);

                    const entry: ToolCallEntry = {
                        id: toolCallId,
                        prompt: question,
                        response: effectiveText,
                        timestamp: Date.now(),
                        isFromQueue: false,
                        status: 'completed'
                    };
                    this._currentSessionCalls.unshift(entry);
                    this._currentSessionCallsMap.set(entry.id, entry);
                    this._updateCurrentSessionUI();
                    this._currentToolCallId = null;
                    this._signalNextWaiter();
                    this._resetTurnMetrics();
                    return {
                        value: effectiveText,
                        queue: this._queueEnabled && this._promptQueue.length > 0,
                        attachments: []
                    };
                }
            }
        }

        // If view is not available, open the sidebar first
        if (!this._view) {
            // Open the TaskSync sidebar view
            await vscode.commands.executeCommand(VIEW_FOCUS_COMMAND);

            // Wait for view to be resolved (up to configured timeout)
            let waited = 0;
            while (!this._view && waited < this._VIEW_OPEN_TIMEOUT_MS) {
                await new Promise(resolve => setTimeout(resolve, this._VIEW_OPEN_POLL_INTERVAL_MS));
                waited += this._VIEW_OPEN_POLL_INTERVAL_MS;
            }

            if (!this._view) {
                console.error(`[TaskSync] Failed to open sidebar view after waiting ${this._VIEW_OPEN_TIMEOUT_MS}ms`);
                throw new Error(`Failed to open TaskSync sidebar after ${this._VIEW_OPEN_TIMEOUT_MS}ms. The webview may not be properly initialized.`);
            }
        }

        // Concurrent ask_user: if another request is already active, queue this one
        // and wait for it to complete — instead of cancelling the first conversation.
        if (this._currentToolCallId && this._pendingRequests.has(this._currentToolCallId)) {
            this._concurrentWaitingCount++;
            await new Promise<void>(resolve => this._waitingRequests.push(resolve));
            this._concurrentWaitingCount--;
        }

        const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        this._currentToolCallId = toolCallId;
        const displayQuestion = question;

        // Check if queue is enabled and has prompts - auto-respond
        if (this._queueEnabled && this._promptQueue.length > 0) {
            const queuedPrompt = this._promptQueue.shift();
            if (queuedPrompt) {
                this._saveQueueToDisk();
                this._updateQueueUI();

                // Random delay simulates human reading/response time
                await this._applyHumanLikeDelay('Queue');

                // Re-check after delay: user may have disabled queue or responded manually
                if (!this._queueEnabled || this._currentToolCallId !== toolCallId) {
                    // State changed during delay — restore prompt to queue
                    this._promptQueue.unshift(queuedPrompt);
                    this._saveQueueToDisk();
                    this._updateQueueUI();
                } else {
                    const entry: ToolCallEntry = {
                        id: toolCallId,
                        prompt: displayQuestion,
                        response: queuedPrompt.prompt,
                        timestamp: Date.now(),
                        isFromQueue: true,
                        status: 'completed'
                    };
                    this._currentSessionCalls.unshift(entry);
                    this._currentSessionCallsMap.set(entry.id, entry); // Maintain O(1) lookup map
                    this._updateCurrentSessionUI();
                    this._currentToolCallId = null;
                    this._signalNextWaiter();
                    this._resetTurnMetrics();
                    return {
                        value: queuedPrompt.prompt,
                        queue: this._queueEnabled && this._promptQueue.length > 0,
                        attachments: queuedPrompt.attachments || []  // Return stored attachments
                    };
                }
            }
        }

        this._view.show(true);

        // Add pending entry to current session (so we have the prompt when completing)
        const pendingEntry: ToolCallEntry = {
            id: toolCallId,
            prompt: displayQuestion,
            response: '',
            timestamp: Date.now(),
            askedAt: Date.now(),
            isFromQueue: false,
            status: 'pending'
        };
        this._currentSessionCalls.unshift(pendingEntry);
        this._currentSessionCallsMap.set(toolCallId, pendingEntry); // O(1) lookup

        // Parse choices from question and determine if it's an approval question
        const choices = this._parseChoices(question);
        const isApproval = choices.length === 0 && this._isApprovalQuestion(question);

        // Wait for webview to be ready (JS initialized) before sending message
        if (!this._webviewReady) {
            // Wait for webview JS to initialize (up to 3 seconds)
            const maxWaitMs = 3000;
            const pollIntervalMs = 50;
            let waited = 0;
            while (!this._webviewReady && waited < maxWaitMs) {
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                waited += pollIntervalMs;
            }
        }

        // Store pending request for remote clients
        this._currentPendingRequest = {
            id: toolCallId,
            prompt: displayQuestion,
            isApprovalQuestion: isApproval,
            choices: choices.length > 0 ? choices : undefined
        };

        // Broadcast pending tool call to VS Code webview and remote clients
        const pendingMessage: ToWebviewMessage = {
            type: 'toolCallPending',
            id: toolCallId,
            prompt: displayQuestion,
            isApprovalQuestion: isApproval,
            choices: choices.length > 0 ? choices : undefined
        };

        if (this._webviewReady && this._view) {
            this._broadcast(pendingMessage);
            // Play notification sound when AI triggers ask_user
            this.playNotificationSound();
        } else {
            // Fallback: queue the message (should rarely happen now)
            this._pendingToolCallMessage = { id: toolCallId, prompt: displayQuestion };
            // Still broadcast to remote clients even if VS Code webview isn't ready
            if (this._remoteBroadcastCallback) {
                this._remoteBroadcastCallback(pendingMessage);
            }
        }

        // Post question to Webex if configured
        if (this._webexService && typeof this._webexService.postAdaptiveCard === 'function' && this._webexService.isConfigured()) {
            this._webexService.postAdaptiveCard(toolCallId, question, choices.length > 0 ? choices : undefined)
                .catch((err: any) => console.error('[AskAway] Webex postAdaptiveCard error:', err));
        }

        // Post question to Telegram if configured
        if (this._telegramService && typeof this._telegramService.postQuestion === 'function') {
            if (this._telegramService.isConfigured()) {
                this._telegramService.postQuestion(toolCallId, question, choices.length > 0 ? choices : undefined)
                    .catch((err: any) => {
                        // Error already logged inside TelegramService via _err()
                        console.error('[AskAway] Telegram postQuestion error:', err);
                    });
            } else {
                // TelegramService logs the "not configured" detail in its own output channel
                console.warn('[AskAway] Telegram: SKIPPED — not configured');
            }
        } else {
            console.warn('[AskAway] Telegram: SKIPPED — service unavailable (check deferred init in AskAway output)');
        }

        this._updateCurrentSessionUI();

        // Start response-timeout auto-respond timer (if configured)
        this._startResponseTimeoutTimer(toolCallId);

        return new Promise<UserResponseResult>((resolve) => {
            this._pendingRequests.set(toolCallId, resolve);
        });
    }

    /**
     * Voice conversation mode — TTS speaks the question, user responds by voice
     * Returns the transcribed text from the user's speech
     */
    public async waitForVoiceResponse(question: string, token: vscode.CancellationToken): Promise<string> {
        // Ensure sidebar is visible
        if (!this._view) {
            await vscode.commands.executeCommand(VIEW_FOCUS_COMMAND);
            let waited = 0;
            while (!this._view && waited < this._VIEW_OPEN_TIMEOUT_MS) {
                await new Promise(resolve => setTimeout(resolve, this._VIEW_OPEN_POLL_INTERVAL_MS));
                waited += this._VIEW_OPEN_POLL_INTERVAL_MS;
            }
            if (!this._view) {
                throw new Error('Failed to open AskAway sidebar for voice mode');
            }
        }

        this._view.show(true);

        // Wait for webview to be ready
        if (!this._webviewReady) {
            const maxWaitMs = 3000;
            const pollIntervalMs = 50;
            let waited = 0;
            while (!this._webviewReady && waited < maxWaitMs) {
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                waited += pollIntervalMs;
            }
        }

        const taskId = `voice_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // Also track as a tool call for history
        const pendingEntry: ToolCallEntry = {
            id: taskId,
            prompt: `🎤 ${question}`,
            response: '',
            timestamp: Date.now(),
            askedAt: Date.now(),
            isFromQueue: false,
            status: 'pending'
        };
        this._currentSessionCalls.unshift(pendingEntry);
        this._currentSessionCallsMap.set(taskId, pendingEntry);
        this._updateCurrentSessionUI();

        // Show voice overlay in webview (waveform animation)
        this._broadcast({ type: 'voiceStart', taskId, question });

        // Speak the question using macOS `say` command (much better quality)
        await this._speakText(question);

        if (token.isCancellationRequested) {
            this._broadcast({ type: 'voiceStop' });
            throw new vscode.CancellationError();
        }

        // Signal webview that speaking is done → show status
        this._broadcast({ type: 'voiceSpeakingDone', taskId });

        // Use VS Code's native input box for response (supports macOS dictation properly)
        const response = await new Promise<string>((resolve, reject) => {
            this._pendingVoiceRequests.set(taskId, { resolve, reject });

            // Handle cancellation
            const disposable = token.onCancellationRequested(() => {
                this._pendingVoiceRequests.delete(taskId);
                this._broadcast({ type: 'voiceStop' });

                // Kill any ongoing TTS
                if (this._currentSayProcess) {
                    try { this._currentSayProcess.kill(); } catch {}
                    this._currentSayProcess = null;
                }

                // Mark tool call as cancelled
                const entry = this._currentSessionCallsMap.get(taskId);
                if (entry) {
                    entry.status = 'cancelled';
                    entry.response = '(cancelled)';
                    this._updateCurrentSessionUI();
                }

                reject(new vscode.CancellationError());
                disposable.dispose();
            });

            // Show native input box — macOS dictation (Fn+Fn) works here
            vscode.window.showInputBox({
                prompt: `🎤 ${question}`,
                placeHolder: 'Speak (Fn+Fn for dictation) or type your response…',
                ignoreFocusOut: true
            }).then(value => {
                if (value !== undefined && value.trim()) {
                    const pending = this._pendingVoiceRequests.get(taskId);
                    if (pending) {
                        this._pendingVoiceRequests.delete(taskId);

                        // Update tool call history
                        const entry = this._currentSessionCallsMap.get(taskId);
                        if (entry) {
                            entry.response = value.trim();
                            entry.status = 'completed';
                            this._updateCurrentSessionUI();
                        }

                        this._broadcast({ type: 'voiceStop' });
                        pending.resolve(value.trim());
                    }
                } else {
                    // User dismissed input box
                    const pending = this._pendingVoiceRequests.get(taskId);
                    if (pending) {
                        this._pendingVoiceRequests.delete(taskId);
                        this._broadcast({ type: 'voiceStop' });
                        pending.resolve('[User skipped voice response. Ask again or continue working.]');
                    }
                }
                disposable.dispose();
            });
        });

        return response;
    }

    /**
     * Speak text using macOS `say` command for high-quality TTS.
     * Falls back to a no-op on non-macOS platforms.
     */
    private async _speakText(text: string): Promise<void> {
        const { exec } = require('child_process');
        const os = require('os');

        if (os.platform() !== 'darwin') {
            // Non-macOS: let webview handle TTS via SpeechSynthesis
            return;
        }

        // Get configured voice (default: Samantha)
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const voice = config.get<string>('voiceName', 'Samantha');
        const rate = config.get<number>('voiceRate', 200); // words per minute

        // Escape text for shell
        const escaped = text.replace(/'/g, "'\\''");

        return new Promise<void>((resolve) => {
            const proc = exec(`say -v '${voice}' -r ${rate} '${escaped}'`, (err: any) => {
                if (err) {
                    console.warn('[Voice] say command failed:', err.message);
                }
                resolve();
            });

            // Store process so we can kill it on cancel
            this._currentSayProcess = proc;
        });
    }

    private _currentSayProcess: any = null;

    /**
     * Handle voice transcription response from webview
     */
    private _handleVoiceResponse(taskId: string, transcription: string): void {
        const pending = this._pendingVoiceRequests.get(taskId);
        if (pending) {
            this._pendingVoiceRequests.delete(taskId);

            // Update tool call history
            const entry = this._currentSessionCallsMap.get(taskId);
            if (entry) {
                entry.response = transcription;
                entry.status = 'completed';
                this._updateCurrentSessionUI();
            }

            pending.resolve(transcription);
        }
    }

    /**
     * Handle voice error from webview
     */
    private _handleVoiceError(taskId: string, error: string): void {
        const pending = this._pendingVoiceRequests.get(taskId);
        if (pending) {
            this._pendingVoiceRequests.delete(taskId);

            // Update tool call history
            const entry = this._currentSessionCallsMap.get(taskId);
            if (entry) {
                entry.response = `(voice error: ${error})`;
                entry.status = 'completed';
                this._updateCurrentSessionUI();
            }

            // Fall back to text — don't reject, just return the error message
            // so Copilot can ask again via text
            pending.resolve(`[Voice error: ${error}. Please ask again via text using ask_user tool.]`);
        }
    }

    /**
     * Handle mic button click — show voice mode activation instructions
     */
    private async _handleMicButtonClicked(): Promise<void> {
        const selection = await vscode.window.showInformationMessage(
            '🎤 To use Voice Mode, switch to the "voice" chat mode in Copilot Chat. Type #talkToUser in your prompt to reference the voice tool directly.',
            'Open Voice Chat Mode',
            'Copy #talkToUser'
        );

        if (selection === 'Open Voice Chat Mode') {
            // Try to open Copilot chat with the voice chatmode
            try {
                await vscode.commands.executeCommand('workbench.action.chat.open');
            } catch {
                // If command doesn't exist, just show the hint
                vscode.window.showInformationMessage('Open Copilot Chat and select "voice" from the chat mode selector (at the top of the chat).');
            }
        } else if (selection === 'Copy #talkToUser') {
            await vscode.env.clipboard.writeText('#talkToUser');
            vscode.window.showInformationMessage('Copied! Paste #talkToUser in Copilot Chat to reference the voice tool.');
        }
    }

    /**
     * Handle voice interrupt — stop TTS and jump to input phase
     */
    private _handleVoiceInterrupt(): void {
        // Kill the macOS `say` process if running
        if (this._currentSayProcess) {
            try { this._currentSayProcess.kill(); } catch {}
            this._currentSayProcess = null;
        }

        // Also kill via pkill as a safety net
        const { exec } = require('child_process');
        exec('pkill -f "say -v"', () => {});

        // Signal webview to transition to input phase immediately
        // Find the current voice task ID
        const entries = Array.from(this._pendingVoiceRequests.entries());
        if (entries.length > 0) {
            const [taskId] = entries[0];
            this._broadcast({ type: 'voiceSpeakingDone', taskId });
        }
    }

    /**
     * Check if queue is enabled
     */
    public isQueueEnabled(): boolean {
        return this._queueEnabled;
    }

    /**
     * Handle messages from webview
     */
    private _handleWebviewMessage(message: FromWebviewMessage): void {
        switch (message.type) {
            case 'submit':
                this._handleSubmit(message.value, message.attachments || []);
                break;
            case 'addQueuePrompt':
                this._handleAddQueuePrompt(message.prompt, message.id, message.attachments || []);
                break;
            case 'removeQueuePrompt':
                this._handleRemoveQueuePrompt(message.promptId);
                break;
            case 'editQueuePrompt':
                this._handleEditQueuePrompt(message.promptId, message.newPrompt);
                break;
            case 'reorderQueue':
                this._handleReorderQueue(message.fromIndex, message.toIndex);
                break;
            case 'toggleQueue':
                this._handleToggleQueue(message.enabled);
                break;
            case 'clearQueue':
                this._handleClearQueue();
                break;
            case 'addAttachment':
                this._handleAddAttachment();
                break;
            case 'removeAttachment':
                this._handleRemoveAttachment(message.attachmentId);
                break;
            case 'removeHistoryItem':
                this._handleRemoveHistoryItem(message.callId);
                break;
            case 'workerResolveManual':
                // User submitted a manual response for a worker task
                if (message.taskId && typeof message.result === 'string') {
                    this.resolveWorkerTask(message.taskId, message.result);
                }
                break;
            case 'workerRunAutopilot':
                // Delegated model execution with effort/agent options
                if (message.taskId) {
                    this.runWorkerTaskWithModel(message.taskId, message.modelId || '', {
                        agentName: message.agentName,
                        thinkingEffort: message.thinkingEffort
                    });
                }
                break;
            case 'configureWorkerTools':
                // Open VS Code native Configure Tools dialog (same as Copilot chat widget toolbar button)
                void vscode.commands.executeCommand('workbench.action.chat.configureTools');
                break;
            case 'changeWorkerModel':
                // Open VS Code native model picker (same as Copilot chat widget model button)
                void vscode.commands.executeCommand('workbench.action.chat.changeModel');
                break;
            case 'requestModels':
                // Webview requesting fresh model list
                this.broadcastAvailableModels();
                break;
            case 'clearPersistedHistory':
                this._handleClearPersistedHistory();
                break;
            case 'openHistoryModal':
                this._handleOpenHistoryModal();
                break;
            case 'searchFiles':
                this._handleSearchFiles(message.query);
                break;
            case 'saveImage':
                this._handleSaveImage(message.data, message.mimeType);
                break;
            case 'addFileReference':
                this._handleAddFileReference(message.file);
                break;
            case 'webviewReady':
                this._handleWebviewReady(message.uiVersion);
                break;
            case 'openSettingsModal':
                this._handleOpenSettingsModal();
                break;
            case 'updateSoundSetting':
                this._handleUpdateSoundSetting(message.enabled);
                break;
            case 'updateInteractiveApprovalSetting':
                this._handleUpdateInteractiveApprovalSetting(message.enabled);
                break;
            case 'updateWebexSetting':
                this._handleUpdateWebexSetting(message.enabled);
                break;
            case 'updateTelegramSetting':
                this._handleUpdateTelegramSetting(message.enabled);
                break;
            case 'updateAutopilotSetting':
                this._handleUpdateAutopilotSetting(message.enabled);
                break;
            case 'updateAutopilotText':
                this._handleUpdateAutopilotText(message.text);
                break;
            case 'updateSendWithCtrlEnterSetting':
                this._handleUpdateSendWithCtrlEnterSetting(message.enabled);
                break;
            case 'updateDebugLoggingSetting':
                this._handleUpdateDebugLoggingSetting(message.enabled);
                break;
            case 'updateRtkCompressionSetting':
                this._handleUpdateRtkCompressionSetting(message.enabled);
                break;
            case 'updateAutoCompactionDisabled':
                this._handleUpdateAutoCompactionDisabled(message.disabled);
                break;
            case 'updateExtendedCacheTtl':
                this._handleUpdateCopilotChatSetting('anthropic.promptCaching.extendedTtl', message.enabled);
                break;
            case 'updateExtendedCacheTtlMessages':
                this._handleUpdateCopilotChatSetting('anthropic.promptCaching.extendedTtlMessages', message.enabled);
                break;
            case 'updateCacheKeepWarm':
                this._handleUpdateCopilotChatSetting('agent.longToolCallCachePreservation.enabled', message.enabled);
                break;
            case 'updateCacheKeepWarmProbes':
                this._handleUpdateCopilotChatSetting('agent.longToolCallCachePreservation.maxProbes', Math.max(0, Math.min(10, Math.round(message.value || 0))));
                break;
            case 'pingCache':
                this._handlePingCache();
                break;
            case 'updateResponseTimeout':
                this._handleUpdateResponseTimeout(message.value);
                break;
            case 'updateSessionWarningHours':
                this._handleUpdateSessionWarningHours(message.value);
                break;
            case 'updateMaxConsecutiveAutoResponses':
                this._handleUpdateMaxConsecutiveAutoResponses(message.value);
                break;
            case 'updateTurnBudgetAiu':
                this._handleUpdateTurnBudgetAiu(message.value);
                break;
            case 'updateHumanDelaySetting':
                this._handleUpdateHumanDelaySetting(message.enabled);
                break;
            case 'updateHumanDelayMin':
                this._handleUpdateHumanDelayMin(message.value);
                break;
            case 'updateHumanDelayMax':
                this._handleUpdateHumanDelayMax(message.value);
                break;
            case 'addAutopilotPrompt':
                this._handleAddAutopilotPrompt(message.prompt);
                break;
            case 'editAutopilotPrompt':
                this._handleEditAutopilotPrompt(message.index, message.prompt);
                break;
            case 'removeAutopilotPrompt':
                this._handleRemoveAutopilotPrompt(message.index);
                break;
            case 'reorderAutopilotPrompts':
                this._handleReorderAutopilotPrompts(message.fromIndex, message.toIndex);
                break;
            case 'copyToClipboard':
                if (message.text) {
                    vscode.env.clipboard.writeText(message.text);
                }
                break;
            case 'addReusablePrompt':
                this._handleAddReusablePrompt(message.name, message.prompt);
                break;
            case 'editReusablePrompt':
                this._handleEditReusablePrompt(message.id, message.name, message.prompt);
                break;
            case 'removeReusablePrompt':
                this._handleRemoveReusablePrompt(message.id);
                break;
            case 'searchSlashCommands':
                this._handleSearchSlashCommands(message.query);
                break;
            case 'openExternal':
                if (message.url) {
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;
            case 'openFile':
                if (message.path && typeof message.path === 'string') {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path))
                        .then(undefined, () => { /* file may no longer exist — ignore */ });
                }
                break;
            case 'searchContext':
                this._handleSearchContext(message.query);
                break;
            case 'selectContextReference':
                this._handleSelectContextReference(message.contextType, message.options);
                break;
            case 'voiceResponse':
                this._handleVoiceResponse(message.taskId, message.transcription);
                break;
            case 'voiceError':
                this._handleVoiceError(message.taskId, message.error);
                break;
            case 'micButtonClicked':
                this._handleMicButtonClicked();
                break;
            case 'voiceInterrupt':
                this._handleVoiceInterrupt();
                break;
            // ── Plan Mode messages ──
            case 'planSetMode':
                this._handlePlanSetMode(message.enabled);
                break;
            case 'planAddTask':
                this._handlePlanAddTask(message.title, message.description, message.requiresReview, message.afterTaskId);
                break;
            case 'planEditTask':
                this._handlePlanEditTask(message.taskId, message.title, message.description, message.requiresReview);
                break;
            case 'planDeleteTask':
                this._handlePlanDeleteTask(message.taskId);
                break;
            case 'planReorderTask':
                this._handlePlanReorderTask(message.taskId, message.newOrder);
                break;
            case 'planSplitTask':
                this._handlePlanSplitTask(message.taskId);
                break;
            case 'planAcceptSplit':
                this._handlePlanAcceptSplit(message.taskId, message.subtasks);
                break;
            case 'planReviewApprove':
                this._handlePlanReviewApprove(message.taskId);
                break;
            case 'planReviewReject':
                this._handlePlanReviewReject(message.taskId, message.feedback);
                break;
            case 'planToggleAutoAdvance':
                this._handlePlanToggleAutoAdvance(message.enabled);
                break;
            case 'planStartExecution':
                this._handlePlanStartExecution();
                break;
            case 'planPauseExecution':
                this._handlePlanPauseExecution();
                break;
            case 'openPlanBoard':
                if (this._planEditor) {
                    this._planEditor.open();
                } else {
                    vscode.commands.executeCommand('askaway.openPlanBoard');
                }
                break;
        }
    }

    /**
     * Handle webview ready signal - send initial state and any pending messages
     */
    private _handleWebviewReady(uiVersion?: string): void {
        // If we receive a ready signal from an older retained webview bundle,
        // immediately replace HTML so users cannot stay on stale UI.
        if (uiVersion !== this._WEBVIEW_UI_VERSION && this._view) {
            this._webviewReady = false;
            this._view.webview.html = this._getHtmlContent(this._view.webview);
            return;
        }

        this._webviewReady = true;

        // Send settings
        this._updateSettingsUI();
        this._startObservabilityPolling();
        // Send initial queue state and current session history
        this._updateQueueUI();
        this._updateCurrentSessionUI();
        // Send available models and worker queue
        this.broadcastAvailableModels();
        this._broadcastWorkerQueue();

        // Send plan state if plan mode is active
        if (this._currentPlan) {
            this._broadcast({ type: 'updatePlan', plan: this._currentPlan });
        }

        // If there's a pending tool call message that was never sent, send it now
        if (this._pendingToolCallMessage) {
            const prompt = this._pendingToolCallMessage.prompt;
            const choices = this._parseChoices(prompt);
            const isApproval = choices.length === 0 && this._isApprovalQuestion(prompt);
            this._view?.webview.postMessage({
                type: 'toolCallPending',
                id: this._pendingToolCallMessage.id,
                prompt: prompt,
                isApprovalQuestion: isApproval,
                choices: choices.length > 0 ? choices : undefined
            });
            this._pendingToolCallMessage = null;
        }
        // If there's an active pending request (webview was hidden/recreated while waiting),
        // re-send the pending tool call message so the user sees the question again
        else if (this._currentToolCallId && this._pendingRequests.has(this._currentToolCallId)) {
            // Find the pending entry to get the prompt
            const pendingEntry = this._currentSessionCallsMap.get(this._currentToolCallId);
            if (pendingEntry && pendingEntry.status === 'pending') {
                const prompt = pendingEntry.prompt;
                const choices = this._parseChoices(prompt);
                const isApproval = choices.length === 0 && this._isApprovalQuestion(prompt);
                this._view?.webview.postMessage({
                    type: 'toolCallPending',
                    id: this._currentToolCallId,
                    prompt: prompt,
                    isApprovalQuestion: isApproval,
                    choices: choices.length > 0 ? choices : undefined
                });
            }
        }
    }

    private _startObservabilityPolling(): void {
        if (this._observabilityPollInterval) {
            return;
        }

        // Push immediately so users see fresh numbers as soon as Settings is opened.
        void this._broadcastObservabilityMetrics();

        this._observabilityPollInterval = setInterval(() => {
            if (!this._webviewReady || !this._view || !this._view.visible) {
                return;
            }
            void this._broadcastObservabilityMetrics();
        }, this._OBSERVABILITY_POLL_MS);
    }

    private _stopObservabilityPolling(): void {
        if (this._observabilityPollInterval) {
            clearInterval(this._observabilityPollInterval);
            this._observabilityPollInterval = null;
        }
    }

    /** Reset the "This turn" metrics window. Call at every turn boundary regardless of response source.
     *  Pass ts to use the log-entry timestamp (more accurate); omit to use wall-clock. */
    private _resetTurnMetrics(ts?: number): void {
        this._lastSubmitTs = ts ?? Date.now();
        this._lastRequestMetrics = this._emptyScope();
        this._turnToolAgg.clear();
        this._turnRequests = [];
        this._turnEvents = [];
        this._turnSubagents.clear();
        this._turnSpanToSubagent.clear();
        this._turnSubagentLabelById.clear();
        this._turnFirstReqSeen = false;
    }

    /** Stable 5-char locator for a request (hash of sid:lineIndex); shown in the turn table so
     *  the user can ask to investigate a specific request, and written into the master table. */
    private _shortReqId(sid: string, lineIndex: number): string {
        return this._hashText(`${sid}:${lineIndex}`).slice(0, 5).toUpperCase();
    }

    /** Lossless tool I/O reconciliation. The PostToolUse hook (~/.askaway/tool-io.jsonl) logs the
     *  FULL, untruncated size of every tool call (Copilot truncates attrs.result in its debug log
     *  to ~5K chars). We index those rows by tool name and match the one whose timestamp is closest
     *  to the debug tool_call event. Returns the real in/out sizes when the hook captured a larger
     *  output than the (possibly truncated) debug result. Cached by file size+mtime. */
    private _toolIoIndex: Map<string, Array<{ ts: number; inChars: number; outChars: number; inTok: number; outTok: number }>> | null = null;
    private _toolIoSig = '';
    private _toolIoTokMemo = new Map<string, { inTok: number; outTok: number }>();
    private _loadToolIoIndex(): Map<string, Array<{ ts: number; inChars: number; outChars: number; inTok: number; outTok: number }>> {
        const file = path.join(os.homedir(), '.askaway', 'tool-io.jsonl');
        let st: fs.Stats | undefined;
        try { st = fs.statSync(file); } catch { this._toolIoIndex = new Map(); this._toolIoSig = ''; return this._toolIoIndex; }
        const sig = `${st.size}:${st.mtimeMs}`;
        if (this._toolIoIndex && sig === this._toolIoSig) { return this._toolIoIndex; }
        const idx = new Map<string, Array<{ ts: number; inChars: number; outChars: number; inTok: number; outTok: number }>>();
        try {
            const raw = fs.readFileSync(file, 'utf8');
            for (const line of raw.split('\n')) {
                if (!line) { continue; }
                try {
                    const r = JSON.parse(line) as Record<string, unknown>;
                    const tool = typeof r.tool === 'string' ? r.tool : '';
                    if (!tool) { continue; }
                    // Tokenize the FULL logged text with the real gpt-tokenizer (no chars/4).
                    // Only the resulting counts are retained; text is discarded to bound memory.
                    const inText = typeof r.in === 'string' ? r.in : '';
                    const outText = typeof r.out === 'string' ? r.out : '';
                    const memoKey = `${Number(r.ts) || 0}:${Number(r.inChars) || inText.length}:${Number(r.outChars) || outText.length}`;
                    let toks = this._toolIoTokMemo.get(memoKey);
                    if (!toks) {
                        toks = { inTok: inText ? countTokens(inText) : 0, outTok: outText ? countTokens(outText) : 0 };
                        if (this._toolIoTokMemo.size > 5000) { this._toolIoTokMemo.clear(); }
                        this._toolIoTokMemo.set(memoKey, toks);
                    }
                    const entry = {
                        ts: Number(r.ts) || 0,
                        inChars: Number(r.inChars) || inText.length,
                        outChars: Number(r.outChars) || outText.length,
                        inTok: toks.inTok,
                        outTok: toks.outTok,
                    };
                    const list = idx.get(tool) || [];
                    list.push(entry);
                    idx.set(tool, list);
                } catch { /* skip */ }
            }
        } catch { /* unreadable */ }
        this._toolIoIndex = idx;
        this._toolIoSig = sig;
        return idx;
    }

    /** Look up the lossless tool I/O for a debug tool_call event. Matches the nearest-in-time hook
     *  row for the same tool; only overrides when the hook output is materially larger than the
     *  (truncated) debug result — signalling truncation. `truncated` flags that case for the UI. */
    private _lookupToolIo(
        tool: string, ts: number, debugOutChars: number, debugInChars: number
    ): { inTok: number; outTok: number; outChars: number; truncated: boolean } | null {
        const idx = this._loadToolIoIndex();
        const list = idx.get(tool);
        if (!list || !list.length) { return null; }
        let best: { ts: number; inChars: number; outChars: number; inTok: number; outTok: number } | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const e of list) {
            const d = Math.abs(e.ts - ts);
            if (d < bestDelta) { bestDelta = d; best = e; }
        }
        // Require the match to be within a reasonable window (30s) of the debug event.
        if (!best || bestDelta > 30000) { return null; }
        const truncated = best.outChars > debugOutChars + 64;
        return { inTok: best.inTok, outTok: best.outTok, outChars: best.outChars, truncated };
    }

    /** Stable 5-char group key for a sub-agent instance (hash of its child session id). */
    private _shortSubagentId(childSessionId: string): string {
        return this._hashText(`sa:${childSessionId}`).slice(0, 5).toUpperCase();
    }

    /** Ensure a sub-agent header entry exists — called ONLY when an in-window event is emitted for
     *  it, so the header count always equals the number of groups actually shown in the timeline. */
    private _ensureTurnSubagent(subagentId: string, label?: string, ts?: number): void {
        if (this._turnSubagents.has(subagentId)) { return; }
        this._turnSubagents.set(subagentId, {
            subagentId,
            label: label || this._turnSubagentLabelById.get(subagentId) || 'sub-agent',
            done: false, durMs: 0, outputTokens: 0, status: 'running',
            startedTs: ts || Date.now(),
        });
    }

    /**
     * Handle submit from webview
     */
    private _handleSubmit(value: string, attachments: AttachmentInfo[]): void {
        // A new user message starts a new "This turn" aggregation window. The next
        // observability scan sums only llm_requests at/after this timestamp.
        this._resetTurnMetrics();
        if (this._pendingRequests.size > 0 && this._currentToolCallId) {
            const resolve = this._pendingRequests.get(this._currentToolCallId);
            if (resolve) {
                // User manually responded — reset auto-response tracking
                this._consecutiveAutoResponses = 0;
                if (this._responseTimeoutTimer) {
                    clearTimeout(this._responseTimeoutTimer);
                    this._responseTimeoutTimer = null;
                }

                // O(1) lookup using Map instead of O(n) findIndex
                const pendingEntry = this._currentSessionCallsMap.get(this._currentToolCallId);

                let completedEntry: ToolCallEntry;
                if (pendingEntry && pendingEntry.status === 'pending') {
                    // Update existing pending entry
                    pendingEntry.response = value;
                    pendingEntry.attachments = attachments;
                    pendingEntry.status = 'completed';
                    pendingEntry.timestamp = Date.now();
                    completedEntry = pendingEntry;
                } else {
                    // Create new completed entry (shouldn't happen normally)
                    completedEntry = {
                        id: this._currentToolCallId,
                        prompt: 'Tool call',
                        response: value,
                        attachments: attachments,
                        timestamp: Date.now(),
                        isFromQueue: false,
                        status: 'completed'
                    };
                    this._currentSessionCalls.unshift(completedEntry);
                    this._currentSessionCallsMap.set(completedEntry.id, completedEntry);
                }

                // Clear pending request for remote clients
                this._currentPendingRequest = null;

                // Broadcast toolCallCompleted to trigger "Working...." state
                this._broadcast({
                    type: 'toolCallCompleted',
                    entry: completedEntry
                });

                this._updateCurrentSessionUI();
                // Notify messaging services so stale tasks don't keep polling
                const resolvedId = this._currentToolCallId;
                resolve({ value, queue: this._queueEnabled && this._promptQueue.length > 0, attachments });
                this._pendingRequests.delete(this._currentToolCallId);
                this._currentToolCallId = null;
                this._signalNextWaiter();
                this._telegramService?.resolveTask?.(resolvedId);
                this._webexService?.resolveTask?.(resolvedId);
            } else {
                // No pending tool call - add message to queue for later use
                if (value && value.trim()) {
                    const queuedPrompt: QueuedPrompt = {
                        id: `q_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                        prompt: value.trim()
                    };
                    this._promptQueue.push(queuedPrompt);
                    // Auto-switch to queue mode so user sees their message went to queue
                    this._queueEnabled = true;
                    this._saveQueueToDisk();
                    this._updateQueueUI();
                }
            }
            // NOTE: Temp images are NOT cleaned up here anymore.
            // They are stored in the ToolCallEntry.attachments and will be cleaned up when:
            // 1. clearCurrentSession() is called
            // 2. dispose() is called (extension deactivation)
            // This ensures images are available for the entire session duration.

            // Clear attachments after submit and sync with webview
            this._attachments = [];
            this._updateAttachmentsUI();
        }
    }

    /**
     * Clean up temporary image files from disk by URI list
     */
    private _cleanupTempImagesByUri(uris: string[]): void {
        for (const uri of uris) {
            try {
                const filePath = vscode.Uri.parse(uri).fsPath;
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (error) {
                console.error('[TaskSync] Failed to cleanup temp image:', error);
            }
        }
    }

    /**
     * Clean up temporary images from tool call entries
     * Called when entries are removed from current session or on dispose
     */
    private _cleanupTempImagesFromEntries(entries: ToolCallEntry[]): void {
        const tempUris: string[] = [];
        for (const entry of entries) {
            if (entry.attachments) {
                for (const att of entry.attachments) {
                    // Only clean up temporary attachments (pasted/dropped images)
                    if (att.isTemporary && att.uri) {
                        tempUris.push(att.uri);
                    }
                }
            }
        }
        if (tempUris.length > 0) {
            this._cleanupTempImagesByUri(tempUris);
        }
    }

    /**
     * Handle adding attachment via file picker
     */
    private async _handleAddAttachment(): Promise<void> {
        // Use shared exclude pattern
        const excludePattern = formatExcludePattern(FILE_EXCLUSION_PATTERNS);
        const files = await vscode.workspace.findFiles('**/*', excludePattern, this._MAX_FOLDER_SEARCH_RESULTS);

        if (files.length === 0) {
            vscode.window.showInformationMessage('No files found in workspace');
            return;
        }

        const items: (vscode.QuickPickItem & { uri: vscode.Uri })[] = files.map(uri => {
            const relativePath = vscode.workspace.asRelativePath(uri);
            const fileName = path.basename(uri.fsPath);
            return {
                label: `$(file) ${fileName}`,
                description: relativePath,
                uri: uri
            };
        }).sort((a, b) => a.label.localeCompare(b.label));

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select files to attach',
            matchOnDescription: true
        });

        if (selected && selected.length > 0) {
            for (const item of selected) {
                const labelMatch = item.label.match(/\$\([^)]+\)\s*(.+)/);
                const cleanName = labelMatch ? labelMatch[1] : item.label;
                const attachment: AttachmentInfo = {
                    id: `att_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                    name: cleanName,
                    uri: item.uri.toString()
                };
                this._attachments.push(attachment);
            }
            this._updateAttachmentsUI();
        }
    }

    /**
     * Handle removing attachment
     */
    private _handleRemoveAttachment(attachmentId: string): void {
        this._attachments = this._attachments.filter(a => a.id !== attachmentId);
        this._updateAttachmentsUI();
    }

    /**
     * Handle file search for autocomplete (also includes #terminal, #problems context)
     */
    private async _handleSearchFiles(query: string): Promise<void> {
        try {
            const queryLower = query.toLowerCase();
            const cacheKey = queryLower || '__all__';

            // Check cache first (TTL-based)
            const cached = this._fileSearchCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this._FILE_CACHE_TTL_MS) {
                this._broadcast({
                    type: 'fileSearchResults',
                    files: cached.results
                } as ToWebviewMessage);
                return;
            }

            // First, get context suggestions (#terminal, #problems)
            const contextResults: FileSearchResult[] = [];

            // Check if query matches "terminal"
            if (!queryLower || 'terminal'.includes(queryLower)) {
                const commands = this._contextManager.terminal.formatCommandListForAutocomplete();
                const description = commands.length > 0
                    ? `${commands.length} recent commands`
                    : 'No commands yet';
                contextResults.push({
                    name: 'terminal',
                    path: description,
                    uri: 'context://terminal',
                    icon: 'terminal',
                    isFolder: false,
                    isContext: true
                });
            }

            // Check if query matches "problems"
            if (!queryLower || 'problems'.includes(queryLower)) {
                const problemsInfo = this._contextManager.problems.formatForAutocomplete();
                contextResults.push({
                    name: 'problems',
                    path: problemsInfo.description,
                    uri: 'context://problems',
                    icon: 'error',
                    isFolder: false,
                    isContext: true
                });
            }

            // Exclude common unwanted files/folders for cleaner search results
            // Includes: package managers, virtual envs, build outputs, hidden/config files
            const excludePattern = formatExcludePattern(FILE_SEARCH_EXCLUSION_PATTERNS);
            // Reduced from 2000 to _MAX_FILE_SEARCH_RESULTS for better performance
            const allFiles = await vscode.workspace.findFiles('**/*', excludePattern, this._MAX_FILE_SEARCH_RESULTS);

            const seenFolders = new Set<string>();
            const folderResults: FileSearchResult[] = [];

            for (const uri of allFiles) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                const dirPath = path.dirname(relativePath);

                if (dirPath && dirPath !== '.' && !seenFolders.has(dirPath)) {
                    seenFolders.add(dirPath);
                    const folderName = path.basename(dirPath);

                    if (!queryLower || folderName.toLowerCase().includes(queryLower) || dirPath.toLowerCase().includes(queryLower)) {
                        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)?.uri ?? vscode.workspace.workspaceFolders![0].uri;
                        folderResults.push({
                            name: folderName,
                            path: dirPath,
                            uri: vscode.Uri.joinPath(workspaceFolder, dirPath).toString(),
                            icon: 'folder',
                            isFolder: true
                        });
                    }
                }
            }

            const fileResults: FileSearchResult[] = allFiles
                .map(uri => {
                    const relativePath = vscode.workspace.asRelativePath(uri);
                    const fileName = path.basename(uri.fsPath);
                    return {
                        name: fileName,
                        path: relativePath,
                        uri: uri.toString(),
                        icon: this._getFileIcon(fileName),
                        isFolder: false
                    };
                })
                .filter(file => !queryLower || file.name.toLowerCase().includes(queryLower) || file.path.toLowerCase().includes(queryLower));

            // Combine: context results first, then folders, then files
            const fileAndFolderResults = [...folderResults, ...fileResults]
                .sort((a, b) => {
                    if (a.isFolder && !b.isFolder) return -1;
                    if (!a.isFolder && b.isFolder) return 1;
                    const aExact = a.name.toLowerCase().startsWith(queryLower);
                    const bExact = b.name.toLowerCase().startsWith(queryLower);
                    if (aExact && !bExact) return -1;
                    if (!aExact && bExact) return 1;
                    return a.name.localeCompare(b.name);
                })
                .slice(0, 48); // Leave room for context items

            // Context results go first, then files/folders
            const allResults = [...contextResults, ...fileAndFolderResults];

            // Cache results (don't cache context results as they're dynamic)
            this._fileSearchCache.set(cacheKey, { results: fileAndFolderResults, timestamp: Date.now() });
            // Limit cache size to prevent memory bloat
            if (this._fileSearchCache.size > 20) {
                const firstKey = this._fileSearchCache.keys().next().value;
                if (firstKey) this._fileSearchCache.delete(firstKey);
            }

            this._broadcast({
                type: 'fileSearchResults',
                files: allResults
            } as ToWebviewMessage);
        } catch (error) {
            console.error('File search error:', error);
            this._view?.webview.postMessage({
                type: 'fileSearchResults',
                files: []
            } as ToWebviewMessage);
        }
    }

    /**
     * Handle saving pasted/dropped image
     */
    private async _handleSaveImage(dataUrl: string, mimeType: string): Promise<void> {
        const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

        try {
            const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
            if (!base64Match) {
                vscode.window.showWarningMessage('Invalid image format');
                return;
            }

            const base64Data = base64Match[1];

            // SECURITY FIX: Validate base64 size BEFORE decoding to prevent memory spike
            // Base64 encoding increases size by ~33%, so decoded size ≈ base64Length * 0.75
            const estimatedSize = Math.ceil(base64Data.length * 0.75);
            if (estimatedSize > MAX_IMAGE_SIZE_BYTES) {
                const sizeMB = (estimatedSize / (1024 * 1024)).toFixed(2);
                vscode.window.showWarningMessage(`Image too large (~${sizeMB}MB). Max 10MB.`);
                return;
            }

            const buffer = Buffer.from(base64Data, 'base64');

            if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
                const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
                vscode.window.showWarningMessage(`Image too large (${sizeMB}MB). Max 10MB.`);
                return;
            }

            const validMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
            if (!validMimeTypes.includes(mimeType)) {
                vscode.window.showWarningMessage(`Unsupported image type: ${mimeType}`);
                return;
            }

            const extMap: Record<string, string> = {
                'image/png': '.png',
                'image/jpeg': '.jpg',
                'image/gif': '.gif',
                'image/webp': '.webp',
                'image/bmp': '.bmp'
            };
            const ext = extMap[mimeType] || '.png';

            // Use storageUri if available (workspace-specific), otherwise fallback to globalStorageUri
            const storageUri = this._context.storageUri || this._context.globalStorageUri;
            if (!storageUri) {
                throw new Error('VS Code extension storage URI not available. Cannot save temporary images without storage access.');
            }

            const tempDir = path.join(storageUri.fsPath, 'temp-images');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const existingImages = this._attachments.filter(a => a.isTemporary).length;
            let fileName = existingImages === 0 ? `image-pasted${ext}` : `image-pasted-${existingImages}${ext}`;
            let filePath = path.join(tempDir, fileName);

            let counter = existingImages;
            while (fs.existsSync(filePath)) {
                counter++;
                fileName = `image-pasted-${counter}${ext}`;
                filePath = path.join(tempDir, fileName);
            }

            fs.writeFileSync(filePath, buffer);

            const attachment: AttachmentInfo = {
                id: `img_${Date.now()}`,
                name: fileName,
                uri: vscode.Uri.file(filePath).toString(),
                isTemporary: true
            };

            this._attachments.push(attachment);

            this._view?.webview.postMessage({
                type: 'imageSaved',
                attachment
            } as ToWebviewMessage);

            this._updateAttachmentsUI();
        } catch (error) {
            console.error('Failed to save image:', error);
            vscode.window.showErrorMessage('Failed to save pasted image');
        }
    }

    /**
     * Handle adding file reference from autocomplete
     */
    private _handleAddFileReference(file: FileSearchResult): void {
        const attachment: AttachmentInfo = {
            id: `${file.isFolder ? 'folder' : 'file'}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            name: file.name,
            uri: file.uri,
            isFolder: file.isFolder,
            isTextReference: true
        };
        this._attachments.push(attachment);
        this._updateAttachmentsUI();
    }

    /**
     * Update attachments UI
     */
    private _updateAttachmentsUI(): void {
        this._view?.webview.postMessage({
            type: 'updateAttachments',
            attachments: this._attachments
        } as ToWebviewMessage);
    }

    /**
     * Get file icon based on extension
     */
    private _getFileIcon(filename: string): string {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const iconMap: Record<string, string> = {
            'ts': 'file-code', 'tsx': 'file-code', 'js': 'file-code', 'jsx': 'file-code',
            'py': 'file-code', 'java': 'file-code', 'c': 'file-code', 'cpp': 'file-code',
            'html': 'file-code', 'css': 'file-code', 'scss': 'file-code',
            'json': 'json', 'yaml': 'file-code', 'yml': 'file-code',
            'md': 'markdown', 'txt': 'file-text',
            'png': 'file-media', 'jpg': 'file-media', 'jpeg': 'file-media', 'gif': 'file-media', 'svg': 'file-media',
            'sh': 'terminal', 'bash': 'terminal', 'ps1': 'terminal',
            'zip': 'file-zip', 'tar': 'file-zip', 'gz': 'file-zip'
        };
        return iconMap[ext] || 'file';
    }

    /**
     * Handle adding a prompt to queue
     */
    private _handleAddQueuePrompt(prompt: string, id: string, attachments: AttachmentInfo[]): void {
        const trimmed = prompt.trim();
        if (!trimmed || trimmed.length > this._MAX_QUEUE_PROMPT_LENGTH) return;

        const queuedPrompt: QueuedPrompt = {
            id: id || `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            prompt: trimmed,
            attachments: attachments.length > 0 ? [...attachments] : undefined  // Store attachments if any
        };

        // Check if we should auto-respond BEFORE adding to queue (race condition fix)
        // This prevents the window between push and findIndex where queue could be modified
        const shouldAutoRespond = this._queueEnabled &&
            this._currentToolCallId &&
            this._pendingRequests.has(this._currentToolCallId);

        if (shouldAutoRespond) {
            // Don't add to queue - consume directly for the pending request
            const resolve = this._pendingRequests.get(this._currentToolCallId!);
            if (!resolve) return;

            // Update the pending entry to completed
            const pendingEntry = this._currentSessionCallsMap.get(this._currentToolCallId!);

            let completedEntry: ToolCallEntry;
            if (pendingEntry && pendingEntry.status === 'pending') {
                pendingEntry.response = queuedPrompt.prompt;
                pendingEntry.attachments = queuedPrompt.attachments;
                pendingEntry.status = 'completed';
                pendingEntry.isFromQueue = true;
                pendingEntry.timestamp = Date.now();
                completedEntry = pendingEntry;
            } else {
                completedEntry = {
                    id: this._currentToolCallId!,
                    prompt: 'Tool call',
                    response: queuedPrompt.prompt,
                    attachments: queuedPrompt.attachments,
                    timestamp: Date.now(),
                    isFromQueue: true,
                    status: 'completed'
                };
                this._currentSessionCalls.unshift(completedEntry);
                this._currentSessionCallsMap.set(completedEntry.id, completedEntry);
            }

            // Send toolCallCompleted to webview
            this._view?.webview.postMessage({
                type: 'toolCallCompleted',
                entry: completedEntry
            } as ToWebviewMessage);

            this._updateCurrentSessionUI();
            this._saveQueueToDisk();
            this._updateQueueUI();

            resolve({ value: queuedPrompt.prompt, queue: this._queueEnabled && this._promptQueue.length > 0, attachments: queuedPrompt.attachments || [] });
            const resolvedQueueId = this._currentToolCallId!;
            this._pendingRequests.delete(resolvedQueueId);
            this._currentToolCallId = null;
            this._signalNextWaiter();
            this._telegramService?.resolveTask?.(resolvedQueueId);
            this._webexService?.resolveTask?.(resolvedQueueId);
        } else {
            // No pending request - add to queue normally
            this._promptQueue.push(queuedPrompt);
            this._saveQueueToDisk();
            this._updateQueueUI();
        }

        // Clear attachments after adding to queue (they're now stored with the queue item)
        // This prevents old images from reappearing when pasting new images
        this._attachments = [];
        this._updateAttachmentsUI();
    }

    /**
     * Validate queue prompt ID format (defense in depth)
     */
    private _isValidQueueId(id: unknown): id is string {
        return typeof id === 'string' && /^q_\d+_[a-z0-9]+$/.test(id);
    }

    /**
     * Handle removing a prompt from queue
     */
    private _handleRemoveQueuePrompt(promptId: string): void {
        if (!this._isValidQueueId(promptId)) return;
        this._promptQueue = this._promptQueue.filter(p => p.id !== promptId);
        this._saveQueueToDisk();
        this._updateQueueUI();
    }

    /**
     * Handle editing a prompt in queue
     */
    private _handleEditQueuePrompt(promptId: string, newPrompt: string): void {
        if (!this._isValidQueueId(promptId)) return;
        const trimmed = newPrompt.trim();
        if (!trimmed || trimmed.length > this._MAX_QUEUE_PROMPT_LENGTH) return;

        const prompt = this._promptQueue.find(p => p.id === promptId);
        if (prompt) {
            prompt.prompt = trimmed;
            this._saveQueueToDisk();
            this._updateQueueUI();
        }
    }

    /**
     * Handle reordering queue
     */
    private _handleReorderQueue(fromIndex: number, toIndex: number): void {
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
        if (fromIndex < 0 || toIndex < 0) return;
        if (fromIndex >= this._promptQueue.length || toIndex >= this._promptQueue.length) return;

        const [removed] = this._promptQueue.splice(fromIndex, 1);
        this._promptQueue.splice(toIndex, 0, removed);
        this._saveQueueToDisk();
        this._updateQueueUI();
    }

    /**
     * Handle toggling queue enabled state
     */
    private _handleToggleQueue(enabled: boolean): void {
        this._queueEnabled = enabled;
        this._saveQueueToDisk();
        this._updateQueueUI();
    }

    /**
     * Handle clearing the queue
     */
    private _handleClearQueue(): void {
        this._promptQueue = [];
        this._saveQueueToDisk();
        this._updateQueueUI();
    }

    /**
     * Handle removing a history item from persisted history (modal only)
     */
    private _handleRemoveHistoryItem(callId: string): void {
        this._persistedHistory = this._persistedHistory.filter(tc => tc.id !== callId);
        this._updatePersistedHistoryUI();
        this._savePersistedHistoryToDisk();
    }

    /**
     * Handle clearing all persisted history
     */
    private _handleClearPersistedHistory(): void {
        this._persistedHistory = [];
        this._updatePersistedHistoryUI();
        this._savePersistedHistoryToDisk();
    }

    /**
     * Handle opening history modal - send persisted history to webview
     */
    private _handleOpenHistoryModal(): void {
        this._updatePersistedHistoryUI();
    }

    /**
     * Handle opening settings modal - send settings to webview
     */
    private _handleOpenSettingsModal(): void {
        this._updateSettingsUI();
    }

    /**
     * Handle updating sound setting
     */
    private async _handleUpdateSoundSetting(enabled: boolean): Promise<void> {
        this._soundEnabled = enabled;
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('notificationSound', enabled, vscode.ConfigurationTarget.Global);
            // Reload settings after update to ensure consistency
            this._loadSettings();
            // Update UI to reflect the saved state
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /**
     * Handle updating interactive approval setting
     */
    private async _handleUpdateInteractiveApprovalSetting(enabled: boolean): Promise<void> {
        this._interactiveApprovalEnabled = enabled;
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('interactiveApproval', enabled, vscode.ConfigurationTarget.Global);
            // Reload settings after update to ensure consistency
            this._loadSettings();
            // Update UI to reflect the saved state
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /**
     * Handle updating webex enabled setting
     */
    private async _handleUpdateWebexSetting(enabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration('askaway.webex');
            await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
            // The config watcher in extension.ts will call webexService.reloadConfig()
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /**
     * Handle updating autopilot setting
     */
    private async _handleUpdateAutopilotSetting(enabled: boolean): Promise<void> {
        this._autopilotEnabled = enabled;
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('autopilot', enabled, vscode.ConfigurationTarget.Global);
            // Reload settings after update to ensure consistency
            this._loadSettings();
            // Update UI to reflect the saved state
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /**
     * Handle updating telegram enabled setting
     */
    private async _handleUpdateTelegramSetting(enabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration('askaway.telegram');
            await config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
            // The config watcher in extension.ts will call telegramService.reloadConfig()
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /**
     * Handle updating autopilot text
     */
    private async _handleUpdateAutopilotText(text: string): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            const normalizedText = this._normalizeAutopilotText(text, config);
            this._autopilotText = normalizedText;
            await config.update('autopilotText', normalizedText, vscode.ConfigurationTarget.Global);
            // Reload settings after update to ensure consistency
            this._loadSettings();
            // Update UI to reflect the saved state
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateSendWithCtrlEnterSetting(enabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            this._sendWithCtrlEnter = enabled;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('sendWithCtrlEnter', enabled, vscode.ConfigurationTarget.Global);
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateDebugLoggingSetting(enabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const copilotConfig = vscode.workspace.getConfiguration('github.copilot.chat');
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await copilotConfig.update('agentDebugLog.fileLogging.enabled', enabled, target);
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateAutoCompactionDisabled(disabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            // Inverted: checked in the UI means auto-compaction is DISABLED, so we set
            // Copilot's summarizeAgentConversationHistory.enabled to the opposite value.
            const copilotConfig = vscode.workspace.getConfiguration('github.copilot.chat');
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await copilotConfig.update('summarizeAgentConversationHistory.enabled', !disabled, target);
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /** Generic setter for a github.copilot.chat.* value (used by the prompt-cache toggles).
     *  Optionally mirrors the same value to a companion key. */
    private async _handleUpdateCopilotChatSetting(key: string, value: boolean | number, companionKey?: string): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const copilotConfig = vscode.workspace.getConfiguration('github.copilot.chat');
            const target = vscode.workspace.workspaceFolders?.length
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await copilotConfig.update(key, value, target);
            if (companionKey) { await copilotConfig.update(companionKey, value, target); }
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /** Manual "keep-warm" ping. To get a cache HIT the follow-up must land on the SAME agent
     *  conversation (identical system-prompt + tools + history prefix). Copilot's internal probe
     *  reuses its private lastFetchOptions verbatim and is only reachable during sub-agent calls,
     *  so we approximate it WITHOUT changing the agent: fill the CURRENT chat input (isPartialQuery
     *  keeps the active mode/agent) and submit it in place. Opening a fresh `chat.open` turn would
     *  switch to the default agent → different system prompt → cache MISS (the bug being fixed). */
    private async _handlePingCache(): Promise<void> {
        const query = 'keepalive; reply: ok';
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: true });
            await vscode.commands.executeCommand('workbench.action.chat.submit');
        } catch (e) {
            vscode.window.showWarningMessage(
                `AskAway: could not send cache ping in the current agent. The reliable keep-warm is the native ` +
                `"Keep cache warm (sub-agent probes)" + "Extended prompt cache (1 hour)" settings. (${e instanceof Error ? e.message : String(e)})`
            );
        }
    }

    private async _handleUpdateRtkCompressionSetting(enabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        const sentinelPath = path.join(os.homedir(), '.askaway-rtk-enabled');
        try {
            if (enabled && !this.isRtkInstalled()) {
                // rtk isn't installed — refuse to enable so we never prefix `rtk` on a machine without it.
                vscode.window.showWarningMessage('RTK is not installed on this machine. Install the `rtk` CLI to enable command compression.');
                this._updateSettingsUI();
                return;
            }
            if (enabled) {
                await fs.promises.writeFile(sentinelPath, 'enabled\n', 'utf8');
            } else {
                try {
                    await fs.promises.unlink(sentinelPath);
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw err;
                    }
                }
            }
            this._updateSettingsUI();
            void this._broadcastObservabilityMetrics();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateResponseTimeout(value: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('responseTimeout', String(value), vscode.ConfigurationTarget.Global);
            this._loadSettings();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateSessionWarningHours(value: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            this._sessionWarningHours = value;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('sessionWarningHours', value, vscode.ConfigurationTarget.Global);
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateMaxConsecutiveAutoResponses(value: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('maxConsecutiveAutoResponses', value, vscode.ConfigurationTarget.Global);
            this._loadSettings();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateTurnBudgetAiu(value: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const clamped = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('turnBudgetAiu', clamped, vscode.ConfigurationTarget.Global);
            // Keep the budget-hook sentinel in sync so the UserPromptSubmit hook sees the new limit.
            try {
                const cfgDir = path.join(os.homedir(), '.askaway');
                await fs.promises.mkdir(cfgDir, { recursive: true });
                await fs.promises.writeFile(path.join(cfgDir, 'turn-budget-aiu'), `${clamped}\n`, 'utf8');
            } catch { /* non-fatal */ }
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateHumanDelaySetting(enabled: boolean): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            this._humanLikeDelayEnabled = enabled;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('humanLikeDelay', enabled, vscode.ConfigurationTarget.Global);
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateHumanDelayMin(value: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            this._humanLikeDelayMin = value;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('humanLikeDelayMin', value, vscode.ConfigurationTarget.Global);
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleUpdateHumanDelayMax(value: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            this._humanLikeDelayMax = value;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('humanLikeDelayMax', value, vscode.ConfigurationTarget.Global);
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleAddAutopilotPrompt(prompt: string): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const trimmed = prompt.trim();
            if (!trimmed) return;
            this._autopilotPrompts.push(trimmed);
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('autopilotPrompts', this._autopilotPrompts, vscode.ConfigurationTarget.Global);
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleEditAutopilotPrompt(index: number, prompt: string): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            const trimmed = prompt.trim();
            if (!trimmed || index < 0 || index >= this._autopilotPrompts.length) return;
            this._autopilotPrompts[index] = trimmed;
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('autopilotPrompts', this._autopilotPrompts, vscode.ConfigurationTarget.Global);
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleRemoveAutopilotPrompt(index: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            if (index < 0 || index >= this._autopilotPrompts.length) return;
            this._autopilotPrompts.splice(index, 1);
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('autopilotPrompts', this._autopilotPrompts, vscode.ConfigurationTarget.Global);
            // Reset cycling index if needed
            if (this._autopilotIndex >= this._autopilotPrompts.length) {
                this._autopilotIndex = 0;
            }
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    private async _handleReorderAutopilotPrompts(fromIndex: number, toIndex: number): Promise<void> {
        this._isUpdatingConfig = true;
        try {
            if (fromIndex < 0 || fromIndex >= this._autopilotPrompts.length) return;
            if (toIndex < 0 || toIndex >= this._autopilotPrompts.length) return;
            const [moved] = this._autopilotPrompts.splice(fromIndex, 1);
            this._autopilotPrompts.splice(toIndex, 0, moved);
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            await config.update('autopilotPrompts', this._autopilotPrompts, vscode.ConfigurationTarget.Global);
            this._updateSettingsUI();
        } finally {
            this._isUpdatingConfig = false;
        }
    }

    /**
     * Handle adding a reusable prompt
     */
    private async _handleAddReusablePrompt(name: string, prompt: string): Promise<void> {
        const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
        const trimmedPrompt = prompt.trim();

        if (!trimmedName || !trimmedPrompt) return;

        // Check for duplicate names
        if (this._reusablePrompts.some(p => p.name.toLowerCase() === trimmedName)) {
            vscode.window.showWarningMessage(`A prompt with name "/${trimmedName}" already exists.`);
            return;
        }

        const newPrompt: ReusablePrompt = {
            id: `rp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            name: trimmedName,
            prompt: trimmedPrompt
        };

        this._reusablePrompts.push(newPrompt);
        await this._saveReusablePrompts();
        this._updateSettingsUI();
    }

    /**
     * Handle editing a reusable prompt
     */
    private async _handleEditReusablePrompt(id: string, name: string, prompt: string): Promise<void> {
        const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-');
        const trimmedPrompt = prompt.trim();

        if (!trimmedName || !trimmedPrompt) return;

        const existingPrompt = this._reusablePrompts.find(p => p.id === id);
        if (!existingPrompt) return;

        // Check for duplicate names (excluding current prompt)
        if (this._reusablePrompts.some(p => p.id !== id && p.name.toLowerCase() === trimmedName)) {
            vscode.window.showWarningMessage(`A prompt with name "/${trimmedName}" already exists.`);
            return;
        }

        existingPrompt.name = trimmedName;
        existingPrompt.prompt = trimmedPrompt;

        await this._saveReusablePrompts();
        this._updateSettingsUI();
    }

    /**
     * Handle removing a reusable prompt
     */
    private async _handleRemoveReusablePrompt(id: string): Promise<void> {
        this._reusablePrompts = this._reusablePrompts.filter(p => p.id !== id);
        await this._saveReusablePrompts();
        this._updateSettingsUI();
    }

    /**
     * Handle searching slash commands for autocomplete
     */
    private _handleSearchSlashCommands(query: string): void {
        const queryLower = query.toLowerCase();
        const matchingPrompts = this._reusablePrompts.filter(p =>
            p.name.toLowerCase().includes(queryLower) ||
            p.prompt.toLowerCase().includes(queryLower)
        );

        this._view?.webview.postMessage({
            type: 'slashCommandResults',
            prompts: matchingPrompts
        } as ToWebviewMessage);
    }

    /**
     * Handle searching context references (#terminal, #problems) - deprecated, now handled via file search
     */
    private async _handleSearchContext(query: string): Promise<void> {
        try {
            const suggestions = await this._contextManager.getContextSuggestions(query);
            this._view?.webview.postMessage({
                type: 'contextSearchResults',
                suggestions: suggestions.map(s => ({
                    type: s.type,
                    label: s.label,
                    description: s.description,
                    detail: s.detail
                }))
            } as ToWebviewMessage);
        } catch (error) {
            console.error('[TaskSync] Error searching context:', error);
            this._view?.webview.postMessage({
                type: 'contextSearchResults',
                suggestions: []
            } as ToWebviewMessage);
        }
    }

    /**
     * Handle selecting a context reference to add as attachment
     */
    private async _handleSelectContextReference(contextType: string, options?: Record<string, unknown>): Promise<void> {
        try {
            const reference = await this._contextManager.getContextContent(
                contextType as ContextReferenceType,
                options
            );

            if (reference) {
                // Add context reference as a special attachment
                const contextAttachment: AttachmentInfo = {
                    id: reference.id,
                    name: reference.label,
                    uri: `context://${reference.type}/${reference.id}`,
                    isTextReference: true
                };
                this._attachments.push(contextAttachment);
                this._updateAttachmentsUI();

                // Also send the reference content so it can be displayed
                this._view?.webview.postMessage({
                    type: 'contextReferenceAdded',
                    reference: {
                        id: reference.id,
                        type: reference.type,
                        label: reference.label,
                        content: reference.content
                    }
                } as ToWebviewMessage);
            } else {
                // Still add a placeholder attachment showing it was selected but empty
                const emptyId = `ctx_empty_${Date.now()}`;
                const friendlyType = contextType.replace(':', ' ');
                const contextAttachment: AttachmentInfo = {
                    id: emptyId,
                    name: `#${friendlyType} (no content)`,
                    uri: `context://${contextType}/${emptyId}`,
                    isTextReference: true
                };
                this._attachments.push(contextAttachment);
                this._updateAttachmentsUI();

                // Show info message
                vscode.window.showInformationMessage(`No ${contextType} content available yet`);
            }
        } catch (error) {
            console.error('[TaskSync] Error selecting context reference:', error);
            vscode.window.showErrorMessage(`Failed to get ${contextType} content`);
        }
    }

    /**
     * Resolve context content from a context URI
     * URI format: context://type/id
     */
    public async resolveContextContent(uri: string): Promise<string | undefined> {
        try {
            const parsed = vscode.Uri.parse(uri);
            if (parsed.scheme !== 'context') return undefined;

            const type = parsed.authority as ContextReferenceType;
            // id is likely in path, e.g. /id
            const id = parsed.path.startsWith('/') ? parsed.path.substring(1) : parsed.path;

            const contextRef = await this._contextManager.getContextContent(type);
            return contextRef?.content;

        } catch (error) {
            console.error('[TaskSync] Error resolving context content:', error);
            return undefined;
        }
    }

    /**
     * Update queue UI in webview
     */
    private _updateQueueUI(): void {
        this._broadcast({
            type: 'updateQueue',
            queue: this._promptQueue,
            enabled: this._queueEnabled
        });
    }

    /**
     * Update current session UI in webview (cards in chat)
     */
    private _updateCurrentSessionUI(): void {
        this._broadcast({
            type: 'updateCurrentSession',
            history: this._currentSessionCalls
        });
    }

    /**
     * Update persisted history UI in webview (for modal)
     */
    private _updatePersistedHistoryUI(): void {
        this._broadcast({
            type: 'updatePersistedHistory',
            history: this._persistedHistory
        });
    }

    /**
     * Load queue from disk
     */
    private async _loadQueueFromDiskAsync(): Promise<void> {
        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const queuePath = path.join(storagePath, 'queue.json');

            // Check if file exists using async
            try {
                await fs.promises.access(queuePath, fs.constants.F_OK);
            } catch {
                // File doesn't exist, use defaults
                this._promptQueue = [];
                this._queueEnabled = true;
                return;
            }

            const data = await fs.promises.readFile(queuePath, 'utf8');
            const parsed = JSON.parse(data);
            this._promptQueue = Array.isArray(parsed.queue) ? parsed.queue : [];
            this._queueEnabled = parsed.enabled === true;
        } catch (error) {
            console.error('Failed to load queue:', error);
            this._promptQueue = [];
            this._queueEnabled = true; // Default to queue mode
        }
    }

    /**
     * Save queue to disk (debounced)
     */
    private _saveQueueToDisk(): void {
        if (this._queueSaveTimer) {
            clearTimeout(this._queueSaveTimer);
        }
        this._queueSaveTimer = setTimeout(() => {
            this._saveQueueToDiskAsync();
        }, this._QUEUE_SAVE_DEBOUNCE_MS);
    }

    /**
     * Actually persist queue to disk
     */
    private async _saveQueueToDiskAsync(): Promise<void> {
        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const queuePath = path.join(storagePath, 'queue.json');

            if (!fs.existsSync(storagePath)) {
                await fs.promises.mkdir(storagePath, { recursive: true });
            }

            const data = JSON.stringify({
                queue: this._promptQueue,
                enabled: this._queueEnabled
            }, null, 2);

            await fs.promises.writeFile(queuePath, data, 'utf8');
        } catch (error) {
            console.error('Failed to save queue:', error);
        }
    }

    /**
     * Load persisted history from disk (past sessions only) - ASYNC to not block activation
     */
    private async _loadPersistedHistoryFromDiskAsync(): Promise<void> {
        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const historyPath = path.join(storagePath, 'tool-history.json');

            // Check if file exists using async stat
            try {
                await fs.promises.access(historyPath, fs.constants.F_OK);
            } catch {
                // File doesn't exist, use empty history
                this._persistedHistory = [];
                return;
            }

            const data = await fs.promises.readFile(historyPath, 'utf8');
            const parsed = JSON.parse(data);
            // Only load completed entries from past sessions, enforce max limit
            this._persistedHistory = Array.isArray(parsed.history)
                ? parsed.history
                    .filter((entry: ToolCallEntry) => entry.status === 'completed')
                    .slice(0, this._MAX_HISTORY_ENTRIES)
                : [];
        } catch (error) {
            console.error('[TaskSync] Failed to load persisted history:', error);
            this._persistedHistory = [];
        }
    }

    /**
     * Save persisted history to disk with debounced async write
     * Uses background async saves to avoid blocking the main thread
     */
    private _savePersistedHistoryToDisk(): void {
        this._historyDirty = true;

        // Cancel any pending save
        if (this._historySaveTimer) {
            clearTimeout(this._historySaveTimer);
        }

        // Schedule debounced async save
        this._historySaveTimer = setTimeout(() => {
            this._savePersistedHistoryToDiskAsync();
        }, this._HISTORY_SAVE_DEBOUNCE_MS);
    }

    /**
     * Async save persisted history (non-blocking background save)
     */
    private async _savePersistedHistoryToDiskAsync(): Promise<void> {
        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const historyPath = path.join(storagePath, 'tool-history.json');

            // Use async fs operations from fs/promises
            const fsPromises = await import('fs/promises');

            try {
                await fsPromises.access(storagePath);
            } catch {
                await fsPromises.mkdir(storagePath, { recursive: true });
            }

            // Only save completed entries
            const completedHistory = this._persistedHistory.filter(entry => entry.status === 'completed');

            const data = JSON.stringify({
                history: completedHistory
            }, null, 2);

            await fsPromises.writeFile(historyPath, data, 'utf8');
            this._historyDirty = false;
        } catch (error) {
            console.error('[TaskSync] Failed to save persisted history (async):', error);
        }
    }

    /**
     * Actually persist history to disk (synchronous - only for deactivate)
     * Called during extension deactivation when async operations cannot complete
     */
    private _savePersistedHistoryToDiskSync(): void {
        // Only save if there are pending changes
        if (!this._historyDirty) return;

        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const historyPath = path.join(storagePath, 'tool-history.json');

            if (!fs.existsSync(storagePath)) {
                fs.mkdirSync(storagePath, { recursive: true });
            }

            // Only save completed entries
            const completedHistory = this._persistedHistory.filter(entry => entry.status === 'completed');

            const data = JSON.stringify({
                history: completedHistory
            }, null, 2);

            fs.writeFileSync(historyPath, data, 'utf8');
            this._historyDirty = false;
        } catch (error) {
            console.error('[TaskSync] Failed to save persisted history:', error);
        }
    }

    /**
     * Generate HTML content for webview
     */
    private _getHtmlContent(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js'));
        const cacheBust = String(Date.now());
        const styleUriWithVersion = `${styleUri}?v=${cacheBust}`;
        const scriptUriWithVersion = `${scriptUri}?v=${cacheBust}`;
        const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'askaway-icon.svg'));
        const notificationSoundUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'notification.wav'));
        const nonce = this._getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; media-src ${webview.cspSource} data: mediastream:;">
    <link href="${codiconsUri}" rel="stylesheet">
    <link href="${styleUriWithVersion}" rel="stylesheet">
    <title>AskAway</title>
    <audio id="notification-sound" preload="auto" src="${notificationSoundUri}"></audio>
</head>
<body>
    <div class="main-container">
        <!-- Tab Bar -->
        <div class="widget-tabs" id="widget-tabs">
            <button class="widget-tab active" data-tab="chat" title="Main chat">Chat</button>
            <button class="widget-tab" data-tab="observability" title="Observability metrics, RTK/Gradle savings, requests and memories">Metrics</button>
            <button class="widget-tab" data-tab="settings" title="Settings">Settings</button>
        </div>

        <!-- Chat Panel -->
        <div class="tab-panel active" id="panel-chat">
        <!-- Chat Container -->
        <div class="chat-container" id="chat-container">
            <!-- Welcome Section - Let's build -->
            <div class="welcome-section" id="welcome-section">
                <div class="welcome-icon">
                    <img src="${logoUri}" alt="AskAway Logo" width="48" height="48" class="welcome-logo">
                </div>
                <h1 class="welcome-title">Let's build</h1>
                <p class="welcome-subtitle">Sync your tasks, automate your workflow</p>
                
                <div class="welcome-cards">
                    <div class="welcome-card welcome-card-vibe" id="card-vibe">
                        <div class="welcome-card-header">
                            <span class="codicon codicon-comment-discussion"></span>
                            <span class="welcome-card-title">Normal</span>
                        </div>
                        <p class="welcome-card-desc">Respond to each AI request directly. Full control over every interaction.</p>
                    </div>
                    <div class="welcome-card welcome-card-spec" id="card-spec">
                        <div class="welcome-card-header">
                            <span class="codicon codicon-layers"></span>
                            <span class="welcome-card-title">Queue</span>
                        </div>
                        <p class="welcome-card-desc">Batch your responses. AI consumes from queue automatically, one by one.</p>
                    </div>
                    <div class="welcome-card welcome-card-plan" id="card-plan">
                        <div class="welcome-card-header">
                            <span class="codicon codicon-project"></span>
                            <span class="welcome-card-title">Plan</span>
                        </div>
                        <p class="welcome-card-desc">Orchestrate tasks like a Trello board. AI picks tasks, reports progress, auto-advances.</p>
                    </div>
                </div>

                <p class="welcome-autopilot-info"> Tip: Enable <strong>Autopilot</strong> to automatically respond to ask_user prompts without waiting for your input, using a customizable prompt you can configure in Settings.<br>Queued prompts always take priority over Autopilot responses.</p>
            </div>

            <!-- Tool Call History Area -->
            <div class="tool-history-area" id="tool-history-area"></div>

            <!-- Pending Tool Call Message -->
            <div class="pending-message hidden" id="pending-message"></div>
        </div>

        <!-- Combined Input Wrapper (Queue + Input) -->
        <div class="input-area-container" id="input-area-container">
            <!-- File Autocomplete Dropdown - positioned outside input-wrapper to avoid clipping -->
            <div class="autocomplete-dropdown hidden" id="autocomplete-dropdown">
                <div class="autocomplete-list" id="autocomplete-list"></div>
                <div class="autocomplete-empty hidden" id="autocomplete-empty">No files found</div>
            </div>
            <!-- Slash Command Autocomplete Dropdown -->
            <div class="slash-dropdown hidden" id="slash-dropdown">
                <div class="slash-list" id="slash-list"></div>
                <div class="slash-empty hidden" id="slash-empty">No prompts found. Add prompts in Settings.</div>
            </div>
            <div class="input-wrapper" id="input-wrapper">
            <!-- Prompt Queue Section - Integrated above input -->
            <div class="queue-section" id="queue-section" role="region" aria-label="Prompt queue">
                <div class="queue-header" id="queue-header" role="button" tabindex="0" aria-expanded="true" aria-controls="queue-list">
                    <div class="accordion-icon" aria-hidden="true">
                        <span class="codicon codicon-chevron-down"></span>
                    </div>
                    <span class="queue-header-title">Prompt Queue</span>
                    <span class="queue-count" id="queue-count" aria-live="polite">0</span>
                </div>
                <div class="queue-list" id="queue-list" role="list" aria-label="Queued prompts">
                    <div class="queue-empty" role="status">No prompts in queue</div>
                </div>
            </div>

            <!-- Input Area -->
            <div class="input-container" id="input-container">
            <!-- Attachment Chips INSIDE input container -->
            <div class="chips-container hidden" id="chips-container"></div>
            <div class="input-row">
                <div class="input-highlighter-wrapper">
                    <div class="input-highlighter" id="input-highlighter" aria-hidden="true"></div>
                    <textarea id="chat-input" placeholder="Reply to tool call. (use # for files, / for prompts)" rows="1" aria-label="Message input. Use # for file references, / for saved prompts"></textarea>
                </div>
            </div>
            <div class="actions-bar">
                <div class="actions-left">
                    <button id="attach-btn" class="icon-btn" title="Add attachment (+)" aria-label="Add attachment">
                        <span class="codicon codicon-add"></span>
                    </button>
                    <div class="mode-selector" id="mode-selector">
                        <button id="mode-btn" class="mode-btn" title="Select mode" aria-label="Select mode">
                            <span id="mode-label">Queue</span>
                            <span class="codicon codicon-chevron-down"></span>
                        </button>
                    </div>
                </div>
                <div class="actions-right">
                    <span class="autopilot-label">Autopilot</span>
                    <div class="toggle-switch" id="autopilot-toggle" role="switch" aria-checked="false" aria-label="Enable Autopilot mode" tabindex="0"></div>
                    <button id="mic-btn" class="icon-btn" title="Voice mode (talk to Copilot)" aria-label="Voice mode">
                        <span class="codicon codicon-mic"></span>
                    </button>
                    <button id="send-btn" title="Send message" aria-label="Send message">
                        <span class="codicon codicon-arrow-up"></span>
                    </button>
                </div>
            </div>
        </div>
        <!-- Mode Dropdown - positioned outside input-container to avoid clipping -->
        <div class="mode-dropdown hidden" id="mode-dropdown">
            <div class="mode-option" data-mode="normal">
                <span class="codicon codicon-comment-discussion"></span>
                <span>Normal</span>
            </div>
            <div class="mode-option" data-mode="queue">
                <span class="codicon codicon-layers"></span>
                <span>Queue</span>
            </div>
            <div class="mode-option" data-mode="plan">
                <span class="codicon codicon-project"></span>
                <span>Plan (Experimental)</span>
            </div>
        </div>
        </div><!-- End input-wrapper -->
        </div><!-- End input-area-container -->

        <!-- Plan Board — Opens in editor tab -->
        <div class="plan-board hidden" id="plan-board">
            <div class="plan-board-header">
                <div class="plan-board-title-area">
                    <span class="codicon codicon-project"></span>
                    <span class="plan-board-title">Plan Mode Active (Experimental)</span>
                </div>
            </div>
            <div class="plan-board-open-area">
                <p class="plan-board-desc">Orchestrate tasks on the full-screen planning board. Add tasks, let Copilot execute them, and track progress visually.</p>
                <button class="plan-btn plan-btn-start" id="plan-open-board-btn" title="Open full Plan Board in editor tab">
                    <span class="codicon codicon-project"></span> Open Plan Board
                </button>
            </div>
        </div>
        </div><!-- End panel-chat -->

        <!-- Commands Panel -->
        <div class="tab-panel" id="panel-commands">
            <div class="worker-panel-header">
                <span class="worker-panel-title">Command Queue</span>
                <span class="worker-panel-hint">Delegated agentic processing</span>
            </div>
            <div class="worker-task-list" id="command-task-list">
                <div class="worker-empty">No pending commands</div>
            </div>
            <div class="worker-input-area">
                <div class="worker-task-display hidden" id="command-task-display">
                    <div class="worker-task-label">Command to run:</div>
                    <div class="worker-task-text" id="command-task-text"></div>
                </div>
                <!-- Model + Effort row -->
                <div class="worker-model-config-row">
                    <select class="worker-model-select" id="command-model-select" title="Model — deduplicated from VS Code LM API">
                        <option value="">Loading models…</option>
                    </select>
                    <select class="worker-effort-select" id="command-effort-select" title="Effort hint sent in system prompt">
                        <option value="low">Low</option>
                        <option value="medium" selected>Medium</option>
                        <option value="high">High</option>
                    </select>
                </div>
                <!-- Formed label + Agent + Autopilot toggle -->
                <div class="worker-run-controls">
                    <span class="worker-formed-model" id="command-formed-model">—</span>
                    <select class="worker-agent-select" id="command-agent-select" title="Agent profile">
                        <option value="default">Default</option>
                        <option value="Explore">Explore</option>
                        <option value="ts">ts</option>
                        <option value="talk_to_user">talk_to_user</option>
                    </select>
                    <label class="worker-autopilot-label" title="Auto-run queued tasks without manual trigger">
                        <span class="worker-auto-text">Auto</span>
                        <div class="toggle-switch worker-autopilot-toggle" id="command-autopilot-toggle" role="switch" aria-checked="false" tabindex="0"></div>
                    </label>
                </div>
                <!-- Per-panel tool picker (independent of global Copilot tool config) -->
                <div class="worker-tools-panel" id="command-tools-panel">
                    <button class="worker-tools-header-btn" id="command-tools-header-btn" aria-expanded="false">
                        <span class="codicon codicon-tools"></span>
                        <span class="worker-tools-label" id="command-tools-label">Tools: loading…</span>
                        <span class="worker-tools-scope-badge">per-panel</span>
                        <span class="codicon codicon-chevron-right worker-tools-chevron" id="command-tools-chevron"></span>
                    </button>
                    <div class="worker-tools-body hidden" id="command-tools-body"></div>
                </div>
                <textarea class="worker-response-input" id="command-response-input" placeholder="Optional: override with manual result…" rows="2"></textarea>
                <div class="worker-actions">
                    <button class="worker-btn worker-run-btn" id="command-autopilot-btn" title="Run with selected model">
                        <span class="codicon codicon-zap"></span> Run
                    </button>
                    <button class="worker-btn worker-submit-btn" id="command-submit-btn" title="Submit manual response">
                        <span class="codicon codicon-arrow-up"></span> Submit
                    </button>
                </div>
            </div>
        </div><!-- End panel-commands -->

        <!-- Sub-Agents Panel -->
        <div class="tab-panel" id="panel-subagents">
            <div class="worker-panel-header">
                <span class="worker-panel-title">Agent Queue</span>
                <span class="worker-panel-hint">Agentic tasks with model and tool selection</span>
            </div>
            <div class="worker-task-list" id="subagent-task-list">
                <div class="worker-empty">No pending agent tasks</div>
            </div>
            <div class="worker-input-area">
                <div class="worker-task-display hidden" id="subagent-task-display">
                    <div class="worker-task-label">Task:</div>
                    <div class="worker-task-text" id="subagent-task-text"></div>
                </div>
                <!-- Model + Effort row -->
                <div class="worker-model-config-row">
                    <select class="worker-model-select" id="subagent-model-select" title="Model — deduplicated from VS Code LM API">
                        <option value="">Loading models…</option>
                    </select>
                    <select class="worker-effort-select" id="subagent-effort-select" title="Effort hint sent in system prompt">
                        <option value="low">Low</option>
                        <option value="medium" selected>Medium</option>
                        <option value="high">High</option>
                    </select>
                </div>
                <!-- Formed label + Agent + Autopilot toggle -->
                <div class="worker-run-controls">
                    <span class="worker-formed-model" id="subagent-formed-model">—</span>
                    <select class="worker-agent-select" id="subagent-agent-select" title="Agent profile">
                        <option value="default">Default</option>
                        <option value="Explore">Explore</option>
                        <option value="ts">ts</option>
                        <option value="talk_to_user">talk_to_user</option>
                    </select>
                    <label class="worker-autopilot-label" title="Auto-run queued tasks without manual trigger">
                        <span class="worker-auto-text">Auto</span>
                        <div class="toggle-switch worker-autopilot-toggle" id="subagent-autopilot-toggle" role="switch" aria-checked="false" tabindex="0"></div>
                    </label>
                </div>
                <!-- Per-panel tool picker (independent of global Copilot tool config) -->
                <div class="worker-tools-panel" id="subagent-tools-panel">
                    <button class="worker-tools-header-btn" id="subagent-tools-header-btn" aria-expanded="false">
                        <span class="codicon codicon-tools"></span>
                        <span class="worker-tools-label" id="subagent-tools-label">Tools: loading…</span>
                        <span class="worker-tools-scope-badge">per-panel</span>
                        <span class="codicon codicon-chevron-right worker-tools-chevron" id="subagent-tools-chevron"></span>
                    </button>
                    <div class="worker-tools-body hidden" id="subagent-tools-body"></div>
                </div>
                <textarea class="worker-response-input" id="subagent-response-input" placeholder="Or type manual response…" rows="2"></textarea>
                <div class="worker-actions">
                    <button class="worker-btn worker-run-btn" id="subagent-autopilot-btn" title="Run with selected model">
                        <span class="codicon codicon-zap"></span> Run
                    </button>
                    <button class="worker-btn worker-submit-btn" id="subagent-submit-btn" title="Submit manual response">
                        <span class="codicon codicon-arrow-up"></span> Submit
                    </button>
                </div>
            </div>
        </div><!-- End panel-subagents -->

        <!-- Observability Panel -->
        <div class="tab-panel" id="panel-observability">
            <div class="settings-tab-shell" id="observability-tab-shell"></div>
        </div><!-- End panel-observability -->

        <!-- Settings Panel -->
        <div class="tab-panel" id="panel-settings">
            <div class="settings-tab-shell" id="settings-tab-shell"></div>
        </div><!-- End panel-settings -->

        <!-- Voice Mode Overlay -->
        <div id="voice-overlay" class="voice-overlay hidden">
            <div class="voice-content">
                <div class="voice-question" id="voice-question"></div>
                <canvas id="voice-waveform" class="voice-waveform" width="280" height="80"></canvas>
                <div class="voice-status voice-status-speaking" id="voice-status">Initializing…</div>

                <!-- Skip button — interrupt TTS and go straight to input -->
                <button id="voice-skip-btn" class="voice-skip-btn" title="Skip to input">
                    <span class="codicon codicon-debug-step-over"></span> Skip
                </button>

                <div class="voice-transcript" id="voice-transcript"></div>

                <!-- Input area — type or use macOS dictation (Fn+Fn) -->
                <div id="voice-input-area" class="voice-input-area hidden">
                    <textarea id="voice-text-input" placeholder="Speak (press Fn twice for dictation) or type your response…" rows="2"></textarea>
                    <div class="voice-input-actions">
                        <button id="voice-cancel-btn" class="voice-btn voice-cancel" title="Cancel">
                            <span class="codicon codicon-close"></span>
                        </button>
                        <button id="voice-send-btn" class="voice-btn voice-send" title="Send response">
                            <span class="codicon codicon-send"></span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUriWithVersion}"></script>
</body>
</html>`;
    }

    /**
     * ── Plan Mode Methods ──
     */

    /**
     * Handle plan task status update from Copilot via ask_user tool.
     * Called when Copilot includes taskId + taskStatus in the tool call.
     * Delegates to PlanEditorProvider if available (editor tab board).
     * Returns auto-response (next task prompt) or null to fall through to normal ask_user flow.
     */
    public async handlePlanTaskUpdate(
        taskId: string,
        taskStatus: PlanTaskStatus,
        question: string,
        token: vscode.CancellationToken
    ): Promise<{ response: string } | null> {
        // Delegate to the editor-tab PlanEditorProvider if available
        if (this._planEditor) {
            return this._planEditor.handleTaskUpdate(taskId, taskStatus, question);
        }

        if (!this._planEnabled || !this._currentPlan) {
            return null; // Not in plan mode, fall through to normal flow
        }

        const task = findTaskById(this._currentPlan.tasks, taskId);
        if (!task) {
            console.warn(`[AskAway] Plan task ${taskId} not found`);
            return null; // Unknown task, fall through
        }

        // Update task status
        task.status = taskStatus;
        task.completionNote = question;
        task.updatedAt = Date.now();
        this._currentPlan.updatedAt = Date.now();

        // Notify webview of status change
        this._broadcast({ type: 'planTaskStatusChanged', taskId, status: taskStatus, note: question });
        this._broadcastPlanUpdate();

        // ── Decision logic ──
        if (taskStatus === 'completed') {
            if (task.requiresReview) {
                // Needs user review — block and wait
                task.status = 'need-review';
                this._broadcast({ type: 'planTaskStatusChanged', taskId, status: 'need-review', note: question });
                this._broadcastPlanUpdate();

                // Wait for user review (approve/reject via webview)
                return new Promise<{ response: string }>((resolve) => {
                    this._planPendingReview.set(taskId, { resolve: (response: string) => resolve({ response }) });
                });
            }

            if (this._currentPlan.autoAdvance && this._planExecuting) {
                // Auto-advance to next task
                const nextTask = getNextPendingTask(this._currentPlan.tasks);
                if (nextTask) {
                    // Mark next task as in-progress
                    nextTask.status = 'in-progress';
                    nextTask.updatedAt = Date.now();
                    this._currentPlan.activeTaskId = nextTask.id;
                    this._broadcastPlanUpdate();
                    this._broadcast({ type: 'planAutoAdvancing', taskId, nextTaskId: nextTask.id, nextTaskTitle: nextTask.title });

                    // Return the next task as the auto-response
                    return {
                        response: this._formatTaskPrompt(nextTask)
                    };
                } else {
                    // All tasks completed!
                    this._planExecuting = false;
                    this._currentPlan.activeTaskId = null;
                    this._broadcastPlanUpdate();
                    this._broadcast({ type: 'planExecutionPaused' });
                    return {
                        response: 'All planned tasks have been completed! 🎉'
                    };
                }
            }

            // Not auto-advancing — fall through to ask user
            return null;
        }

        if (taskStatus === 'blocked' || taskStatus === 'need-review') {
            // Copilot is stuck or needs review — always show to user
            return null;
        }

        if (taskStatus === 'in-progress') {
            // Interim update — let it through as normal ask_user
            return null;
        }

        return null;
    }

    /** Format a task's description into a focused prompt for Copilot */
    private _formatTaskPrompt(task: PlanTask): string {
        let prompt = `📋 **Plan Task [${task.id}]**\n\n`;
        prompt += `**Task:** ${task.title}\n\n`;
        prompt += `**Instructions:**\n${task.description}\n\n`;
        prompt += `**Important:** When you call \`ask_user\`, include \`taskId: "${task.id}"\` and your assessment of \`taskStatus\` (completed, in-progress, blocked, or need-review). `;
        prompt += `This allows the orchestrator to track your progress and auto-advance to the next task.`;

        if (task.subtasks.length > 0) {
            prompt += `\n\n**Subtasks:**\n`;
            for (const sub of task.subtasks) {
                const icon = sub.status === 'completed' ? '✅' : sub.status === 'in-progress' ? '🔄' : '⬜';
                prompt += `${icon} ${sub.title}\n`;
            }
        }

        return prompt;
    }

    /** Broadcast full plan state to webview */
    private _broadcastPlanUpdate(): void {
        this._broadcast({ type: 'updatePlan', plan: this._currentPlan });
        this._savePlanToDisk();
    }

    /** Save plan to disk for persistence */
    private _savePlanToDisk(): void {
        if (!this._currentPlan) { return; }
        try {
            const storageDir = this._getStoragePath();
            if (!storageDir) { return; }
            const planPath = path.join(storageDir, 'plan.json');
            fs.writeFileSync(planPath, JSON.stringify(this._currentPlan, null, 2));
        } catch (err) {
            console.error('[AskAway] Failed to save plan:', err);
        }
    }

    /** Load plan from disk */
    private _loadPlanFromDisk(): void {
        try {
            const storageDir = this._getStoragePath();
            if (!storageDir) { return; }
            const planPath = path.join(storageDir, 'plan.json');
            if (fs.existsSync(planPath)) {
                const data = fs.readFileSync(planPath, 'utf-8');
                this._currentPlan = JSON.parse(data) as Plan;
            }
        } catch (err) {
            console.error('[AskAway] Failed to load plan:', err);
        }
    }

    /** Get extension storage path */
    private _getStoragePath(): string | undefined {
        // Use workspace storage or global storage
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            const storagePath = path.join(folders[0].uri.fsPath, '.askaway');
            if (!fs.existsSync(storagePath)) {
                fs.mkdirSync(storagePath, { recursive: true });
            }
            return storagePath;
        }
        return undefined;
    }

    // ── Plan message handlers ──

    private _handlePlanSetMode(enabled: boolean): void {
        this._planEnabled = enabled;
        if (enabled && !this._currentPlan) {
            this._currentPlan = createPlan('My Plan');
            this._loadPlanFromDisk(); // Restore from disk if available
        }
        this._broadcastPlanUpdate();
        // Re-enqueue the active task when switching back to plan mode
        if (enabled && this._planEditor) {
            this._planEditor.reEnqueueActiveTask();
        }
    }

    private _handlePlanAddTask(title: string, description: string, requiresReview: boolean, afterTaskId?: string): void {
        if (!this._currentPlan) { return; }

        const order = this._currentPlan.tasks.length;
        const task = createTask(title, description, order, requiresReview);

        if (afterTaskId) {
            const idx = this._currentPlan.tasks.findIndex(t => t.id === afterTaskId);
            if (idx >= 0) {
                this._currentPlan.tasks.splice(idx + 1, 0, task);
                // Re-index orders
                this._currentPlan.tasks.forEach((t, i) => t.order = i);
            } else {
                this._currentPlan.tasks.push(task);
            }
        } else {
            this._currentPlan.tasks.push(task);
        }

        this._broadcastPlanUpdate();
    }

    private _handlePlanEditTask(taskId: string, title: string, description: string, requiresReview: boolean): void {
        if (!this._currentPlan) { return; }
        const task = findTaskById(this._currentPlan.tasks, taskId);
        if (task) {
            task.title = title;
            task.description = description;
            task.requiresReview = requiresReview;
            task.updatedAt = Date.now();
            this._broadcastPlanUpdate();
        }
    }

    private _handlePlanDeleteTask(taskId: string): void {
        if (!this._currentPlan) { return; }
        this._currentPlan.tasks = this._currentPlan.tasks.filter(t => t.id !== taskId);
        // Also clean subtask references
        for (const task of this._currentPlan.tasks) {
            task.subtasks = task.subtasks.filter(s => s.id !== taskId);
        }
        // Re-index
        this._currentPlan.tasks.forEach((t, i) => t.order = i);
        this._broadcastPlanUpdate();
    }

    private _handlePlanReorderTask(taskId: string, newOrder: number): void {
        if (!this._currentPlan) { return; }
        const idx = this._currentPlan.tasks.findIndex(t => t.id === taskId);
        if (idx < 0) { return; }
        const [task] = this._currentPlan.tasks.splice(idx, 1);
        this._currentPlan.tasks.splice(newOrder, 0, task);
        this._currentPlan.tasks.forEach((t, i) => t.order = i);
        this._broadcastPlanUpdate();
    }

    private async _handlePlanSplitTask(taskId: string): Promise<void> {
        if (!this._currentPlan) { return; }
        const task = findTaskById(this._currentPlan.tasks, taskId);
        if (!task) { return; }

        try {
            // Use VS Code's Language Model API to split the task
            const models = await vscode.lm.selectChatModels({ family: 'gpt-4o-mini' });
            const model = models[0];
            if (!model) {
                vscode.window.showWarningMessage('No language model available for task splitting. Add subtasks manually.');
                return;
            }

            const systemPrompt = `You are a task planner. Given a software development task, break it into 3-7 concrete subtasks. 
Return ONLY a JSON array of objects with "title" and "description" fields. No markdown, no explanation.
Example: [{"title": "Create data model", "description": "Define TypeScript interfaces for..."}]`;

            const userPrompt = `Split this task into subtasks:\n\nTitle: ${task.title}\nDescription: ${task.description}`;

            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(userPrompt)
            ];

            const response = await model.sendRequest(messages);
            let fullResponse = '';
            for await (const chunk of response.text) {
                fullResponse += chunk;
            }

            // Parse the JSON response
            const jsonMatch = fullResponse.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const subtasks = JSON.parse(jsonMatch[0]) as Array<{ title: string; description: string }>;
                // Send to webview for user review before accepting
                this._broadcast({
                    type: 'updatePlan',
                    plan: {
                        ...this._currentPlan,
                        // Temporarily inject proposed subtasks for preview
                        _proposedSplit: { taskId, subtasks }
                    } as any
                });
            } else {
                vscode.window.showWarningMessage('Could not parse subtasks from AI response. Try again or add manually.');
            }
        } catch (err) {
            console.error('[AskAway] Task split error:', err);
            vscode.window.showErrorMessage('Failed to split task: ' + (err instanceof Error ? err.message : 'Unknown error'));
        }
    }

    private _handlePlanAcceptSplit(taskId: string, subtaskDefs: Array<{ title: string; description: string }>): void {
        if (!this._currentPlan) { return; }
        const task = findTaskById(this._currentPlan.tasks, taskId);
        if (!task) { return; }

        // Create subtasks
        task.subtasks = subtaskDefs.map((def, i) =>
            createTask(def.title, def.description, i, false, taskId)
        );
        task.updatedAt = Date.now();
        this._broadcastPlanUpdate();
    }

    private _handlePlanReviewApprove(taskId: string): void {
        if (!this._currentPlan) { return; }
        const task = findTaskById(this._currentPlan.tasks, taskId);
        if (task) {
            task.status = 'completed';
            task.updatedAt = Date.now();
        }

        // Resolve pending review promise
        const pending = this._planPendingReview.get(taskId);
        if (pending) {
            // Find next task and auto-advance
            const nextTask = getNextPendingTask(this._currentPlan.tasks);
            if (nextTask && this._planExecuting) {
                nextTask.status = 'in-progress';
                nextTask.updatedAt = Date.now();
                this._currentPlan.activeTaskId = nextTask.id;
                pending.resolve(this._formatTaskPrompt(nextTask));
            } else {
                pending.resolve('Task approved. No more tasks in the plan.');
            }
            this._planPendingReview.delete(taskId);
        }

        this._broadcastPlanUpdate();
    }

    private _handlePlanReviewReject(taskId: string, feedback: string): void {
        if (!this._currentPlan) { return; }
        const task = findTaskById(this._currentPlan.tasks, taskId);
        if (task) {
            task.status = 'in-progress'; // Send back to in-progress
            task.updatedAt = Date.now();
        }

        // Resolve pending review promise with feedback
        const pending = this._planPendingReview.get(taskId);
        if (pending) {
            pending.resolve(`Task "${task?.title}" needs revision.\n\n**Feedback:** ${feedback}\n\nPlease address the feedback and try again. Remember to include taskId: "${taskId}" and taskStatus in your ask_user call.`);
            this._planPendingReview.delete(taskId);
        }

        this._broadcastPlanUpdate();
    }

    private _handlePlanToggleAutoAdvance(enabled: boolean): void {
        if (!this._currentPlan) { return; }
        this._currentPlan.autoAdvance = enabled;
        this._broadcastPlanUpdate();
    }

    private _handlePlanStartExecution(): void {
        if (!this._currentPlan) { return; }
        this._planExecuting = true;

        // Find and activate first pending task
        const nextTask = getNextPendingTask(this._currentPlan.tasks);
        if (nextTask) {
            nextTask.status = 'in-progress';
            nextTask.updatedAt = Date.now();
            this._currentPlan.activeTaskId = nextTask.id;
            this._broadcastPlanUpdate();
            this._broadcast({ type: 'planExecutionStarted' });

            // Send the first task as a queued prompt so Copilot picks it up
            const taskPrompt = this._formatTaskPrompt(nextTask);
            this._promptQueue.unshift({
                id: `plan_prompt_${nextTask.id}`,
                prompt: taskPrompt
            });
            this._saveQueueToDisk();
            this._updateQueueUI();

            // Ensure queue mode is active for the auto-feed
            if (!this._queueEnabled) {
                this._queueEnabled = true;
                this._updateQueueUI();
            }
        } else {
            vscode.window.showInformationMessage('No pending tasks to execute.');
        }
    }

    private _handlePlanPauseExecution(): void {
        this._planExecuting = false;
        this._broadcast({ type: 'planExecutionPaused' });
        this._broadcastPlanUpdate();
    }

    /**
     * Generate a nonce for CSP
     */
    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Parse choices from a question text.
     * Detects numbered lists (1. 2. 3.), lettered options (A. B. C.), and Option X: patterns.
     * Only detects choices near the LAST question mark "?" to avoid false positives from
     * earlier numbered/lettered content in the text.
     * 
     * @param text - The question text to parse
     * @returns Array of parsed choices, empty if no choices detected
     */
    private _parseChoices(text: string): ParsedChoice[] {
        const choices: ParsedChoice[] = [];
        let match;

        // Search the ENTIRE text for numbered/lettered lists, not just after the last "?"
        // The previous approach failed when examples within the text contained "?" characters
        // (e.g., "Example: What's your favorite language?")

        // Strategy: Find the FIRST major numbered/lettered list that starts early in the text
        // These are the actual choices, not examples or descriptions within the text

        // Split entire text into lines for multi-line patterns
        const lines = text.split('\n');

        // Pattern 1: Numbered options - lines starting with "1." or "1)" through 9
        // Also match bold numbered options like "**1. Option**"
        const numberedLinePattern = /^\s*\*{0,2}(\d+)[.)]\s*\*{0,2}\s*(.+)$/;
        const numberedLines: { index: number; num: string; numValue: number; text: string }[] = [];
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(numberedLinePattern);
            if (m && m[2].trim().length >= 3) {
                // Clean up markdown bold markers from text
                const cleanText = m[2].replace(/\*\*/g, '').trim();
                numberedLines.push({
                    index: i,
                    num: m[1],
                    numValue: parseInt(m[1], 10),
                    text: cleanText
                });
            }
        }

        // Find the FIRST contiguous list (which contains the main choices)
        // Previously used LAST list which missed choices when examples appeared later in text
        if (numberedLines.length >= 2) {
            // Find all list boundaries by detecting number restarts
            const listBoundaries: number[] = [0]; // First list starts at index 0

            for (let i = 1; i < numberedLines.length; i++) {
                const prevNum = numberedLines[i - 1].numValue;
                const currNum = numberedLines[i].numValue;
                const lineGap = numberedLines[i].index - numberedLines[i - 1].index;

                // Detect a new list if:
                // 1. Number resets (e.g., 2 -> 1, or any case where current < previous)
                // 2. Large gap between lines (> 5 lines typically means different section)
                if (currNum <= prevNum || lineGap > 5) {
                    listBoundaries.push(i);
                }
            }

            // Get the FIRST list (the main choices list)
            // The first numbered list is typically the actual choices
            // Later lists are often examples or descriptions within each choice
            const firstListEnd = listBoundaries.length > 1 ? listBoundaries[1] : numberedLines.length;
            const firstGroup = numberedLines.slice(0, firstListEnd);

            if (firstGroup.length >= 2) {
                for (const m of firstGroup) {
                    let cleanText = m.text.replace(/[?!]+$/, '').trim();
                    const displayText = cleanText.length > 40 ? cleanText.substring(0, 37) + '...' : cleanText;
                    choices.push({
                        label: displayText,
                        value: m.num,
                        shortLabel: m.num
                    });
                }
                return choices;
            }
        }

        // Pattern 1b: Inline numbered lists "1. option 2. option 3. option" or "1 - option 2 - option"
        const inlineNumberedPattern = /(\d+)(?:[.):]|\s+-)\s+([^0-9]+?)(?=\s+\d+(?:[.):]|\s+-)|$)/g;
        const inlineNumberedMatches: { num: string; text: string }[] = [];

        // Only try inline if no multi-line matches found
        // Use full text converted to single line
        const singleLine = text.replace(/\n/g, ' ');
        while ((match = inlineNumberedPattern.exec(singleLine)) !== null) {
            const optionText = match[2].trim();
            if (optionText.length >= 3) {
                inlineNumberedMatches.push({ num: match[1], text: optionText });
            }
        }

        if (inlineNumberedMatches.length >= 2) {
            for (const m of inlineNumberedMatches) {
                let cleanText = m.text.replace(/[?!]+$/, '').trim();
                const displayText = cleanText.length > 40 ? cleanText.substring(0, 37) + '...' : cleanText;
                choices.push({
                    label: displayText,
                    value: m.num,
                    shortLabel: m.num
                });
            }
            return choices;
        }

        // Pattern 2: Lettered options - lines starting with "A." or "A)" or "**A)" through Z
        // Also match bold lettered options like "**A) Option**"
        // FIX: Search entire text, not just after question mark
        const letteredLinePattern = /^\s*\*{0,2}([A-Za-z])[.)]\s*\*{0,2}\s*(.+)$/;
        const letteredLines: { index: number; letter: string; text: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(letteredLinePattern);
            if (m && m[2].trim().length >= 3) {
                // Clean up markdown bold markers from text
                const cleanText = m[2].replace(/\*\*/g, '').trim();
                letteredLines.push({ index: i, letter: m[1].toUpperCase(), text: cleanText });
            }
        }

        if (letteredLines.length >= 2) {
            // Find all list boundaries by detecting letter restarts or gaps
            const listBoundaries: number[] = [0];

            for (let i = 1; i < letteredLines.length; i++) {
                const gap = letteredLines[i].index - letteredLines[i - 1].index;
                // Detect new list if gap > 3 lines
                if (gap > 3) {
                    listBoundaries.push(i);
                }
            }

            // Get the FIRST list (the main choices list)
            const firstListEnd = listBoundaries.length > 1 ? listBoundaries[1] : letteredLines.length;
            const firstGroup = letteredLines.slice(0, firstListEnd);

            if (firstGroup.length >= 2) {
                for (const m of firstGroup) {
                    let cleanText = m.text.replace(/[?!]+$/, '').trim();
                    const displayText = cleanText.length > 40 ? cleanText.substring(0, 37) + '...' : cleanText;
                    choices.push({
                        label: displayText,
                        value: m.letter,
                        shortLabel: m.letter
                    });
                }
                return choices;
            }
        }

        // Pattern 2b: Inline lettered "A. option B. option C. option"
        // Only match single uppercase letters to avoid false positives
        const inlineLetteredPattern = /\b([A-Z])[.)]\s+([^A-Z]+?)(?=\s+[A-Z][.)]|$)/g;
        const inlineLetteredMatches: { letter: string; text: string }[] = [];

        while ((match = inlineLetteredPattern.exec(singleLine)) !== null) {
            const optionText = match[2].trim();
            if (optionText.length >= 3) {
                inlineLetteredMatches.push({ letter: match[1], text: optionText });
            }
        }

        if (inlineLetteredMatches.length >= 2) {
            for (const m of inlineLetteredMatches) {
                let cleanText = m.text.replace(/[?!]+$/, '').trim();
                const displayText = cleanText.length > 40 ? cleanText.substring(0, 37) + '...' : cleanText;
                choices.push({
                    label: displayText,
                    value: m.letter,
                    shortLabel: m.letter
                });
            }
            return choices;
        }

        // Pattern 3: "Option A:" or "Option 1:" style
        // Search entire text for this pattern
        const optionPattern = /option\s+([A-Za-z1-9])\s*:\s*([^O\n]+?)(?=\s*Option\s+[A-Za-z1-9]|\s*$|\n)/gi;
        const optionMatches: { id: string; text: string }[] = [];

        while ((match = optionPattern.exec(text)) !== null) {
            const optionText = match[2].trim();
            if (optionText.length >= 3) {
                optionMatches.push({ id: match[1].toUpperCase(), text: optionText });
            }
        }

        if (optionMatches.length >= 2) {
            for (const m of optionMatches) {
                let cleanText = m.text.replace(/[?!]+$/, '').trim();
                const displayText = cleanText.length > 40 ? cleanText.substring(0, 37) + '...' : cleanText;
                choices.push({
                    label: displayText,
                    value: `Option ${m.id}`,
                    shortLabel: m.id
                });
            }
            return choices;
        }

        return choices;
    }

    /**
     * Detect if a question is an approval/confirmation type that warrants quick action buttons.
     * Uses NLP patterns to identify yes/no questions, permission requests, and confirmations.
     * 
     * @param text - The question text to analyze
     * @returns true if the question is an approval-type question
     */
    private _isApprovalQuestion(text: string): boolean {
        const lowerText = text.toLowerCase();

        // NEGATIVE patterns - questions that require specific input (NOT approval questions)
        const requiresSpecificInput = [
            // Generic "select/choose an option" prompts - these need specific choice, not yes/no
            /please (?:select|choose|pick) (?:an? )?option/i,
            /select (?:an? )?option/i,
            // Open-ended requests for feedback/information
            /let me know/i,
            /tell me (?:what|how|when|if|about)/i,
            /waiting (?:for|on) (?:your|the)/i,
            /ready to (?:hear|see|get|receive)/i,
            // Questions asking for specific information
            /what (?:is|are|should|would)/i,
            /which (?:one|file|option|method|approach)/i,
            /where (?:should|would|is|are)/i,
            /how (?:should|would|do|can)/i,
            /when (?:should|would)/i,
            /who (?:should|would)/i,
            // Questions asking for names, values, content
            /(?:enter|provide|specify|give|type|input|write)\s+(?:a|the|your)/i,
            /what.*(?:name|value|path|url|content|text|message)/i,
            /please (?:enter|provide|specify|give|type)/i,
            // Open-ended questions
            /describe|explain|elaborate|clarify/i,
            /tell me (?:about|more|how)/i,
            /what do you (?:think|want|need|prefer)/i,
            /any (?:suggestions|recommendations|preferences|thoughts)/i,
            // Questions with multiple choice indicators (not binary)
            /choose (?:from|between|one of)/i,
            /select (?:from|one of|which)/i,
            /pick (?:one|from|between)/i,
            // Numbered options (1. 2. 3. or 1) 2) 3))
            /\n\s*[1-9][.)]\s+\S/i,
            // Lettered options (A. B. C. or a) b) c) or Option A/B/C)
            /\n\s*[a-d][.)]\s+\S/i,
            /option\s+[a-d]\s*:/i,
            // "Would you like me to:" followed by list
            /would you like (?:me to|to):\s*\n/i,
            // ASCII art boxes/mockups (common patterns)
            /[┌├└│┐┤┘─╔╠╚║╗╣╝═]/,
            /\[.+\]\s+\[.+\]/i,  // Multiple bracketed options like [Approve] [Reject]
            // "Something else?" at the end of a list typically means multi-choice
            /\d+[.)]\s+something else\??/i
        ];

        // Check if question requires specific input - if so, NOT an approval question
        for (const pattern of requiresSpecificInput) {
            if (pattern.test(lowerText)) {
                return false;
            }
        }

        // Also check for numbered lists anywhere in text (strong indicator of multi-choice)
        const numberedListCount = (text.match(/\n\s*\d+[.)]\s+/g) || []).length;
        if (numberedListCount >= 2) {
            return false; // Multiple numbered items = multi-choice question
        }

        // POSITIVE patterns - approval/confirmation questions
        const approvalPatterns = [
            // Direct yes/no question patterns
            /^(?:shall|should|can|could|may|would|will|do|does|did|is|are|was|were|have|has|had)\s+(?:i|we|you|it|this|that)\b/i,
            // Permission/confirmation phrases
            /(?:proceed|continue|go ahead|start|begin|execute|run|apply|commit|save|delete|remove|create|add|update|modify|change|overwrite|replace)/i,
            /(?:ok|okay|alright|ready|confirm|approve|accept|allow|enable|disable|skip|ignore|dismiss|close|cancel|abort|stop|exit|quit)/i,
            // Question endings that suggest yes/no
            /\?$/,
            /(?:right|correct|yes|no)\s*\?$/i,
            /(?:is that|does that|would that|should that)\s+(?:ok|okay|work|help|be\s+(?:ok|fine|good|acceptable))/i,
            // Explicit approval requests
            /(?:do you want|would you like|shall i|should i|can i|may i|could i)/i,
            /(?:want me to|like me to|need me to)/i,
            /(?:approve|confirm|authorize|permit|allow)\s+(?:this|the|these)/i,
            // Binary choice indicators
            /(?:yes or no|y\/n|yes\/no|\[y\/n\]|\(y\/n\))/i,
            // Action confirmation patterns
            /(?:are you sure|do you confirm|please confirm|confirm that)/i,
            /(?:this will|this would|this is going to)/i
        ];

        // Check if any approval pattern matches
        for (const pattern of approvalPatterns) {
            if (pattern.test(lowerText)) {
                return true;
            }
        }

        // Additional heuristic: short questions ending with ? are likely yes/no
        if (lowerText.length < this._SHORT_QUESTION_THRESHOLD && lowerText.trim().endsWith('?')) {
            // But exclude questions with interrogative words that typically need specific answers
            const interrogatives = /^(?:what|which|where|when|why|how|who|whom|whose)\b/i;
            if (!interrogatives.test(lowerText.trim())) {
                return true;
            }
        }

        return false;
    }
}

// Alias for backward compatibility with extension.ts import
export { TaskSyncWebviewProvider as AskAwayWebviewProvider };

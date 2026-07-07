/**
 * AskAway Observability Plugin for OpenCode
 *
 * Tracks all token usage, costs, and tool calls across sessions.
 * Pushes data to the AskAway central server for the web dashboard + Telegram.
 *
 * Install: add "askaway-plugin" to the plugin array in opencode.jsonc
 */

import type { PluginModule, PluginInput, Hooks, PluginOptions } from '@opencode-ai/plugin';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

// ── Types ──

interface TokenSnapshot {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

interface ToolCallRecord {
    tool: string;
    sessionID: string;
    callID: string;
    args: any;
    output?: string;
    title?: string;
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
}

interface StepRecord {
    sessionID: string;
    messageID: string;
    tokens: TokenSnapshot;
    timestamp: number;
}

interface SessionStats {
    sessionID: string;
    steps: StepRecord[];
    toolCalls: ToolCallRecord[];
    totalTokens: TokenSnapshot;
    messageCount: number;
    startedAt: number;
    lastActivity: number;
}

// ── State ──

const sessions = new Map<string, SessionStats>();
const ASKAWAY_SERVER = process.env.ASKAWAY_SERVER_HTTP || 'http://127.0.0.1:4350';
const LOG_DIR = path.join(os.homedir(), '.askaway', 'logs');

// ── Helpers ──

function getOrCreateSession(sessionID: string): SessionStats {
    let s = sessions.get(sessionID);
    if (!s) {
        s = {
            sessionID,
            steps: [],
            toolCalls: [],
            totalTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            messageCount: 0,
            startedAt: Date.now(),
            lastActivity: Date.now(),
        };
        sessions.set(sessionID, s);
    }
    return s;
}

function addTokens(total: TokenSnapshot, step: TokenSnapshot): void {
    total.input += step.input;
    total.output += step.output;
    total.reasoning += step.reasoning;
    total.cacheRead += step.cacheRead;
    total.cacheWrite += step.cacheWrite;
    total.cost += step.cost;
}

function log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[AskAway Plugin ${ts}] ${msg}`);
}

function appendToLog(sessionID: string, entry: object): void {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const logFile = path.join(LOG_DIR, `${sessionID}.jsonl`);
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch { /* best effort */ }
}

/** Push stats to AskAway server (non-blocking) */
function pushToServer(data: object): void {
    try {
        const body = JSON.stringify(data);
        const url = new URL(`${ASKAWAY_SERVER}/api/plugin-stats`);
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        });
        req.on('error', () => { /* silent */ });
        req.write(body);
        req.end();
    } catch { /* best effort */ }
}

function formatTokens(t: TokenSnapshot): string {
    const parts = [];
    if (t.input) parts.push(`in:${t.input}`);
    if (t.output) parts.push(`out:${t.output}`);
    if (t.reasoning) parts.push(`reason:${t.reasoning}`);
    if (t.cacheRead) parts.push(`cache↓:${t.cacheRead}`);
    if (t.cacheWrite) parts.push(`cache↑:${t.cacheWrite}`);
    if (t.cost) parts.push(`$${t.cost.toFixed(4)}`);
    return parts.join(' ') || '(none)';
}

// ── Plugin ──

const plugin: PluginModule = {
    id: 'askaway',

    async server(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
        log('Plugin loaded — observability mode');

        return {
            // ── Event stream — catch StepFinishPart for token data ──
            async event({ event }) {
                if (event.type === 'message.updated') {
                    const msg = (event as any).properties?.info;
                    if (msg?.role === 'assistant' && msg?.sessionID) {
                        const s = getOrCreateSession(msg.sessionID);
                        s.messageCount++;
                        s.lastActivity = Date.now();
                    }
                }
            },

            // ── Tool call tracking ──
            async 'tool.execute.before'(input, output) {
                const s = getOrCreateSession(input.sessionID);
                const record: ToolCallRecord = {
                    tool: input.tool,
                    sessionID: input.sessionID,
                    callID: input.callID,
                    args: output.args,
                    startedAt: Date.now(),
                };
                s.toolCalls.push(record);
                s.lastActivity = Date.now();

                log(`🔧 ${input.tool} [${input.callID.slice(0, 8)}]`);
            },

            async 'tool.execute.after'(input, output) {
                const s = getOrCreateSession(input.sessionID);
                const record = s.toolCalls.find(t => t.callID === input.callID);
                if (record) {
                    record.finishedAt = Date.now();
                    record.durationMs = record.finishedAt - record.startedAt;
                    record.output = output.output?.substring(0, 500); // truncate for logging
                    record.title = output.title;
                }
                s.lastActivity = Date.now();

                const dur = record?.durationMs ?? 0;
                const outLen = output.output?.length ?? 0;
                log(`✅ ${input.tool} [${input.callID.slice(0, 8)}] ${dur}ms, ${outLen} chars output`);

                appendToLog(input.sessionID, {
                    type: 'tool',
                    tool: input.tool,
                    callID: input.callID,
                    durationMs: dur,
                    outputLength: outLen,
                    timestamp: Date.now(),
                });
            },

            // ── Message tracking — capture token usage from parts ──
            async 'chat.message'(input, output) {
                if (!input.sessionID) return;
                const s = getOrCreateSession(input.sessionID);
                s.messageCount++;
                s.lastActivity = Date.now();

                // Check for step-finish parts which carry token data
                for (const part of output.parts) {
                    if ((part as any).type === 'step-finish') {
                        const sp = part as any;
                        const tokens: TokenSnapshot = {
                            input: sp.tokens?.input ?? 0,
                            output: sp.tokens?.output ?? 0,
                            reasoning: sp.tokens?.reasoning ?? 0,
                            cacheRead: sp.tokens?.cache?.read ?? 0,
                            cacheWrite: sp.tokens?.cache?.write ?? 0,
                            cost: sp.cost ?? 0,
                        };

                        const step: StepRecord = {
                            sessionID: input.sessionID,
                            messageID: input.messageID ?? 'unknown',
                            tokens,
                            timestamp: Date.now(),
                        };
                        s.steps.push(step);
                        addTokens(s.totalTokens, tokens);

                        log(`📊 Step: ${formatTokens(tokens)} | Total: ${formatTokens(s.totalTokens)}`);

                        appendToLog(input.sessionID, {
                            type: 'step',
                            tokens,
                            totalTokens: s.totalTokens,
                            stepCount: s.steps.length,
                            timestamp: Date.now(),
                        });

                        pushToServer({
                            type: 'token-update',
                            sessionID: input.sessionID,
                            step: tokens,
                            total: s.totalTokens,
                            stepCount: s.steps.length,
                            toolCallCount: s.toolCalls.length,
                        });
                    }
                }
            },

            // ── Custom tool removed — plugin is observability-only ──
            // ask_user lives in the MCP relay, not here
        };
    },
};

export default plugin;
export const { id, server } = plugin;

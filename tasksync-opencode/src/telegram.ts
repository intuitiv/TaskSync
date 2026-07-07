/**
 * AskAway Telegram Bot — lightweight standalone version for MCP server.
 * No VS Code dependencies. Reads config from env vars or config file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { SessionManager } from './sessionManager.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL_MS = 3000;    // 3s when pending questions exist
const IDLE_INTERVAL_MS = 30000;   // 30s when no pending questions
const CONFIG_PATH = path.join(os.homedir(), '.askaway', 'config.json');

interface TelegramConfig {
    botToken: string;
    chatId: string;
}

export class TelegramBot {
    private botToken: string = '';
    private chatId: string = '';
    private enabled: boolean = false;
    private lastUpdateId: number = 0;
    private pollTimer: NodeJS.Timeout | undefined;
    private sessionManager: SessionManager;
    private botId: number | undefined;

    // Track which Telegram messages map to which sessions
    private messageToSession = new Map<number, string>(); // messageId → sessionId
    // Track topic thread IDs by name (persisted to ~/.askaway/topics.json)
    private topicsByName = new Map<string, number>(); // sessionName → message_thread_id
    // Reverse mapping: sessionId → topicId (runtime only)
    private sessionTopics = new Map<string, number>();
    // Forum detection cache
    private isForum: boolean | null = null;
    private topicsLoaded = false;
    private topicsFilePath: string;

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
        this.topicsFilePath = path.join(os.homedir(), '.askaway', 'topics.json');
        this.loadConfig();
        this.setupSessionEvents();
    }

    private loadConfig(): void {
        // Priority: env vars > config file
        const token = process.env.ASKAWAY_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.ASKAWAY_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

        if (token && chatId) {
            this.botToken = token;
            this.chatId = chatId;
            this.enabled = true;
            console.log('[AskAway Telegram] Configured from environment variables');
            return;
        }

        // Try config file
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const config: TelegramConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
                if (config.botToken && config.chatId) {
                    this.botToken = config.botToken;
                    this.chatId = config.chatId;
                    this.enabled = true;
                    console.log('[AskAway Telegram] Configured from ~/.askaway/config.json');
                    return;
                }
            }
        } catch { }

        console.log('[AskAway Telegram] Not configured. Set ASKAWAY_BOT_TOKEN + ASKAWAY_CHAT_ID or create ~/.askaway/config.json');
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    async start(): Promise<void> {
        if (!this.enabled) return;

        // Get bot info to filter own messages
        try {
            const me = await this.apiCall('getMe');
            this.botId = me.id;
            console.log(`[AskAway Telegram] Bot: @${me.username} (${me.id})`);
        } catch (err: any) {
            console.error('[AskAway Telegram] Failed to connect:', err.message);
            this.enabled = false;
            return;
        }

        // Start polling
        this.poll();
        console.log('[AskAway Telegram] Polling started');
    }

    stop(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    // ── Session events → Telegram notifications ──

    private setupSessionEvents(): void {
        this.sessionManager.on('question-posted', async (data: { sessionId: string; questionId: string; question: string }) => {
            if (!this.enabled) return;
            const session = this.sessionManager.getSession(data.sessionId);
            if (!session) return;

            // Get or create a topic for this session's workspace name
            const topicId = await this.getOrCreateTopic(data.sessionId, session.name);

            // Set pending indicator on topic
            if (topicId) {
                await this.setTopicIndicator(topicId, session.name, true);
            }

            const text = `🔔 <b>${this.escHtml(session.name)}</b>\n\n${this.escHtml(data.question)}`;
            try {
                const msg = await this.sendMessage(text, undefined, topicId);
                if (msg?.message_id) {
                    this.messageToSession.set(msg.message_id, data.sessionId);
                }
            } catch (err: any) {
                console.error('[AskAway Telegram] Failed to send question:', err.message);
            }
        });

        this.sessionManager.on('question-resolved', async (data: { sessionId: string }) => {
            if (!this.enabled) return;
            const session = this.sessionManager.getSession(data.sessionId);
            if (!session) return;
            const topicId = this.sessionTopics.get(data.sessionId);
            if (topicId) {
                await this.setTopicIndicator(topicId, session.name, false);
            }
        });
    }

    // ── Forum / Topic management (ported from VS Code extension) ──

    /** Detect once whether the chat is a forum-enabled supergroup */
    private async detectForum(): Promise<boolean> {
        if (this.isForum !== null) return this.isForum;
        try {
            const result = await this.apiCall('getChat', { chat_id: this.chatId });
            this.isForum = result?.is_forum === true;
            console.log(`[AskAway Telegram] Chat forum mode: ${this.isForum}`);
        } catch {
            this.isForum = false;
        }
        return this.isForum;
    }

    /** Load persisted topic IDs from ~/.askaway/topics.json */
    private loadTopics(): void {
        if (this.topicsLoaded) return;
        this.topicsLoaded = true;
        try {
            if (fs.existsSync(this.topicsFilePath)) {
                const data = JSON.parse(fs.readFileSync(this.topicsFilePath, 'utf-8'));
                for (const [name, id] of Object.entries(data)) {
                    if (typeof id === 'number') {
                        this.topicsByName.set(name, id);
                    }
                }
                console.log(`[AskAway Telegram] Loaded ${this.topicsByName.size} persisted topic(s)`);
            }
        } catch { /* first run */ }
    }

    /** Persist topic IDs to ~/.askaway/topics.json */
    private saveTopics(): void {
        try {
            const dir = path.dirname(this.topicsFilePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const obj: Record<string, number> = {};
            for (const [name, id] of this.topicsByName) { obj[name] = id; }
            fs.writeFileSync(this.topicsFilePath, JSON.stringify(obj, null, 2));
        } catch (err: any) {
            console.error('[AskAway Telegram] Failed to save topics:', err.message);
        }
    }

    /** Get or create a Telegram Forum Topic for a session. Reuses by name across restarts. */
    private async getOrCreateTopic(sessionId: string, sessionName: string): Promise<number | undefined> {
        const isForum = await this.detectForum();
        if (!isForum) return undefined;

        // Check runtime cache
        const cached = this.sessionTopics.get(sessionId);
        if (cached) return cached;

        // Load persisted topics and check by name
        this.loadTopics();
        const byName = this.topicsByName.get(sessionName);
        if (byName) {
            this.sessionTopics.set(sessionId, byName);
            return byName;
        }

        // Create new forum topic
        try {
            const result = await this.apiCall('createForumTopic', {
                chat_id: this.chatId,
                name: sessionName,
                icon_color: 0x6FB9F0,
            });
            if (result?.message_thread_id) {
                const topicId = result.message_thread_id;
                this.sessionTopics.set(sessionId, topicId);
                this.topicsByName.set(sessionName, topicId);
                this.saveTopics();
                console.log(`[AskAway Telegram] Created topic "${sessionName}" → thread_id=${topicId}`);
                return topicId;
            }
        } catch (err: any) {
            console.error('[AskAway Telegram] Could not create topic:', err.message);
        }
        return undefined;
    }

    /** Edit topic name to show pending (🔴) or resolved state */
    private async setTopicIndicator(topicId: number, sessionName: string, pending: boolean): Promise<void> {
        const name = pending ? `🔴 ${sessionName}` : sessionName;
        try {
            await this.apiCall('editForumTopic', {
                chat_id: this.chatId,
                message_thread_id: topicId,
                name,
            });
        } catch { /* best effort */ }
    }

    // ── Polling ──

    private async poll(): Promise<void> {
        if (!this.enabled) return;

        try {
            const updates = await this.apiCall('getUpdates', {
                offset: this.lastUpdateId + 1,
                timeout: 1,
                allowed_updates: JSON.stringify(['message']),
            });

            if (Array.isArray(updates)) {
                for (const update of updates) {
                    this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
                    if (update.message) {
                        await this.handleMessage(update.message);
                    }
                }
            }
        } catch (err: any) {
            console.error('[AskAway Telegram] Poll error:', err.message);
        }

        // Schedule next poll based on whether there are pending questions
        const hasPending = this.sessionManager.getSessionsWithPending().length > 0;
        const interval = hasPending ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS;
        this.pollTimer = setTimeout(() => this.poll(), interval);
    }

    private async handleMessage(msg: any): Promise<void> {
        // Skip own messages
        if (msg.from?.id === this.botId) return;

        // Verify it's from our configured chat
        if (String(msg.chat?.id) !== String(this.chatId)) return;

        const text = msg.text || msg.caption || '';

        // Handle commands
        if (text.startsWith('/')) {
            await this.handleCommand(text, msg);
            return;
        }

        // Route response to the right session (use topic thread to identify session)
        await this.routeResponse(text, msg);
    }

    private async handleCommand(text: string, msg: any): Promise<void> {
        const [cmd, ...args] = text.split(' ');
        const command = cmd.toLowerCase().replace('@' + (this.botId || ''), '');

        switch (command) {
            case '/help':
                await this.sendMessage(
                    '📋 <b>AskAway Commands</b>\n\n' +
                    '/sessions — List active sessions\n' +
                    '/tokens — Show token usage\n' +
                    '/pending — Show pending questions\n' +
                    '/help — This message'
                );
                break;

            case '/sessions':
                const sessions = this.sessionManager.getAllSessions();
                if (!sessions.length) {
                    await this.sendMessage('No active sessions.');
                } else {
                    const lines = sessions.map(s =>
                        `${s.pending ? '🔴' : '🟢'} <b>${this.escHtml(s.name)}</b> — ${s.history.length} exchanges, ~${s.tokenUsage.totalInput + s.tokenUsage.totalOutput} tokens`
                    );
                    await this.sendMessage(lines.join('\n'));
                }
                break;

            case '/tokens':
                const usage = this.sessionManager.getAggregateTokenUsage();
                await this.sendMessage(
                    `📊 <b>Token Usage</b>\n\n` +
                    `Sessions: ${usage.sessions}\n` +
                    `Input: ~${usage.totalInput.toLocaleString()} tokens\n` +
                    `Output: ~${usage.totalOutput.toLocaleString()} tokens\n` +
                    `Total: ~${(usage.totalInput + usage.totalOutput).toLocaleString()} tokens`
                );
                break;

            case '/pending':
                const pending = this.sessionManager.getSessionsWithPending();
                if (!pending.length) {
                    await this.sendMessage('No pending questions.');
                } else {
                    const lines = pending.map(s =>
                        `🔴 <b>${this.escHtml(s.name)}</b>\n${this.escHtml(s.pending!.question.substring(0, 200))}${s.pending!.question.length > 200 ? '…' : ''}`
                    );
                    await this.sendMessage(lines.join('\n\n'));
                }
                break;

            default:
                await this.sendMessage(`Unknown command: ${command}\nUse /help to see available commands.`);
        }
    }

    private async routeResponse(text: string, msg: any): Promise<void> {
        if (!text.trim()) return;

        const threadId = msg.message_thread_id;

        // Try to route by topic thread → session mapping
        if (threadId) {
            for (const [sessionId, topicId] of this.sessionTopics) {
                if (topicId === threadId) {
                    const ok = this.sessionManager.respondToSession(sessionId, text);
                    if (ok) {
                        await this.sendMessage('✅ Response sent.', msg.message_id, threadId);
                        return;
                    }
                }
            }
        }

        // If replying to a bot message, try to route by message ID
        if (msg.reply_to_message?.message_id) {
            const sessionId = this.messageToSession.get(msg.reply_to_message.message_id);
            if (sessionId) {
                const ok = this.sessionManager.respondToSession(sessionId, text);
                if (ok) {
                    await this.sendMessage('✅ Response sent.', msg.message_id, threadId);
                    return;
                }
            }
        }

        // If only one session has a pending question, route there
        const pending = this.sessionManager.getSessionsWithPending();
        if (pending.length === 1) {
            const ok = this.sessionManager.respondToSession(pending[0].id, text);
            if (ok) {
                const topicId = this.sessionTopics.get(pending[0].id);
                await this.sendMessage(`✅ → ${pending[0].name}`, msg.message_id, topicId || threadId);
                return;
            }
        }

        if (pending.length > 1) {
            await this.sendMessage(
                `⚠️ Multiple pending questions. Reply to the specific message or use the session's topic.`,
                msg.message_id, threadId
            );
        }
        // No pending questions — stay silent, don't spam the chat
    }

    // ── Telegram API helpers ──

    private async apiCall(method: string, params?: Record<string, any>): Promise<any> {
        const urlStr = `${TELEGRAM_API}${this.botToken}/${method}`;
        const body = params ? JSON.stringify(params) : undefined;

        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data) as { ok: boolean; result?: any; description?: string };
                        if (!parsed.ok) {
                            reject(new Error(`Telegram API error: ${parsed.description || 'Unknown error'}`));
                        } else {
                            resolve(parsed.result);
                        }
                    } catch {
                        reject(new Error('Failed to parse Telegram API response'));
                    }
                });
            });

            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    private async sendMessage(text: string, replyTo?: number, threadId?: number): Promise<any> {
        const params: Record<string, any> = {
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
        };
        if (replyTo) {
            params.reply_to_message_id = replyTo;
        }
        if (threadId) {
            params.message_thread_id = threadId;
        }
        return this.apiCall('sendMessage', params);
    }

    private escHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG_NAMESPACE } from '../constants/branding';
import type { AttachmentInfo } from '../webview/webviewProvider';

// ── Interfaces ─────────────────────────────────────────────────

// ── Shared choice type (accepts plain strings or ParsedChoice-shaped objects) ──
type TelegramChoice = string | { label: string; value: string; shortLabel?: string };

interface TrackedTask {
    taskId: string;
    messageId: number;   // Telegram message_id of the posted question
    /** Forum topic thread ID (message_thread_id) — undefined for non-forum chats */
    topicId?: number;
    question: string;
    choices?: TelegramChoice[];
    timestamp: number;
    /** Rendered HTML body (without footer) — used when editing for sync-time updates */
    formattedText: string;
}

// ── Constants ──────────────────────────────────────────────────

// Quick ramp-up schedule before switching to configurable steady interval.
const INITIAL_POLL_BACKOFF_SCHEDULE_S = [2, 2, 5, 10, 30];
const LONG_WAIT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const LONG_WAIT_INTERVAL_SECONDS = 4 * 60; // 4 minutes
const EXPIRY_MS = 36 * 60 * 60 * 1000;  // 36 hours
const TELEGRAM_API = 'https://api.telegram.org/bot';

// ── Service ────────────────────────────────────────────────────

export class TelegramService {
    private _out: vscode.OutputChannel | undefined;
    private _enabled: boolean = false;
    private _botToken: string | undefined;
    private _chatId: string | undefined;
    private _pollingTimer: NodeJS.Timeout | undefined;
    private _activeTasks: Map<string, TrackedTask> = new Map();
    private _lastUpdateId: number = 0;  // Telegram getUpdates offset (only advanced past our own processed messages)
    /**
     * Shared-queue offset algorithm: in-memory set of update_ids this window has
     * processed. Used to (a) dedupe re-received messages on subsequent polls and
     * (b) decide how far we can safely advance `_lastUpdateId` without ACKing past
     * a foreign-topic message (which Telegram would delete globally for all bots).
     */
    private _myProcessedSet: Set<number> = new Set();
    private _onResponseReceived: ((taskId: string, response: string, user: string, attachments?: AttachmentInfo[]) => void) | undefined;
    private _onHistoryRequested: (() => { prompt: string; response: string; timestamp: number; status: string }[]) | undefined;

    // ── Backoff polling state ──
    private _pollTickIndex: number = 0;
    private _pollCount: number = 0;
    private _pollingStartedAtMs: number = 0;

    // ── Copilot activity tracking ──
    private _lastCopilotActivity: number = 0;
    private _copilotIdleThresholdMs: number = 0;

    // ── Conversation state tracking ──
    private _lastToolCallStarted: number = 0;   // When ask_user was called (waiting for user)
    private _lastToolCallReturned: number = 0;  // When user responded (Copilot processing)
    private _conversationActive: boolean = false;

    // ── Polling configuration ──
    private _steadyPollIntervalSeconds: number = 60;

    // ── File change tracking ──
    private _recentFileChanges: string[] = [];

    // ── Bot info ──
    private _botId: number | undefined;

    // ── Heartbeat ──
    private _heartbeatTimer: NodeJS.Timeout | undefined;
    private _heartbeatIntervalMs: number = 10 * 60 * 1000;  // 10 min default
    private _lastHeartbeatMsgId: number | undefined;
    private _lastStatusSentAt: number = 0;

    // ── Pre-resolved set (handles race between async postQuestion and resolveTask) ──
    private _preResolved: Set<string> = new Set();

    // ── Forum Topics (Telegram groups with "Topics" enabled) ──
    /** null = not yet checked, false = regular chat, true = forum group */
    private _isForum: boolean | null = null;
    /** workspace name → Telegram thread/topic ID (in-memory cache, persisted via globalState) */
    private _topicIds: Map<string, number> = new Map();
    /** Whether we have already loaded persisted topics for this session */
    private _forumTopicsLoaded: boolean = false;
    /** VS Code extension context — used to persist topic IDs across restarts */
    private _extContext: vscode.ExtensionContext | undefined;

    constructor(outputChannel?: vscode.OutputChannel) {
        this._out = outputChannel;
        this.reloadConfig();
    }

    /** Call once after construction to enable topic-ID persistence across restarts. */
    public setExtensionContext(ctx: vscode.ExtensionContext): void {
        this._extContext = ctx;
    }

    private _log(msg: string): void {
        const line = `[${new Date().toISOString()}] ${msg}`;
        this._out?.appendLine(line);
        console.log(msg);
    }

    private _warn(msg: string): void {
        const line = `[${new Date().toISOString()}] WARN: ${msg}`;
        this._out?.appendLine(line);
        console.warn(msg);
    }

    private _err(msg: string, error?: unknown): void {
        const detail = error instanceof Error ? ` — ${error.message}` : (error ? ` — ${error}` : '');
        const line = `[${new Date().toISOString()}] ERROR: ${msg}${detail}`;
        this._out?.appendLine(line);
        console.error(msg, error ?? '');
    }

    // ── Configuration ──────────────────────────────────────────

    public reloadConfig() {
        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        this._enabled = config.get<boolean>('telegram.enabled', false);
        this._botToken = config.get<string>('telegram.botToken', '') || undefined;
        this._chatId = config.get<string>('telegram.chatId', '') || undefined;

        const configuredRetrySec = config.get<number>('telegram.retryIntervalSeconds', 60);
        // Allowed bounds: 10s to 15min for steady polling interval.
        this._steadyPollIntervalSeconds = Math.min(900, Math.max(10, Math.floor(configuredRetrySec || 60)));

        const configuredIdleMinutes = config.get<number>('telegram.idlePauseMinutes', 0);
        // 0 disables idle-pause, otherwise clamp to 1 minute..12 hours.
        const idleMinutes = Math.min(720, Math.max(0, Math.floor(configuredIdleMinutes || 0)));
        this._copilotIdleThresholdMs = idleMinutes > 0 ? idleMinutes * 60 * 1000 : 0;

        this._log(
            `AskAway/Telegram: Config reloaded — enabled=${this._enabled}, hasToken=${!!this._botToken}, hasChatId=${!!this._chatId}, retry=${this._steadyPollIntervalSeconds}s, idlePause=${idleMinutes}m`
        );

        // Re-evaluate polling state
        if (this._enabled && this._botToken && this._chatId && this._activeTasks.size > 0) {
            this.startPolling();
        } else if (!this._enabled || !this._botToken) {
            this.stopPolling();
        }
    }

    public isConfigured(): boolean {
        return this._enabled && !!this._botToken && !!this._chatId;
    }

    public isEnabled(): boolean {
        return this._enabled;
    }

    public setResponseCallback(callback: (taskId: string, response: string, user: string, attachments?: AttachmentInfo[]) => void) {
        this._onResponseReceived = callback;
    }

    public setHistoryCallback(callback: () => { prompt: string; response: string; timestamp: number; status: string }[]) {
        this._onHistoryRequested = callback;
    }

    /** Get detailed status for settings UI */
    public getTokenStatus(): {
        status: 'connected' | 'token-missing' | 'incomplete' | 'disabled';
        hasToken: boolean;
        hasChatId: boolean;
        isPolling: boolean;
        activeTasks: number;
        message: string;
        hint: string;
    } {
        if (!this._enabled) {
            return {
                status: 'disabled',
                hasToken: !!this._botToken,
                hasChatId: !!this._chatId,
                isPolling: !!this._pollingTimer,
                activeTasks: this._activeTasks.size,
                message: 'Telegram integration is disabled.',
                hint: 'Enable it in Settings → askaway.telegram.enabled'
            };
        }

        if (!this._botToken) {
            return {
                status: 'token-missing',
                hasToken: false,
                hasChatId: !!this._chatId,
                isPolling: !!this._pollingTimer,
                activeTasks: this._activeTasks.size,
                message: 'No bot token configured.',
                hint: 'Create a bot via @BotFather on Telegram, then set the token in Settings → askaway.telegram.botToken'
            };
        }

        if (!this._chatId) {
            return {
                status: 'incomplete',
                hasToken: true,
                hasChatId: false,
                isPolling: !!this._pollingTimer,
                activeTasks: this._activeTasks.size,
                message: 'Missing Chat ID.',
                hint: 'Send a message to your bot, then use "AskAway: Get Telegram Chat ID" command, or set it in Settings → askaway.telegram.chatId'
            };
        }

        return {
            status: 'connected',
            hasToken: true,
            hasChatId: true,
            isPolling: !!this._pollingTimer,
            activeTasks: this._activeTasks.size,
            message: 'Telegram integration is active.',
            hint: this._pollingTimer
                ? `Polling for replies (${this._activeTasks.size} active task${this._activeTasks.size !== 1 ? 's' : ''}).`
                : 'Ready — will start polling when a question is posted.'
        };
    }

    // ── Telegram API helpers ───────────────────────────────────

    private _apiUrl(method: string): string {
        return `${TELEGRAM_API}${this._botToken}/${method}`;
    }

    /**
     * Download a file from Telegram by file_id.
     * Calls getFile to get the file path, downloads it, and saves to OS temp dir.
     * Returns the local file path or undefined on failure.
     */
    private async _downloadTelegramFile(fileId: string, suggestedName?: string): Promise<string | undefined> {
        try {
            // Step 1: Get file path from Telegram
            const fileInfoResp = await fetch(this._apiUrl('getFile'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId })
            });
            if (!fileInfoResp.ok) {
                this._warn(`AskAway/Telegram: getFile failed ${fileInfoResp.status}`);
                return undefined;
            }
            const fileInfo = await fileInfoResp.json() as any;
            const filePath = fileInfo.result?.file_path;
            if (!filePath) {
                this._warn('AskAway/Telegram: getFile returned no file_path');
                return undefined;
            }

            // Step 2: Download the file
            const downloadUrl = `https://api.telegram.org/file/bot${this._botToken}/${filePath}`;
            const downloadResp = await fetch(downloadUrl);
            if (!downloadResp.ok) {
                this._warn(`AskAway/Telegram: file download failed ${downloadResp.status}`);
                return undefined;
            }

            // Step 3: Save to temp directory
            const ext = path.extname(filePath) || path.extname(suggestedName || '') || '';
            const baseName = suggestedName || `telegram_${fileId.substring(0, 8)}${ext}`;
            const tmpDir = path.join(os.tmpdir(), 'tasksync-attachments');
            await fs.promises.mkdir(tmpDir, { recursive: true });
            const localPath = path.join(tmpDir, `${Date.now()}_${baseName}`);

            const buffer = Buffer.from(await downloadResp.arrayBuffer());
            await fs.promises.writeFile(localPath, buffer);

            this._log(`AskAway/Telegram: Downloaded file ${filePath} → ${localPath} (${buffer.length} bytes)`);
            return localPath;
        } catch (e) {
            this._err('AskAway/Telegram: _downloadTelegramFile error', e);
            return undefined;
        }
    }

    /**
     * Extract media file info from a Telegram message.
     * Returns an array of {fileId, fileName} for all supported attachment types.
     */
    private _extractMediaFromMessage(msg: any): { fileId: string; fileName: string }[] {
        const media: { fileId: string; fileName: string }[] = [];

        // Photo: array of PhotoSize, pick the largest (last)
        if (msg.photo && msg.photo.length > 0) {
            const largest = msg.photo[msg.photo.length - 1];
            media.push({ fileId: largest.file_id, fileName: `photo_${largest.file_unique_id}.jpg` });
        }

        // Document (any file type)
        if (msg.document) {
            media.push({
                fileId: msg.document.file_id,
                fileName: msg.document.file_name || `document_${msg.document.file_unique_id}`
            });
        }

        // Video
        if (msg.video) {
            media.push({
                fileId: msg.video.file_id,
                fileName: msg.video.file_name || `video_${msg.video.file_unique_id}.mp4`
            });
        }

        // Audio
        if (msg.audio) {
            media.push({
                fileId: msg.audio.file_id,
                fileName: msg.audio.file_name || `audio_${msg.audio.file_unique_id}.mp3`
            });
        }

        // Voice message (ogg/opus)
        if (msg.voice) {
            media.push({
                fileId: msg.voice.file_id,
                fileName: `voice_${msg.voice.file_unique_id}.ogg`
            });
        }

        // Video note (round video)
        if (msg.video_note) {
            media.push({
                fileId: msg.video_note.file_id,
                fileName: `videonote_${msg.video_note.file_unique_id}.mp4`
            });
        }

        // Sticker
        if (msg.sticker) {
            const ext = msg.sticker.is_animated ? '.tgs' : (msg.sticker.is_video ? '.webm' : '.webp');
            media.push({
                fileId: msg.sticker.file_id,
                fileName: `sticker_${msg.sticker.file_unique_id}${ext}`
            });
        }

        // Animation (GIF)
        if (msg.animation) {
            media.push({
                fileId: msg.animation.file_id,
                fileName: msg.animation.file_name || `animation_${msg.animation.file_unique_id}.mp4`
            });
        }

        return media;
    }

    /**
     * Download all media from a Telegram message and return AttachmentInfo array.
     */
    private async _downloadMessageMedia(msg: any): Promise<AttachmentInfo[]> {
        const mediaItems = this._extractMediaFromMessage(msg);
        if (mediaItems.length === 0) { return []; }

        const attachments: AttachmentInfo[] = [];
        for (const item of mediaItems) {
            const localPath = await this._downloadTelegramFile(item.fileId, item.fileName);
            if (localPath) {
                attachments.push({
                    id: `tg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    name: item.fileName,
                    uri: localPath,
                    isTemporary: true
                });
            }
        }
        return attachments;
    }

    /** Cache the bot's own user ID to ignore its own messages */
    private async _cacheBotId(): Promise<void> {
        if (this._botId) { return; }
        try {
            const resp = await fetch(this._apiUrl('getMe'));
            if (resp.ok) {
                const data = await resp.json() as any;
                this._botId = data.result?.id;
                this._log(`AskAway/Telegram: Bot ID cached: ${this._botId}`);
            } else {
                this._warn(`AskAway/Telegram: getMe failed ${resp.status}`);
            }
        } catch (e) {
            this._warn(`AskAway/Telegram: Failed to get bot info: ${e}`);
        }
    }

    // ── Forum Topics ───────────────────────────────────────────

    /** Get current workspace name: workspace file name → first folder name → fallback */
    private _workspaceName(): string {
        return vscode.workspace.name
            ?? vscode.workspace.workspaceFolders?.[0]?.name
            ?? 'AskAway';
    }

    /**
     * Fetch all existing forum topics from Telegram once per session and
     * populate _topicIds. This lets us reuse existing topics across restarts
     * without needing local storage.
     */
    private _ensureForumTopicsLoaded(): void {
        if (this._forumTopicsLoaded) { return; }
        this._forumTopicsLoaded = true;
        if (!this._extContext) { return; }
        const saved = this._extContext.globalState.get<Record<string, number>>('askaway.topicIds', {});
        for (const [name, id] of Object.entries(saved)) {
            this._topicIds.set(name, id);
        }
        this._log(`AskAway/Telegram: Loaded ${Object.keys(saved).length} persisted topic(s) from globalState`);
    }

    /**
     * Check once whether the configured chat is a Telegram Forum group.
     * Caches the result so it only calls `getChat` on the first message.
     */
    private async _detectForum(): Promise<boolean> {
        if (this._isForum !== null) { return this._isForum; }
        try {
            const resp = await fetch(this._apiUrl('getChat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: this._chatId })
            });
            if (resp.ok) {
                const data = await resp.json() as any;
                this._isForum = data.result?.is_forum === true;
                this._log(`AskAway/Telegram: Chat type detected — is_forum=${this._isForum}`);
            } else {
                this._isForum = false;
            }
        } catch {
            this._isForum = false;
        }
        return this._isForum;
    }

    /**
     * Get (or create) a Telegram Forum Topic ID for the given workspace name.
     * Returns undefined for non-forum chats (silently degrades).
     */
    private async _getTopicId(workspaceName: string): Promise<number | undefined> {
        const isForum = await this._detectForum();
        if (!isForum) { return undefined; }

        // Load persisted topics on first use (avoids duplicate topic creation across restarts)
        this._ensureForumTopicsLoaded();

        if (this._topicIds.has(workspaceName)) {
            return this._topicIds.get(workspaceName);
        }

        try {
            const resp = await fetch(this._apiUrl('createForumTopic'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: this._chatId, name: workspaceName, icon_color: 0x6FB9F0 })
            });
            if (resp.ok) {
                const data = await resp.json() as any;
                const topicId: number = data.result?.message_thread_id;
                if (topicId) {
                    this._topicIds.set(workspaceName, topicId);
                    // Persist so the same topic is reused on next restart
                    if (this._extContext) {
                        const saved = this._extContext.globalState.get<Record<string, number>>('askaway.topicIds', {});
                        saved[workspaceName] = topicId;
                        void this._extContext.globalState.update('askaway.topicIds', saved);
                    }
                    this._log(`AskAway/Telegram: Created forum topic "${workspaceName}" — thread_id=${topicId}`);
                    return topicId;
                }
            } else {
                // May already exist — Telegram doesn't return existing topic ID on re-create.
                // User needs to set it manually for now; log a warning.
                const err = await resp.text();
                this._warn(`AskAway/Telegram: createForumTopic failed (${resp.status}): ${err}. Messages will go to General topic.`);
            }
        } catch (e) {
            this._warn(`AskAway/Telegram: createForumTopic error: ${e}`);
        }
        return undefined;
    }

    /**
     * Edit a forum topic indicator to reflect pending/resolved state.
     * Telegram only supports custom emoji IDs for real topic icons; this helper
     * uses a name prefix fallback that is reliable across chats.
     */
    private async _editTopicIcon(topicId: number | undefined, workspaceName: string, pending: boolean): Promise<void> {
        if (!topicId || !this.isConfigured()) { return; }
        const name = pending ? `🔴 ${workspaceName}` : workspaceName;
        try {
            const resp = await fetch(this._apiUrl('editForumTopic'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this._chatId,
                    message_thread_id: topicId,
                    name: name
                })
            });
            if (!resp.ok) {
                const err = await resp.text();
                this._warn(`AskAway/Telegram: _editTopicIcon editForumTopic failed (${resp.status}): ${err}`);
            }
        } catch (e) {
            this._warn(`AskAway/Telegram: _editTopicIcon error: ${e}`);
        }
    }

    // ── Post Question ──────────────────────────────────────────

    /**
     * Post a question to Telegram as a formatted message.
     * If choices are provided, includes inline keyboard buttons.
     * Accepts either plain strings or ParsedChoice-shaped objects {label, value}.
     */
    public async postQuestion(taskId: string, question: string, choices?: TelegramChoice[]): Promise<void> {
        this._log(`AskAway/Telegram: postQuestion called — taskId=${taskId}, enabled=${this._enabled}, hasToken=${!!this._botToken}, hasChatId=${!!this._chatId}`);
        if (!this.isConfigured()) {
            this._log(`AskAway/Telegram: SKIPPED — not configured (enabled=${this._enabled}, token=${!!this._botToken}, chatId=${!!this._chatId})`);
            return;
        }

        // Stop heartbeat — we have a new pending question now
        this._stopHeartbeat();
        this.resetHeartbeatMessage();

        // Clear any stale tasks from previous conversations
        if (this._activeTasks.size > 0) {
            this._log(`AskAway/Telegram: Clearing ${this._activeTasks.size} stale task(s) before new question`);
            this._activeTasks.clear();
        }

        // Resolve workspace name and optional forum thread ID before building message
        const workspaceName = this._workspaceName();
        const topicId = await this._getTopicId(workspaceName);

        try {
            // Format the message with HTML (more reliable than MarkdownV2)
            const fileChanges = this._consumeFileChanges();
            let questionHtml: string;
            try {
                questionHtml = this._markdownToHtml(question);
            } catch (e) {
                this._warn(`AskAway/Telegram: _markdownToHtml failed, using plain text: ${e}`);
                questionHtml = this._escapeHtml(question);
            }
            // Show workspace name in header so user knows which project is asking
            let text = `🔔 <b>AskAway · ${this._escapeHtml(workspaceName)}</b>\n\n${questionHtml}`;

            if (choices && choices.length > 0) {
                text += '\n\n<b>Options:</b>\n';
                choices.forEach((c, i) => {
                    const label = typeof c === 'string' ? c : c.label;
                    text += `${i + 1}. ${this._escapeHtml(label)}\n`;
                });
                text += '\n<i>Reply with the option number or your answer.</i>';
            } else {
                text += '\n\n<i>Reply to this message with your answer.</i>';
            }

            if (fileChanges.length > 0) {
                text += '\n\n📁 <b>Recent Changes:</b>\n';
                const displayFiles = fileChanges.slice(0, 10);
                displayFiles.forEach(f => {
                    text += `• <code>${this._escapeHtml(f)}</code>\n`;
                });
                if (fileChanges.length > 10) {
                    text += `<i>... and ${fileChanges.length - 10} more</i>\n`;
                }
            }

            // Telegram max message length is 4096 chars — truncate if needed
            if (text.length > 4000) {
                text = text.substring(0, 3990) + '\n…(truncated)';
            }

            // Build request body
            const body: any = {
                chat_id: this._chatId,
                text: text,
                parse_mode: 'HTML'
            };
            // Forum topic routing — posts to workspace-specific thread if chat supports it
            if (topicId) { body.message_thread_id = topicId; }

            // Add inline keyboard for choices
            if (choices && choices.length > 0) {
                body.reply_markup = {
                    inline_keyboard: choices.map(c => {
                        const label = typeof c === 'string' ? c : c.label;
                        const value = typeof c === 'string' ? c : c.value;
                        return [{
                            text: label,
                            callback_data: `askaway:${taskId}:${value.substring(0, 60)}`
                        }];
                    })
                };
            }

            const response = await fetch(this._apiUrl('sendMessage'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                this._err(`AskAway/Telegram: SEND FAILED ${response.status}: ${errorText}`);
                // Fallback: try plain text without HTML parse_mode
                const plainBody: any = {
                    chat_id: this._chatId,
                    text: `🔔 AskAway · ${workspaceName}\n\n${question.substring(0, 3900)}`
                };
                if (topicId) { plainBody.message_thread_id = topicId; }
                if (choices && choices.length > 0) {
                    plainBody.reply_markup = body.reply_markup;
                }
                const fallbackResp = await fetch(this._apiUrl('sendMessage'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(plainBody)
                });
                if (!fallbackResp.ok) {
                    this._err(`AskAway/Telegram: FALLBACK SEND ALSO FAILED ${fallbackResp.status}`);
                    return;
                }
                const fallbackResult = await fallbackResp.json() as any;
                const fallbackMsgId = fallbackResult.result?.message_id;
                this._log(`AskAway/Telegram: ✅ Fallback plain-text message sent — taskId=${taskId}, msgId=${fallbackMsgId}`);
                this._activeTasks.set(taskId, {
                    taskId,
                    messageId: fallbackMsgId,
                    topicId,
                    question,
                    choices,
                    timestamp: Date.now(),
                    formattedText: plainBody.text
                });
                // Mark topic as pending.
                void this._editTopicIcon(topicId, workspaceName, true);
                this.stopPolling();
                this._resetBackoff();
                this.startPolling();
                return;
            }

            const result = await response.json() as any;
            const messageId = result.result?.message_id;
            this._log(`AskAway/Telegram: ✅ Message sent — taskId=${taskId}, msgId=${messageId}`);

            this._activeTasks.set(taskId, {
                taskId,
                messageId,
                topicId,
                question,
                choices,
                timestamp: Date.now(),
                formattedText: text   // store rendered HTML body for footer edits
            });

            // Mark topic as pending.
            void this._editTopicIcon(topicId, workspaceName, true);

            // Race-condition guard: if resolveTask was already called for this
            // taskId while we were awaiting the API, clean up immediately.
            if (this._preResolved.has(taskId)) {
                this._preResolved.delete(taskId);
                const task = this._activeTasks.get(taskId)!;
                this._activeTasks.delete(taskId);
                this._markResolvedExternal(task);
                this._log(`AskAway/Telegram: Task ${taskId} was pre-resolved — cleaned up immediately after send`);
                return;
            }

            // Always restart polling from scratch so new questions get fast retries
            // even if a previous polling cycle was still running.
            this.stopPolling();
            this._resetBackoff();
            this.startPolling();
        } catch (error) {
            this._err('AskAway/Telegram: Error posting message', error);
        }
    }

    /** Escape special characters for Telegram HTML */
    private _escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Convert Markdown to Telegram-compatible HTML.
     * Protects code blocks and tables from inline-formatting regexes by
     * extracting them first, processing the remaining text, then restoring.
     *
     * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>,
     * <a href>, <blockquote>.  No <table>/<h1> etc.
     */
    private _markdownToHtml(text: string): string {
        const preserved: string[] = [];
        const hold = (html: string): string => {
            const i = preserved.length;
            preserved.push(html);
            return `\x00P${i}\x00`;
        };

        let r = text;

        // ── 1. Fenced code blocks ```lang\n…\n``` ──
        r = r.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
            const esc = this._escapeHtml(code.replace(/\n$/, ''));
            const attr = lang ? ` class="language-${lang}"` : '';
            return hold(`<pre><code${attr}>${esc}</code></pre>`);
        });

        // ── 2. Inline code `…` ──
        r = r.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
            hold(`<code>${this._escapeHtml(code)}</code>`)
        );

        // ── 3. Markdown tables → box-drawing <pre> ──
        r = r.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (block) =>
            hold(this._formatTable(block))
        );

        // ── 4. Escape remaining HTML chars ──
        r = r.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // ── 5. Headings (#…######) → bold ──
        r = r.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

        // ── 6. Bold **…** / __…__ ──
        r = r.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
        r = r.replace(/__([\s\S]+?)__/g, '<b>$1</b>');

        // ── 7. Italic *…* / _…_ (single markers) ──
        r = r.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
        r = r.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

        // ── 8. Strikethrough ~~…~~ ──
        r = r.replace(/~~(.+?)~~/g, '<s>$1</s>');

        // ── 9. Links [text](url) — must run before image strip ──
        r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">🖼 $1</a>');
        r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

        // ── 10. Blockquotes (&gt; lines) ──
        r = r.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
            const lines = match.split('\n')
                .filter(l => l.startsWith('&gt;'))
                .map(l => l.replace(/^&gt;\s?/, ''));
            return `<blockquote>${lines.join('\n')}</blockquote>\n`;
        });

        // ── 11. Horizontal rules ──
        r = r.replace(/^[-*_]{3,}\s*$/gm, '─────────────────────');

        // ── 12. Bullet lists (- item, * item, + item) → • item ──
        r = r.replace(/^[ \t]*[-*+]\s+(.+)$/gm, '  • $1');

        // ── 13. Numbered lists (1. item) — keep as-is but ensure consistent indent ──
        r = r.replace(/^[ \t]*(\d+)\.\s+(.+)$/gm, '  $1. $2');

        // ── 14. Task lists ──
        r = r.replace(/• \[ \]\s*/g, '☐ ');
        r = r.replace(/• \[x\]\s*/gi, '☑ ');

        // ── 15. Restore protected blocks ──
        r = r.replace(/\x00P(\d+)\x00/g, (_, idx) => preserved[parseInt(idx)]);

        return r;
    }

    /**
     * Convert a markdown table block into a Unicode box-drawing table
     * wrapped in <pre> for Telegram (which has no native HTML table support).
     */
    private _formatTable(block: string): string {
        const rows = block.trim().split('\n').filter(r => r.trim());
        if (rows.length < 2) { return `<pre>${this._escapeHtml(block)}</pre>`; }

        const parsed: string[][] = [];
        let hasSep = false;
        for (const row of rows) {
            // Split on | and drop the leading/trailing empty segments
            const cells = row.split('|').map(c => c.trim());
            // If starts/ends with |, first & last elements are empty strings
            const trimmed = cells.length > 2 && cells[0] === '' && cells[cells.length - 1] === ''
                ? cells.slice(1, -1)
                : cells.filter(c => c !== '');
            // Detect separator row (e.g. | --- | :---: |)
            if (trimmed.every(c => /^[-:]+$/.test(c))) { hasSep = true; continue; }
            parsed.push(trimmed);
        }

        if (!hasSep || parsed.length === 0) { return `<pre>${this._escapeHtml(block)}</pre>`; }

        const numCols = Math.max(...parsed.map(r => r.length));
        const widths: number[] = Array(numCols).fill(3);
        for (let c = 0; c < numCols; c++) {
            for (const row of parsed) {
                if (row[c]) { widths[c] = Math.max(widths[c], row[c].length); }
            }
        }

        const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
        const top = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
        const mid = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
        const bot = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

        const lines: string[] = [top];
        parsed.forEach((row, i) => {
            const cells = widths.map((w, c) => ` ${pad(row[c] || '', w)} `);
            lines.push('│' + cells.join('│') + '│');
            if (i === 0 && parsed.length > 1) { lines.push(mid); }
        });
        lines.push(bot);

        return `<pre>${this._escapeHtml(lines.join('\n'))}</pre>`;
    }

    /** Format a timestamp as 12-hour clock string, e.g. "3:34 PM" */
    private _formatTime(ts: number): string {
        return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    }

    /**
     * Edit the most-recently-posted task's Telegram message to update the
     * sync-time footer.  Only the task with the highest timestamp is updated
     * so old resolved-but-stale tasks are not touched.
     */
    private async _updateMessageFooters(): Promise<void> {
        if (this._activeTasks.size === 0) { return; }

        // Pick only the newest task to update (avoids spamming old messages)
        let newestTask: TrackedTask | undefined;
        for (const task of this._activeTasks.values()) {
            if (!newestTask || task.timestamp > newestTask.timestamp) {
                newestTask = task;
            }
        }
        if (!newestTask) { return; }

        const nextDelaySec = this._getPollDelaySeconds();
        const lastSyncTime = this._formatTime(Date.now());
        const nextSyncTime = this._formatTime(Date.now() + nextDelaySec * 1000);
        const footer = `\n\n<i>🔄 Last sync: ${lastSyncTime} · Next sync: ${nextSyncTime}</i>`;

        try {
            const body: any = {
                chat_id: this._chatId,
                message_id: newestTask.messageId,
                text: newestTask.formattedText + footer,
                parse_mode: 'HTML'
            };
            if (newestTask.choices && newestTask.choices.length > 0) {
                body.reply_markup = {
                    inline_keyboard: newestTask.choices.map(c => ([
                        {
                            text: typeof c === 'string' ? c : c.label,
                            callback_data: `askaway:${newestTask!.taskId}:${(typeof c === 'string' ? c : c.value).substring(0, 60)}`
                        }
                    ]))
                };
            }
            await fetch(this._apiUrl('editMessageText'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (e) {
            // Non-critical — footer update failure should not break polling
        }
    }

    // ── Polling for Replies (with backoff) ─────────────────────

    /**
     * Called by the webview provider whenever a task is resolved through any
     * channel (VS Code UI, remote web UI, autopilot, timeout).
     * Removes the task so polling stops for it and the footer stops updating.
     */
    public resolveTask(taskId: string): void {
        const task = this._activeTasks.get(taskId);

        if (task) {
            // Edit the Telegram message to show it's been answered
            this._markResolvedExternal(task);
        }

        // Clear ALL active tasks — only one ask_user is pending at a time,
        // so any remaining entries are stale from previous conversations.
        const staleCount = this._activeTasks.size;
        if (staleCount > 0) {
            this._activeTasks.clear();
            this._log(`AskAway/Telegram: Cleared all ${staleCount} active task(s) (resolved ${taskId})`);
            this.stopPolling();
        }

        // Also mark as pre-resolved in case postQuestion is still in flight
        this._preResolved.add(taskId);

        // Send "processing" confirmation and start heartbeat
        this.resetHeartbeatMessage();
        this.sendStatusUpdate('🟢 Processing your response...');
        this._ensureHeartbeat();
    }

    /** Edit the Telegram message to show it was answered externally (via VS Code UI) */
    private async _markResolvedExternal(task: TrackedTask): Promise<void> {
        // Truncate question if too long (Telegram 4096 char limit)
        const maxQ = 3500;
        let qText: string;
        try {
            qText = this._markdownToHtml(task.question);
        } catch {
            qText = this._escapeHtml(task.question);
        }
        if (qText.length > maxQ) {
            qText = qText.substring(0, maxQ) + '…';
        }

        const text = `✅ <b>Answered via VS Code</b>\n\n<b>Q:</b> ${qText}`;

        try {
            const resp = await fetch(this._apiUrl('editMessageText'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this._chatId,
                    message_id: task.messageId,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] }
                })
            });
            if (!resp.ok) {
                const errBody = await resp.text();
                this._warn(`AskAway/Telegram: editMessageText failed ${resp.status}: ${errBody}`);
                // Fallback: try without HTML parse_mode
                await fetch(this._apiUrl('editMessageText'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: this._chatId,
                        message_id: task.messageId,
                        text: `✅ Answered via VS Code\n\nQ: ${task.question.substring(0, maxQ)}`,
                        reply_markup: { inline_keyboard: [] }
                    })
                });
            }
        } catch (e) {
            this._warn(`AskAway/Telegram: Failed to mark message as resolved: ${e}`);
        }

        // Clear pending indicator from topic name.
        void this._editTopicIcon(task.topicId, this._workspaceName(), false);
    }

    public startPolling() {
        if (this._pollingTimer) { return; }
        this._pollTickIndex = 0;
        this._pollCount = 0;
        this._pollingStartedAtMs = Date.now();
        this._scheduleNextPoll();
        this._log('AskAway/Telegram: Polling started.');
    }

    private _scheduleNextPoll() {
        if (this._pollingTimer) {
            clearTimeout(this._pollingTimer);
        }
        const delaySec = this._getPollDelaySeconds();
        this._pollingTimer = setTimeout(() => this._poll(), delaySec * 1000);
    }

    private _getPollDelaySeconds(): number {
        const elapsedMs = this._pollingStartedAtMs > 0 ? (Date.now() - this._pollingStartedAtMs) : 0;
        if (elapsedMs >= LONG_WAIT_THRESHOLD_MS) {
            return LONG_WAIT_INTERVAL_SECONDS;
        }

        if (this._pollTickIndex < INITIAL_POLL_BACKOFF_SCHEDULE_S.length) {
            return INITIAL_POLL_BACKOFF_SCHEDULE_S[this._pollTickIndex];
        }
        return this._steadyPollIntervalSeconds;
    }

    private _resetBackoff() {
        this._pollTickIndex = 0;
        this._pollCount = 0;
        this._pollingStartedAtMs = Date.now();
    }

    /**
     * Determine whether a Telegram update is intended for a different VS Code
     * window (different forum topic / different active task). Foreign updates
     * are intentionally NOT acknowledged — leaving them in Telegram's queue so
     * the rightful owner workspace can consume them on its next poll.
     *
     * See `_pollOnce` for the full shared-queue offset algorithm.
     */
    private _isForeignUpdate(update: any): boolean {
        // Callback queries (inline button clicks): ours only if the callback
        // task ID is one of OUR active tasks.
        if (update.callback_query) {
            const cbData: string = update.callback_query.data || '';
            const parts = cbData.split(':');
            if (parts[0] === 'askaway' && parts.length >= 3) {
                const cbTaskId = parts[1];
                return !this._activeTasks.has(cbTaskId);
            }
            // Unknown callback format — keep status quo, treat as ours.
            return false;
        }

        const msg = update.message;
        if (!msg) {
            // Unknown update type — keep status quo, treat as ours.
            return false;
        }

        // Bot commands (/file, /status, /help, /ls): every window participates.
        if (typeof msg.text === 'string' && msg.text.startsWith('/')) {
            return false;
        }

        const msgThreadId: number | undefined = msg.message_thread_id;
        if (msgThreadId === undefined) {
            // Non-forum chat or General topic message — no per-window routing
            // information, so accept (status quo).
            return false;
        }

        // Forum topic message — ours only if one of our active tasks owns the topic.
        const matchesOurTopic = [...this._activeTasks.values()].some(t => t.topicId === msgThreadId);
        return !matchesOurTopic;
    }

    public stopPolling() {
        if (this._pollingTimer) {
            clearTimeout(this._pollingTimer);
            this._pollingTimer = undefined;
            this._pollingStartedAtMs = 0;
            this._log('AskAway/Telegram: Polling stopped.');
        }
    }

    private async _poll(): Promise<void> {
        this._pollingTimer = undefined;

        if (!this.isConfigured()) {
            this._log(`AskAway/Telegram: Poll skipped — not configured`);
            this.stopPolling();
            return;
        }

        // Allow polling even without active tasks when conversation is active
        // (enables bot commands like /file, /ls, /status during Copilot work)
        const hasActiveTasks = this._activeTasks.size > 0;
        const hasActiveConversation = this._conversationActive && this._lastCopilotActivity > 0;

        // Keep polling while tasks are active, even if Copilot is idle.
        // Stopping here causes delayed user replies to be missed.
        if (this._copilotIdleThresholdMs > 0 && this._lastCopilotActivity > 0) {
            if (Date.now() - this._lastCopilotActivity > this._copilotIdleThresholdMs) {
                console.log(`AskAway/Telegram: Copilot idle exceeded ${Math.floor(this._copilotIdleThresholdMs / 60000)}min, continuing polling to catch delayed replies.`);
            }
        }

        this._pollCount++;
        const currentDelaySec = this._getPollDelaySeconds();
        this._log(`AskAway/Telegram: Poll #${this._pollCount} — interval=${currentDelaySec}s, tick=${this._pollTickIndex}, activeTasks=${this._activeTasks.size}`);

        // Cache bot ID
        if (!this._botId) {
            await this._cacheBotId();
        }

        const now = Date.now();

        // Expire old tasks (36 hours)
        for (const [taskId, task] of this._activeTasks.entries()) {
            if (now - task.timestamp > EXPIRY_MS) {
                this._log(`AskAway/Telegram: Task ${taskId} expired (36h), removing.`);
                this._activeTasks.delete(taskId);
            }
        }

        if (this._activeTasks.size === 0 && !hasActiveConversation) {
            this.stopPolling();
            return;
        }

        try {
            // Get updates (messages + callback queries)
            const url = this._apiUrl('getUpdates') + `?offset=${this._lastUpdateId + 1}&timeout=0&allowed_updates=["message","callback_query"]`;
            const resp = await fetch(url);

            if (!resp.ok) {
                this._err(`AskAway/Telegram: Poll HTTP error ${resp.status} ${resp.statusText}`);
                if (resp.status === 409) {
                    // 409 Conflict = another instance is polling the same bot token.
                    // Back off significantly to let the other instance win, then retry.
                    this._warn('AskAway/Telegram: 409 Conflict — another polling instance detected. Backing off 60s before retrying.');
                    this.stopPolling();
                    setTimeout(() => {
                        if (this._activeTasks.size > 0 && this._enabled) {
                            this._pollTickIndex = 0;
                            this.startPolling();
                        }
                    }, 60_000);
                    return;
                }
                if (resp.status === 401) {
                    this._err('AskAway/Telegram: Bot token is invalid or expired.');
                    vscode.window.showErrorMessage(
                        'AskAway: Telegram bot token is invalid. Please update it in settings.',
                        'Open Settings'
                    ).then(action => {
                        if (action === 'Open Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'askaway.telegram.botToken');
                        }
                    });
                    this.stopPolling();
                    return;
                }
            } else {
                const data = await resp.json() as any;
                const updates = data.result || [];

                for (const update of updates) {
                    // ── Shared-queue offset algorithm ──
                    // Determine if this update is intended for another VS Code window
                    // (different forum topic / different active task). If so, leave it
                    // in the Telegram queue — do NOT mark processed and do NOT let our
                    // offset advance past it, since Telegram's getUpdates offset is a
                    // GLOBAL per-bot ACK: any window advancing past update X deletes X
                    // for every other window. The rightful owner will consume + ACK it
                    // on its own poll.
                    if (this._isForeignUpdate(update)) {
                        continue;
                    }
                    // Dedupe: we already handled this update in a previous poll but
                    // couldn't yet ACK it (a foreign message ahead of it kept our offset
                    // pinned). Telegram re-delivers it until our offset moves past — we
                    // just skip work here.
                    if (this._myProcessedSet.has(update.update_id)) {
                        continue;
                    }

                    try {
                    // Handle callback query (inline button click)
                    if (update.callback_query) {
                        const cbData = update.callback_query.data || '';
                        const parts = cbData.split(':');
                        if (parts[0] === 'askaway' && parts.length >= 3) {
                            const cbTaskId = parts[1];
                            const answer = parts.slice(2).join(':');
                            const user = update.callback_query.from?.username
                                || update.callback_query.from?.first_name
                                || 'unknown';

                            if (this._activeTasks.has(cbTaskId)) {
                                this._log(`AskAway/Telegram: Button reply for ${cbTaskId} from ${user}: "${answer.substring(0, 80)}"`); 

                                // Answer the callback to remove the loading indicator
                                await fetch(this._apiUrl('answerCallbackQuery'), {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        callback_query_id: update.callback_query.id,
                                        text: 'Answer received!'
                                    })
                                });

                                if (this._onResponseReceived) {
                                    this._onResponseReceived(cbTaskId, answer, `${user} (via Telegram)`);
                                }

                                // Update message to show resolved
                                await this._markResolved(this._activeTasks.get(cbTaskId)!, answer, user);
                                this._activeTasks.delete(cbTaskId);
                            }
                        }
                        continue;
                    }

                    // Handle text/media message reply
                    const msg = update.message;
                    if (!msg) { continue; }

                    // A message needs either text or some media to be useful
                    const hasText = !!msg.text;
                    const hasCaption = !!msg.caption;
                    const hasMedia = !!(msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.video_note || msg.sticker || msg.animation);
                    if (!hasText && !hasCaption && !hasMedia) { continue; }

                    // Skip messages from the bot itself
                    if (this._botId && msg.from?.id === this._botId) { continue; }

                    // ── Handle bot commands (/file, /status, /help, /ls) ──
                    if (hasText && msg.text.startsWith('/')) {
                        const handled = await this._handleBotCommand(msg);
                        if (handled) { continue; }
                    }

                    // Forum topic routing: if this window's active task is bound to a specific
                    // topic, only accept messages from that same thread. This prevents the
                    // TaskSync window from consuming replies intended for the StockAnalysis
                    // window (both share the same bot token and call getUpdates).
                    const msgThreadId: number | undefined = msg.message_thread_id;
                    if (msgThreadId !== undefined) {
                        // Check if any task in this window owns this topic
                        const taskWithTopic = [...this._activeTasks.values()].find(t => t.topicId !== undefined);
                        if (taskWithTopic) {
                            // This window has topic-aware tasks — only accept messages from our topic
                            const owningTask = [...this._activeTasks.values()].find(t => t.topicId === msgThreadId);
                            if (!owningTask) {
                                // No task in this window owns that topic — skip it
                                this._log(`AskAway/Telegram: Skipping message from thread ${msgThreadId} — not owned by this window`);
                                continue;
                            }
                        }
                        // If no tasks have topicId set (fallback: topic detection failed), accept all
                    }

                    // Check if this is a reply to one of our messages
                    const replyToMsgId = msg.reply_to_message?.message_id;

                    // Fallback A: topic-aware match — user typed in the topic without tapping Reply.
                    // If the message is in a topic thread AND a task owns that topic, accept it directly.
                    if (!replyToMsgId && msgThreadId !== undefined) {
                        const topicTask = [...this._activeTasks.values()].find(t => t.topicId === msgThreadId);
                        if (topicTask) {
                            const answer = (msg.text || msg.caption || '').trim();
                            const user = msg.from?.username || msg.from?.first_name || 'unknown';
                            const msgAttachments = await this._downloadMessageMedia(msg);
                            if (answer || msgAttachments.length > 0) {
                                this._log(`AskAway/Telegram: Topic-message fallback matched task ${topicTask.taskId} (thread ${msgThreadId}) from ${user}: "${(answer || '[attachment]').substring(0, 80)}" attachments=${msgAttachments.length}`);
                                let resolvedAnswer = answer || (msgAttachments.length > 0 ? `[${msgAttachments.map(a => a.name).join(', ')}]` : '');
                                if (topicTask.choices && topicTask.choices.length > 0) {
                                    const num = parseInt(resolvedAnswer, 10);
                                    if (num >= 1 && num <= topicTask.choices.length) {
                                        const c = topicTask.choices[num - 1];
                                        resolvedAnswer = typeof c === 'string' ? c : c.value;
                                    }
                                }
                                if (this._onResponseReceived) {
                                    this._onResponseReceived(topicTask.taskId, resolvedAnswer, `${user} (via Telegram)`, msgAttachments.length > 0 ? msgAttachments : undefined);
                                }
                                await this._markResolved(topicTask, resolvedAnswer, user);
                                this._activeTasks.delete(topicTask.taskId);
                                continue;
                            }
                        }
                    }

                    // Fallback B: if there is exactly one active task, accept plain chat
                    // messages even when Telegram doesn't include reply_to_message.
                    if (!replyToMsgId && this._activeTasks.size === 1) {
                        const onlyTask = this._activeTasks.values().next().value as TrackedTask | undefined;
                        if (onlyTask) {
                            const answer = (msg.text || msg.caption || '').trim();
                            const user = msg.from?.username || msg.from?.first_name || 'unknown';
                            const msgAttachments = await this._downloadMessageMedia(msg);

                            if (!answer && msgAttachments.length === 0) { continue; }

                            this._log(`AskAway/Telegram: Plain-message fallback matched task ${onlyTask.taskId} from ${user}: "${(answer || '[attachment]').substring(0, 80)}" attachments=${msgAttachments.length}`);

                            let resolvedAnswer = answer || (msgAttachments.length > 0 ? `[${msgAttachments.map(a => a.name).join(', ')}]` : '');
                            if (onlyTask.choices && onlyTask.choices.length > 0) {
                                const num = parseInt(resolvedAnswer, 10);
                                if (num >= 1 && num <= onlyTask.choices.length) {
                                    const c = onlyTask.choices[num - 1];
                                    resolvedAnswer = typeof c === 'string' ? c : c.value;
                                }
                            }

                            if (this._onResponseReceived) {
                                this._onResponseReceived(onlyTask.taskId, resolvedAnswer, `${user} (via Telegram)`, msgAttachments.length > 0 ? msgAttachments : undefined);
                            }

                            await this._markResolved(onlyTask, resolvedAnswer, user);
                            this._activeTasks.delete(onlyTask.taskId);
                            continue;
                        }
                    }

                    if (!replyToMsgId) { continue; }

                    // Find the task this reply belongs to
                    for (const [taskId, task] of this._activeTasks.entries()) {
                        if (task.messageId === replyToMsgId) {
                            const answer = (msg.text || msg.caption || '').trim();
                            const user = msg.from?.username || msg.from?.first_name || 'unknown';
                            const msgAttachments = await this._downloadMessageMedia(msg);

                            if (!answer && msgAttachments.length === 0) { continue; }

                            this._log(`AskAway/Telegram: Thread reply for ${taskId} from ${user}: "${(answer || '[attachment]').substring(0, 80)}" attachments=${msgAttachments.length}`);

                            // Resolve choice by number if applicable
                            let resolvedAnswer = answer || (msgAttachments.length > 0 ? `[${msgAttachments.map(a => a.name).join(', ')}]` : '');
                            if (task.choices && task.choices.length > 0) {
                                const num = parseInt(resolvedAnswer, 10);
                                if (num >= 1 && num <= task.choices.length) {
                                    const c = task.choices[num - 1];
                                    resolvedAnswer = typeof c === 'string' ? c : c.value;
                                }
                            }

                            if (this._onResponseReceived) {
                                this._onResponseReceived(taskId, resolvedAnswer, `${user} (via Telegram)`, msgAttachments.length > 0 ? msgAttachments : undefined);
                            }

                            await this._markResolved(task, resolvedAnswer, user);
                            this._activeTasks.delete(taskId);
                            break;
                        }
                    }
                    } finally {
                        // Mark this update as locally processed regardless of whether a
                        // specific fallback matched. Even messages we couldn't route
                        // (e.g. arrived after the matching task was already deleted)
                        // should be marked, so Telegram won't keep re-delivering them.
                        this._myProcessedSet.add(update.update_id);
                    }
                }

                // ── Advance offset past contiguous head of processed-mine messages ──
                // Walk returned updates in update_id order; advance _lastUpdateId past
                // each id that is in our processed set; STOP at the first foreign or
                // unprocessed-mine update. This guarantees we never ACK past a message
                // another window needs to consume.
                let newOffset = this._lastUpdateId;
                for (const u of updates) {
                    if (this._myProcessedSet.has(u.update_id)) {
                        if (u.update_id > newOffset) {
                            newOffset = u.update_id;
                        }
                    } else {
                        break;
                    }
                }
                if (newOffset > this._lastUpdateId) {
                    this._lastUpdateId = newOffset;
                    // Prune set — these ids are gone from Telegram now.
                    for (const id of Array.from(this._myProcessedSet)) {
                        if (id <= newOffset) { this._myProcessedSet.delete(id); }
                    }
                }
                // Safety cap: if our offset is stuck behind a long-lived foreign block
                // and the set keeps growing, bound it. 24h Telegram TTL means this
                // should rarely hit, but cap at 1000 entries.
                if (this._myProcessedSet.size > 1000) {
                    const sorted = Array.from(this._myProcessedSet).sort((a, b) => a - b);
                    for (let i = 0; i < sorted.length - 1000; i++) {
                        this._myProcessedSet.delete(sorted[i]);
                    }
                }
            }
        } catch (error) {
            this._err('AskAway/Telegram: Poll error', error);
        }

        // Advance backoff tick
        this._pollTickIndex++;

        // Update footer on all live messages so user sees sync timestamps
        if (this._activeTasks.size > 0) {
            await this._updateMessageFooters();
        }

        // Schedule next poll if still have tasks or active conversation (for bot commands)
        if (this._activeTasks.size > 0 || (this._conversationActive && this._lastCopilotActivity > 0)) {
            this._scheduleNextPoll();
        } else {
            this.stopPolling();
        }
    }

    // ── Bot Commands ───────────────────────────────────────────

    /**
     * Handle bot commands (/file, /status, /help, /ls).
     * Returns true if the message was a command and was handled.
     */
    private async _handleBotCommand(msg: any): Promise<boolean> {
        const text: string = msg.text.trim();
        const threadId: number | undefined = msg.message_thread_id;
        const parts = text.split(/\s+/);
        const command = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname suffix
        const args = parts.slice(1).join(' ').trim();

        switch (command) {
            case '/file':
            case '/cat':
                if (!args) {
                    await this._sendCommandReply(msg, '📄 <b>Usage:</b> <code>/file &lt;name or path&gt;</code>\n\nSearch for a file in the workspace and view its contents.\nExamples:\n  <code>/file README.md</code>\n  <code>/file src/extension.ts</code>\n  <code>/file package.json</code>');
                    return true;
                }
                await this._handleFileCommand(msg, args);
                return true;

            case '/ls':
            case '/dir':
                await this._handleLsCommand(msg, args);
                return true;

            case '/status':
                await this._sendCommandReply(msg, this.getConversationStatus());
                return true;

            case '/history':
            case '/last':
                await this._handleHistoryCommand(msg, args);
                return true;

            case '/help':
                await this._sendCommandReply(msg, this._getHelpText());
                return true;

            default:
                return false;
        }
    }

    /** Get help text listing available commands */
    private _getHelpText(): string {
        return '🤖 <b>AskAway Bot Commands</b>\n\n' +
            '📄 <code>/file &lt;name&gt;</code> — View a workspace file\n' +
            '📂 <code>/ls [path]</code> — List directory contents\n' +
            '� <code>/history [n]</code> — Show last N conversation exchanges\n' +
            '�📊 <code>/status</code> — Show conversation status\n' +
            '❓ <code>/help</code> — Show this help\n\n' +
            '<i>Tip: You can use partial names — e.g. <code>/file readme</code> finds README.md</i>';
    }

    /**
     * Handle /file <name> — find and send a file's contents.
     * For small text files, sends inline. For large or binary files, sends as document.
     */
    private async _handleFileCommand(msg: any, query: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            await this._sendCommandReply(msg, '⚠️ No workspace folder open.');
            return;
        }

        try {
            // Search for files matching the query
            const matches = await this._findWorkspaceFiles(query);

            if (matches.length === 0) {
                await this._sendCommandReply(msg, `🔍 No files matching "<code>${this._escapeHtml(query)}</code>" found in workspace.`);
                return;
            }

            if (matches.length > 1 && matches.length <= 10) {
                // Multiple matches — ask user to pick
                const fileList = matches.map((m, i) => `${i + 1}. <code>${this._escapeHtml(m.relative)}</code>`).join('\n');
                await this._sendCommandReply(msg, `🔍 Found ${matches.length} files matching "<code>${this._escapeHtml(query)}</code>":\n\n${fileList}\n\n<i>Use the full path: <code>/file ${matches[0].relative}</code></i>`);
                return;
            }

            if (matches.length > 10) {
                await this._sendCommandReply(msg, `🔍 Found ${matches.length} files matching "<code>${this._escapeHtml(query)}</code>". Please be more specific.`);
                return;
            }

            // Exactly one match
            const match = matches[0];
            const fileUri = vscode.Uri.file(match.absolute);

            // Check file size
            const stat = await vscode.workspace.fs.stat(fileUri);
            const sizeKB = stat.size / 1024;

            if (sizeKB > 500) {
                // Large file — send as document
                await this._sendFileAsDocument(msg, match);
                return;
            }

            // Read file content
            const content = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');

            // Check if it's likely binary
            if (this._isBinaryContent(content)) {
                await this._sendFileAsDocument(msg, match);
                return;
            }

            // Send as formatted message
            await this._sendFileContent(msg, match.relative, content);
        } catch (e) {
            this._err('AskAway/Telegram: /file command error', e);
            await this._sendCommandReply(msg, `❌ Error reading file: ${this._escapeHtml(String(e instanceof Error ? e.message : e))}`);
        }
    }

    /**
     * Handle /ls [path] — list directory contents.
     */
    private async _handleLsCommand(msg: any, dirPath: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            await this._sendCommandReply(msg, '⚠️ No workspace folder open.');
            return;
        }

        try {
            const rootPath = workspaceFolders[0].uri.fsPath;
            const targetPath = dirPath ? path.join(rootPath, dirPath) : rootPath;
            const targetUri = vscode.Uri.file(targetPath);

            const entries = await vscode.workspace.fs.readDirectory(targetUri);

            // Sort: folders first, then files
            entries.sort((a, b) => {
                const aIsDir = a[1] === vscode.FileType.Directory;
                const bIsDir = b[1] === vscode.FileType.Directory;
                if (aIsDir !== bIsDir) { return aIsDir ? -1 : 1; }
                return a[0].localeCompare(b[0]);
            });

            // Filter out common noise
            const filtered = entries.filter(([name]) =>
                !name.startsWith('.') || name === '.github' || name === '.vscode'
            );

            const displayPath = dirPath || '.';
            const lines = filtered.slice(0, 50).map(([name, type]) => {
                const icon = type === vscode.FileType.Directory ? '📂' : '📄';
                return `${icon} <code>${this._escapeHtml(name)}${type === vscode.FileType.Directory ? '/' : ''}</code>`;
            });

            let text = `📂 <b>${this._escapeHtml(displayPath)}/</b>\n\n${lines.join('\n')}`;
            if (filtered.length > 50) {
                text += `\n\n<i>... and ${filtered.length - 50} more</i>`;
            }

            await this._sendCommandReply(msg, text);
        } catch (e) {
            this._err('AskAway/Telegram: /ls command error', e);
            await this._sendCommandReply(msg, `❌ Error listing directory: ${this._escapeHtml(String(e instanceof Error ? e.message : e))}`);
        }
    }

    /**
     * Handle /history [n] — show last N conversation exchanges.
     */
    private async _handleHistoryCommand(msg: any, args: string): Promise<void> {
        if (!this._onHistoryRequested) {
            await this._sendCommandReply(msg, '⚠️ Conversation history not available.');
            return;
        }

        const count = Math.min(20, Math.max(1, parseInt(args, 10) || 5));
        const history = this._onHistoryRequested();

        if (history.length === 0) {
            await this._sendCommandReply(msg, '📭 No conversation history yet.');
            return;
        }

        const recent = history.slice(0, count);
        const lines: string[] = [`💬 <b>Last ${recent.length} exchange${recent.length > 1 ? 's' : ''}</b> (of ${history.length} total)\n`];

        for (const entry of recent) {
            const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const statusIcon = entry.status === 'completed' ? '✅' : entry.status === 'pending' ? '⏳' : '❌';

            // Truncate prompt and response for readability
            const promptPreview = entry.prompt.length > 200 ? entry.prompt.substring(0, 200) + '…' : entry.prompt;
            const responsePreview = entry.response.length > 200 ? entry.response.substring(0, 200) + '…' : entry.response;

            lines.push(`${statusIcon} <b>${timeStr}</b>`);
            lines.push(`<b>Q:</b> ${this._escapeHtml(promptPreview)}`);
            if (entry.response) {
                lines.push(`<b>A:</b> ${this._escapeHtml(responsePreview)}`);
            }
            lines.push('');
        }

        const text = lines.join('\n');
        // Telegram message limit
        if (text.length > 4000) {
            await this._sendCommandReply(msg, text.substring(0, 3900) + '\n\n<i>… (truncated)</i>');
        } else {
            await this._sendCommandReply(msg, text);
        }
    }

    /**
     * Find workspace files matching a query string.
     * Supports exact paths, partial names, and glob-like patterns.
     */
    private async _findWorkspaceFiles(query: string): Promise<{ absolute: string; relative: string }[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return []; }

        const rootPath = workspaceFolders[0].uri.fsPath;

        // Try exact path first
        const exactPath = path.join(rootPath, query);
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(exactPath));
            if (stat.type === vscode.FileType.File) {
                return [{ absolute: exactPath, relative: query }];
            }
        } catch {
            // Not found — fall through to search
        }

        // Use VS Code's findFiles for glob search
        // Build patterns: try exact match, then partial match
        const patterns = [
            `**/${query}`,           // exact name anywhere
            `**/${query}*`,          // prefix match
            `**/*${query}*`,         // contains match
        ];

        const seen = new Set<string>();
        const results: { absolute: string; relative: string }[] = [];

        for (const pattern of patterns) {
            if (results.length >= 10) { break; }
            try {
                const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
                for (const file of files) {
                    if (seen.has(file.fsPath)) { continue; }
                    seen.add(file.fsPath);
                    const relative = path.relative(rootPath, file.fsPath);
                    results.push({ absolute: file.fsPath, relative });
                    if (results.length >= 10) { break; }
                }
            } catch {
                // Pattern may be invalid — skip
            }
        }

        return results;
    }

    /** Send a text reply to a command message */
    private async _sendCommandReply(msg: any, text: string): Promise<void> {
        const body: any = {
            chat_id: this._chatId,
            text,
            parse_mode: 'HTML',
            reply_to_message_id: msg.message_id,
            disable_web_page_preview: true
        };
        if (msg.message_thread_id) { body.message_thread_id = msg.message_thread_id; }

        try {
            const resp = await fetch(this._apiUrl('sendMessage'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) {
                const errText = await resp.text();
                this._warn(`AskAway/Telegram: Command reply failed ${resp.status}: ${errText}`);
                // Fallback: try without HTML
                await fetch(this._apiUrl('sendMessage'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...body, parse_mode: undefined, text: text.replace(/<[^>]+>/g, '') })
                });
            }
        } catch (e) {
            this._err('AskAway/Telegram: _sendCommandReply error', e);
        }
    }

    /** Send file content as a formatted Telegram message */
    private async _sendFileContent(msg: any, relativePath: string, content: string): Promise<void> {
        const ext = path.extname(relativePath).toLowerCase();
        const MAX_MSG_LEN = 4000; // Telegram limit is 4096

        let formattedContent: string;

        if (ext === '.md') {
            // Markdown: convert to HTML for Telegram
            try {
                formattedContent = this._markdownToHtml(content);
            } catch {
                formattedContent = `<pre>${this._escapeHtml(content)}</pre>`;
            }
        } else {
            // Code/text files: wrap in <pre> with language hint
            const langMap: Record<string, string> = {
                '.ts': 'typescript', '.js': 'javascript', '.py': 'python',
                '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
                '.sh': 'bash', '.css': 'css', '.html': 'html',
                '.xml': 'xml', '.sql': 'sql', '.rs': 'rust',
                '.go': 'go', '.java': 'java', '.kt': 'kotlin',
                '.swift': 'swift', '.rb': 'ruby', '.php': 'php',
            };
            const lang = langMap[ext] || '';
            formattedContent = `<pre${lang ? ` language="${lang}"` : ''}>${this._escapeHtml(content)}</pre>`;
        }

        // Header
        const header = `📄 <b>${this._escapeHtml(relativePath)}</b>\n\n`;
        const fullText = header + formattedContent;

        if (fullText.length <= MAX_MSG_LEN) {
            await this._sendCommandReply(msg, fullText);
        } else {
            // File is too long — send first chunk + note, then send as document
            const truncated = header + formattedContent.substring(0, MAX_MSG_LEN - header.length - 100) + '\n\n<i>… (truncated, sending full file below)</i>';
            await this._sendCommandReply(msg, truncated);
            await this._sendFileAsDocument(msg, { absolute: path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, relativePath), relative: relativePath });
        }
    }

    /** Send a file as a Telegram document attachment */
    private async _sendFileAsDocument(msg: any, file: { absolute: string; relative: string }): Promise<void> {
        try {
            const fileData = await fs.promises.readFile(file.absolute);
            const boundary = `----FormBoundary${Date.now()}`;
            const fileName = path.basename(file.relative);

            // Build multipart form data
            const parts: Buffer[] = [];
            // chat_id
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this._chatId}\r\n`));
            // reply_to_message_id
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${msg.message_id}\r\n`));
            // thread_id if applicable
            if (msg.message_thread_id) {
                parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${msg.message_thread_id}\r\n`));
            }
            // caption
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n📄 ${file.relative}\r\n`));
            // document
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
            parts.push(fileData);
            parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

            const body = Buffer.concat(parts);

            const resp = await fetch(this._apiUrl('sendDocument'), {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body
            });

            if (!resp.ok) {
                const errText = await resp.text();
                this._warn(`AskAway/Telegram: sendDocument failed ${resp.status}: ${errText}`);
                await this._sendCommandReply(msg, `❌ Failed to send file (${Math.round(fileData.length / 1024)}KB). It may be too large for Telegram (50MB limit).`);
            }
        } catch (e) {
            this._err('AskAway/Telegram: _sendFileAsDocument error', e);
            await this._sendCommandReply(msg, `❌ Error sending file: ${this._escapeHtml(String(e instanceof Error ? e.message : e))}`);
        }
    }

    /** Check if content appears to be binary */
    private _isBinaryContent(content: string): boolean {
        // Check first 1000 chars for null bytes or high ratio of non-printable chars
        const sample = content.substring(0, 1000);
        let nonPrintable = 0;
        for (let i = 0; i < sample.length; i++) {
            const code = sample.charCodeAt(i);
            if (code === 0) { return true; }
            if (code < 32 && code !== 9 && code !== 10 && code !== 13) { nonPrintable++; }
        }
        return nonPrintable / sample.length > 0.1;
    }

    /** Edit the original message to show it's been resolved */
    private async _markResolved(task: TrackedTask, answer: string, user: string): Promise<void> {
        const maxQ = 3000;
        let qText: string;
        try {
            qText = this._markdownToHtml(task.question);
        } catch {
            qText = this._escapeHtml(task.question);
        }
        if (qText.length > maxQ) { qText = qText.substring(0, maxQ) + '…'; }

        const text = `✅ <b>Resolved</b>\n\n` +
            `<b>Q:</b> ${qText}\n` +
            `<b>A:</b> ${this._escapeHtml(answer)}\n` +
            `<b>By:</b> ${this._escapeHtml(user)}`;

        try {
            const resp = await fetch(this._apiUrl('editMessageText'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this._chatId,
                    message_id: task.messageId,
                    text: text,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [] }
                })
            });
            if (!resp.ok) {
                const errBody = await resp.text();
                this._warn(`AskAway/Telegram: _markResolved editMessageText failed ${resp.status}: ${errBody}`);
                // Fallback: plain text without HTML parse_mode
                await fetch(this._apiUrl('editMessageText'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: this._chatId,
                        message_id: task.messageId,
                        text: `✅ Resolved\n\nQ: ${task.question.substring(0, maxQ)}\nA: ${answer}\nBy: ${user}`,
                        reply_markup: { inline_keyboard: [] }
                    })
                });
            }
        } catch (e) {
            this._warn(`AskAway/Telegram: Failed to update resolved message: ${e}`);
        }

        // Clear pending indicator from topic name.
        void this._editTopicIcon(task.topicId, this._workspaceName(), false);
    }

    // ── Public API ─────────────────────────────────────────────

    public getActiveTaskCount(): number {
        return this._activeTasks.size;
    }

    /** Track a file change for inclusion in the next message */
    public trackFileChange(relativePath: string) {
        if (!this._recentFileChanges.includes(relativePath)) {
            this._recentFileChanges.push(relativePath);
        }
    }

    private _consumeFileChanges(): string[] {
        const changes = [...this._recentFileChanges];
        this._recentFileChanges = [];
        return changes;
    }

    // ── Copilot Activity Tracking ─────────────────────────────

    public notifyCopilotActivity() {
        this._lastCopilotActivity = Date.now();
        this._conversationActive = true;
        this._ensureHeartbeat();
        // Start polling for bot commands (/file, /ls, /status) even without active tasks
        if (this.isConfigured() && !this._pollingTimer) {
            this.startPolling();
        }
    }

    public notifyCopilotStopped() {
        this._lastCopilotActivity = 0;
        this._stopHeartbeat();
    }

    /** Called when ask_user is invoked (Copilot is now waiting for input) */
    public notifyToolCallStarted() {
        this._lastToolCallStarted = Date.now();
        this._conversationActive = true;
    }

    /** Called when ask_user returns (user responded, Copilot processing) */
    public notifyToolCallReturned() {
        this._lastToolCallReturned = Date.now();
        this._conversationActive = true;
    }

    /** Called when the session is explicitly ended */
    public notifySessionEnded() {
        this._conversationActive = false;
        this._lastToolCallStarted = 0;
        this._lastToolCallReturned = 0;
        this._stopHeartbeat();
    }

    /**
     * Build a human-readable status string for the /status command.
     */
    public getConversationStatus(): string {
        const now = Date.now();
        const lines: string[] = [];

        if (this._activeTasks.size > 0) {
            const oldest = [...this._activeTasks.values()].reduce((a, b) => a.timestamp < b.timestamp ? a : b);
            const waitMin = Math.round((now - oldest.timestamp) / 60_000);
            lines.push(`⏳ <b>Waiting for your response</b> (${waitMin}m)`);
            lines.push(`   ${this._activeTasks.size} pending question${this._activeTasks.size > 1 ? 's' : ''}`);
            if (this._pollingTimer) {
                const nextDelay = this._getPollDelaySeconds();
                lines.push(`   Next poll in ~${nextDelay}s`);
            }
        } else if (this._conversationActive && this._lastToolCallReturned > 0) {
            const workMin = Math.round((now - this._lastToolCallReturned) / 60_000);
            lines.push(`🟢 <b>Copilot is working</b> (${workMin}m since last response)`);
        } else if (this._conversationActive && this._lastCopilotActivity > 0) {
            const actMin = Math.round((now - this._lastCopilotActivity) / 60_000);
            if (actMin > 15) {
                lines.push(`⏸ <b>Session may have ended</b> (no activity for ${actMin}m)`);
            } else {
                lines.push(`🟢 <b>Copilot is active</b> (last activity ${actMin}m ago)`);
            }
        } else {
            lines.push('⚫ <b>No active session</b>');
        }

        if (this._lastCopilotActivity > 0) {
            lines.push(`\nLast file change: ${this._formatTime(this._lastCopilotActivity)}`);
        }
        if (this._lastToolCallStarted > 0) {
            lines.push(`Last ask_user: ${this._formatTime(this._lastToolCallStarted)}`);
        }
        if (this._lastToolCallReturned > 0) {
            lines.push(`Last response: ${this._formatTime(this._lastToolCallReturned)}`);
        }

        return lines.join('\n');
    }

    // ── Heartbeat: periodic "still working" notifications ─────

    /**
     * Send a lightweight status message to Telegram.
     * Reuses (edits) the same message to avoid spamming the chat.
     */
    public async sendStatusUpdate(status: string): Promise<void> {
        if (!this.isConfigured()) { return; }
        // Throttle: don't send more than once per 30 seconds
        if (Date.now() - this._lastStatusSentAt < 30_000) { return; }
        this._lastStatusSentAt = Date.now();

        const text = `<i>${this._escapeHtml(status)}</i>`;
        try {
            if (this._lastHeartbeatMsgId) {
                // Edit existing status message
                await fetch(this._apiUrl('editMessageText'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: this._chatId,
                        message_id: this._lastHeartbeatMsgId,
                        text,
                        parse_mode: 'HTML'
                    })
                });
            } else {
                // Send new status message — route to workspace topic if forum
                const wsName = this._workspaceName();
                const threadId = this._topicIds.get(wsName);
                const newMsgBody: any = {
                    chat_id: this._chatId,
                    text,
                    parse_mode: 'HTML',
                    disable_notification: true
                };
                if (threadId) { newMsgBody.message_thread_id = threadId; }
                const resp = await fetch(this._apiUrl('sendMessage'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newMsgBody)
                });
                if (resp.ok) {
                    const data = await resp.json() as any;
                    this._lastHeartbeatMsgId = data.result?.message_id;
                }
            }
        } catch {
            // Non-critical
        }
    }

    /** Start the heartbeat timer if not already running and no active ask_user */
    private _ensureHeartbeat(): void {
        if (this._heartbeatTimer) { return; }
        if (this._activeTasks.size > 0) { return; }   // ask_user is pending, no heartbeat needed
        if (!this.isConfigured()) { return; }

        this._heartbeatTimer = setInterval(async () => {
            // Only send heartbeat when Copilot is active AND no ask_user is pending
            if (this._activeTasks.size > 0) {
                this._stopHeartbeat();
                return;
            }
            if (this._lastCopilotActivity === 0) {
                this._stopHeartbeat();
                return;
            }
            const elapsed = Date.now() - this._lastCopilotActivity;
            if (elapsed > this._heartbeatIntervalMs * 3) {
                // Copilot hasn't done anything in 3x the interval — likely idle
                this._stopHeartbeat();
                return;
            }

            const elapsedMin = Math.round(elapsed / 60_000);
            const now = this._formatTime(Date.now());
            await this.sendStatusUpdate(`🟢 Copilot is working... (${elapsedMin}m active, updated ${now})`);
        }, this._heartbeatIntervalMs);
    }

    private _stopHeartbeat(): void {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = undefined;
        }
    }

    /** Reset the heartbeat message so the next status sends a new message */
    public resetHeartbeatMessage(): void {
        this._lastHeartbeatMsgId = undefined;
    }

    // ── Get Chat ID helper ─────────────────────────────────────

    /**
     * Fetch recent updates to find the chat ID.
     * User should send a message to the bot first.
     */
    public async getChatId(): Promise<string | undefined> {
        if (!this._botToken) {
            vscode.window.showErrorMessage('AskAway: Set your Telegram Bot Token first.');
            return undefined;
        }

        try {
            const resp = await fetch(this._apiUrl('getUpdates') + '?limit=5');
            if (!resp.ok) {
                vscode.window.showErrorMessage(`AskAway: Failed to get updates: ${resp.status}`);
                return undefined;
            }

            const data = await resp.json() as any;
            const updates = data.result || [];

            if (updates.length === 0) {
                vscode.window.showInformationMessage(
                    'AskAway: No messages found. Send any message to your bot on Telegram first, then try again.'
                );
                return undefined;
            }

            // Get the most recent chat ID
            const chatId = updates[updates.length - 1].message?.chat?.id?.toString();
            if (chatId) {
                // Save to settings
                const config = vscode.workspace.getConfiguration('askaway');
                await config.update('telegram.chatId', chatId, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`AskAway: Telegram Chat ID set to ${chatId}`);
                this.reloadConfig();
                return chatId;
            }

            vscode.window.showWarningMessage('AskAway: Could not determine chat ID from recent messages.');
            return undefined;
        } catch (e) {
            console.error('AskAway/Telegram: getChatId error:', e);
            vscode.window.showErrorMessage('AskAway: Failed to fetch Telegram updates.');
            return undefined;
        }
    }

    public dispose() {
        this.stopPolling();
        this._stopHeartbeat();
        this._activeTasks.clear();
    }
}

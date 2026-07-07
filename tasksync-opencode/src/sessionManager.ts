/**
 * Session Manager — tracks multiple OpenCode sessions connecting to the central server.
 * Each session = one OpenCode instance with a WebSocket connection.
 */

import { EventEmitter } from 'events';

export interface PendingQuestion {
    id: string;
    question: string;
    timestamp: number;
    resolve: (response: SessionResponse) => void;
}

export interface SessionResponse {
    response: string;
    attachments?: string[];
}

export interface HistoryEntry {
    id: string;
    question: string;
    response?: string;
    timestamp: number;
    resolvedAt?: number;
    tokenEstimate?: { question: number; response: number };
}

export interface Session {
    id: string;
    name: string;           // workspace name or label
    connectedAt: number;
    lastActivity: number;
    pending: PendingQuestion | null;
    history: HistoryEntry[];
    tokenUsage: { totalInput: number; totalOutput: number };
}

export class SessionManager extends EventEmitter {
    private sessions = new Map<string, Session>();
    private nextId = 1;

    createSession(name?: string): Session {
        const id = `session_${this.nextId++}_${Date.now()}`;
        const session: Session = {
            id,
            name: name || `OpenCode-${this.nextId - 1}`,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            pending: null,
            history: [],
            tokenUsage: { totalInput: 0, totalOutput: 0 },
        };
        this.sessions.set(id, session);
        this.emit('session-created', session);
        return session;
    }

    removeSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            // Reject any pending question
            if (session.pending) {
                session.pending.resolve({ response: '[session disconnected]' });
            }
            this.sessions.delete(sessionId);
            this.emit('session-removed', sessionId);
        }
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId);
    }

    getAllSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Post a question from an OpenCode session. Returns a promise that resolves
     * when the user replies (via web UI or Telegram).
     */
    postQuestion(sessionId: string, question: string): Promise<SessionResponse> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return Promise.reject(new Error(`Session ${sessionId} not found`));
        }

        // If there's already a pending question, resolve it as superseded
        if (session.pending) {
            session.pending.resolve({ response: '[superseded by new question]' });
        }

        const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return new Promise<SessionResponse>((resolve) => {
            session.pending = { id: questionId, question, timestamp: Date.now(), resolve };
            session.lastActivity = Date.now();

            // Add to history (response filled in later)
            const inputTokens = this.estimateTokens(question);
            session.history.push({
                id: questionId,
                question,
                timestamp: Date.now(),
                tokenEstimate: { question: inputTokens, response: 0 },
            });
            session.tokenUsage.totalInput += inputTokens;

            this.emit('question-posted', { sessionId, questionId, question });
        });
    }

    /**
     * Submit a response to a session's pending question.
     */
    respondToSession(sessionId: string, response: string, attachments?: string[]): boolean {
        const session = this.sessions.get(sessionId);
        if (!session?.pending) {
            return false;
        }

        const questionId = session.pending.id;
        session.pending.resolve({ response, attachments });
        session.pending = null;
        session.lastActivity = Date.now();

        // Update history
        const entry = session.history.find(h => h.id === questionId);
        if (entry) {
            entry.response = response;
            entry.resolvedAt = Date.now();
            const outputTokens = this.estimateTokens(response);
            entry.tokenEstimate = { ...entry.tokenEstimate!, response: outputTokens };
            session.tokenUsage.totalOutput += outputTokens;
        }

        this.emit('question-resolved', { sessionId, questionId, response });
        return true;
    }

    /**
     * Find session with a pending question (for Telegram routing when there's only one).
     */
    getSessionsWithPending(): Session[] {
        return this.getAllSessions().filter(s => s.pending !== null);
    }

    /**
     * Rough token estimation: ~4 chars per token for English text.
     */
    estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    getAggregateTokenUsage(): { totalInput: number; totalOutput: number; sessions: number } {
        let totalInput = 0;
        let totalOutput = 0;
        for (const session of this.sessions.values()) {
            totalInput += session.tokenUsage.totalInput;
            totalOutput += session.tokenUsage.totalOutput;
        }
        return { totalInput, totalOutput, sessions: this.sessions.size };
    }
}

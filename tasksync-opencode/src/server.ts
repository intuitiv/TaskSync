/**
 * Central HTTP + WebSocket server.
 * - HTTP: serves web UI dashboard + REST API
 * - WebSocket: handles relay connections from OpenCode instances
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './sessionManager.js';
import { TelegramBot } from './telegram.js';

const DEFAULT_PORT = 4350;

interface RelayConnection {
    ws: WebSocket;
    sessionId: string;
}

export class CentralServer {
    private httpServer: http.Server;
    private wss: WebSocketServer;
    private sessionManager: SessionManager;
    private telegramBot: TelegramBot;
    private relays = new Map<string, RelayConnection>();  // sessionId → relay
    private uiClients = new Set<WebSocket>();              // web UI connections

    constructor() {
        this.sessionManager = new SessionManager();
        this.telegramBot = new TelegramBot(this.sessionManager);
        this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
        this.wss = new WebSocketServer({ server: this.httpServer });
        this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));
        this.setupSessionEvents();
    }

    start(port: number = DEFAULT_PORT): Promise<number> {
        return new Promise((resolve, reject) => {
            this.httpServer.listen(port, '127.0.0.1', () => {
                const addr = this.httpServer.address();
                const actualPort = typeof addr === 'object' && addr ? addr.port : port;
                console.log(`[AskAway] Server running at http://127.0.0.1:${actualPort}`);
                console.log(`[AskAway] Web dashboard: http://127.0.0.1:${actualPort}`);
                console.log(`[AskAway] Relay endpoint: ws://127.0.0.1:${actualPort}/relay`);
                // Start Telegram bot
                this.telegramBot.start();
                resolve(actualPort);
            });
            this.httpServer.on('error', reject);
        });
    }

    stop(): void {
        this.telegramBot.stop();
        this.wss.close();
        this.httpServer.close();
    }

    getSessionManager(): SessionManager {
        return this.sessionManager;
    }

    // ── HTTP handler ──

    private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        // CORS for local dev
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        // API routes
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
            return this.apiGetSessions(res);
        }
        if (url.pathname === '/api/respond' && req.method === 'POST') {
            return this.apiRespond(req, res);
        }
        if (url.pathname === '/api/tokens' && req.method === 'GET') {
            return this.apiGetTokens(res);
        }
        if (url.pathname === '/api/plugin-stats' && req.method === 'POST') {
            return this.apiPluginStats(req, res);
        }

        // Serve web UI
        if (url.pathname === '/' || url.pathname === '/index.html') {
            return this.serveWebUI(res);
        }

        res.writeHead(404);
        res.end('Not Found');
    }

    private apiGetSessions(res: http.ServerResponse): void {
        const sessions = this.sessionManager.getAllSessions().map(s => ({
            id: s.id,
            name: s.name,
            connectedAt: s.connectedAt,
            lastActivity: s.lastActivity,
            pending: s.pending ? { id: s.pending.id, question: s.pending.question, timestamp: s.pending.timestamp } : null,
            historyCount: s.history.length,
            history: s.history.slice(-20),  // last 20 entries
            tokenUsage: s.tokenUsage,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
    }

    private apiRespond(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 100_000) { req.destroy(); return; }
        });
        req.on('end', () => {
            try {
                const { sessionId, response } = JSON.parse(body);
                if (!sessionId || !response) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'sessionId and response required' }));
                    return;
                }
                const ok = this.sessionManager.respondToSession(sessionId, response);
                res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok }));
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }

    private apiGetTokens(res: http.ServerResponse): void {
        const usage = this.sessionManager.getAggregateTokenUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(usage));
    }

    // Plugin stats from OpenCode plugin — stores real token data from LLM
    private pluginStats: any[] = [];

    private apiPluginStats(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > 500_000) { req.destroy(); return; }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                this.pluginStats.push({ ...data, receivedAt: Date.now() });
                // Keep last 1000 entries
                if (this.pluginStats.length > 1000) this.pluginStats.splice(0, this.pluginStats.length - 1000);
                console.log(`[AskAway] Plugin stats: ${data.type} — in:${data.step?.input ?? 0} out:${data.step?.output ?? 0} cost:$${(data.step?.cost ?? 0).toFixed(4)}`);
                // Broadcast to web UI
                this.broadcastToUI();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }

    private serveWebUI(res: http.ServerResponse): void {
        const htmlPath = path.join(__dirname, '..', 'web', 'index.html');
        try {
            const html = fs.readFileSync(htmlPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } catch {
            // Fallback: serve inline minimal HTML
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this.getInlineHTML());
        }
    }

    // ── WebSocket handler ──

    private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (url.pathname === '/ui') {
            // Web UI client
            this.uiClients.add(ws);
            ws.on('close', () => this.uiClients.delete(ws));
            // Send current state
            this.broadcastToUI();
            return;
        }

        // Relay connection (from OpenCode instances)
        const sessionName = url.searchParams.get('name') || undefined;
        const session = this.sessionManager.createSession(sessionName);

        const relay: RelayConnection = { ws, sessionId: session.id };
        this.relays.set(session.id, relay);

        console.log(`[AskAway] Relay connected: ${session.name} (${session.id})`);

        // Send session info back to relay
        ws.send(JSON.stringify({ type: 'session-created', sessionId: session.id, name: session.name }));

        ws.on('message', (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleRelayMessage(session.id, msg);
            } catch (e) {
                console.error('[AskAway] Invalid relay message:', e);
            }
        });

        ws.on('close', () => {
            console.log(`[AskAway] Relay disconnected: ${session.name}`);
            this.relays.delete(session.id);
            this.sessionManager.removeSession(session.id);
        });
    }

    private async handleRelayMessage(sessionId: string, msg: any): Promise<void> {
        if (msg.type === 'ask_user') {
            const { requestId, question } = msg;

            // Post question and wait for response
            const response = await this.sessionManager.postQuestion(sessionId, question);

            // Send response back to relay
            const relay = this.relays.get(sessionId);
            if (relay && relay.ws.readyState === WebSocket.OPEN) {
                relay.ws.send(JSON.stringify({
                    type: 'response',
                    requestId,
                    response: response.response,
                    attachments: response.attachments || [],
                }));
            }
        }
    }

    // ── Session events → UI broadcast ──

    private setupSessionEvents(): void {
        this.sessionManager.on('session-created', () => this.broadcastToUI());
        this.sessionManager.on('session-removed', () => this.broadcastToUI());
        this.sessionManager.on('question-posted', () => this.broadcastToUI());
        this.sessionManager.on('question-resolved', () => this.broadcastToUI());
    }

    private broadcastToUI(): void {
        const sessions = this.sessionManager.getAllSessions().map(s => ({
            id: s.id,
            name: s.name,
            connectedAt: s.connectedAt,
            lastActivity: s.lastActivity,
            pending: s.pending ? { id: s.pending.id, question: s.pending.question, timestamp: s.pending.timestamp } : null,
            historyCount: s.history.length,
            history: s.history.slice(-20),
            tokenUsage: s.tokenUsage,
        }));
        const payload = JSON.stringify({ type: 'state', sessions });
        for (const client of this.uiClients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }

    private getInlineHTML(): string {
        return `<!DOCTYPE html>
<html><head><title>AskAway</title><meta charset="utf-8">
<style>body{font-family:system-ui;background:#1e1e2e;color:#cdd6f4;margin:0;padding:20px}
h1{color:#89b4fa}.session{background:#313244;border-radius:8px;padding:16px;margin:12px 0}
.pending{border-left:4px solid #f38ba8}.question{color:#f9e2af;white-space:pre-wrap}
.reply-box{display:flex;gap:8px;margin-top:8px}input{flex:1;padding:8px;border-radius:4px;border:1px solid #585b70;background:#45475a;color:#cdd6f4}
button{padding:8px 16px;border-radius:4px;border:none;background:#89b4fa;color:#1e1e2e;cursor:pointer}
.tokens{color:#a6adc8;font-size:0.85em}.history-entry{padding:4px 0;border-bottom:1px solid #45475a}
.history-q{color:#89b4fa}.history-a{color:#a6e3a1}
.empty{color:#6c7086;text-align:center;padding:40px}
</style></head><body>
<h1>AskAway Dashboard</h1>
<div id="app" class="empty">Connecting...</div>
<script>
const ws = new WebSocket('ws://' + location.host + '/ui');
const app = document.getElementById('app');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'state') render(msg.sessions);
};
ws.onclose = () => { app.innerHTML = '<div class="empty">Disconnected. Reload to reconnect.</div>'; };

function render(sessions) {
  if (!sessions.length) { app.innerHTML = '<div class="empty">No active sessions. Start an OpenCode instance with the AskAway relay.</div>'; return; }
  app.innerHTML = sessions.map(s => {
    const pending = s.pending ? '<div class="question">' + esc(s.pending.question) + '</div>' +
      '<div class="reply-box"><input id="reply-' + s.id + '" placeholder="Type your reply..." onkeydown="if(event.key===\\'Enter\\')sendReply(\\'' + s.id + '\\')">' +
      '<button onclick="sendReply(\\'' + s.id + '\\')">Send</button></div>' : '<div style="color:#6c7086">No pending question</div>';
    const history = (s.history || []).slice(-5).map(h =>
      '<div class="history-entry"><span class="history-q">Q:</span> ' + esc(h.question.substring(0,100)) +
      (h.response ? '<br><span class="history-a">A:</span> ' + esc(h.response.substring(0,100)) : ' <em>(pending)</em>') + '</div>'
    ).join('');
    return '<div class="session' + (s.pending ? ' pending' : '') + '">' +
      '<h3>' + esc(s.name) + ' <span class="tokens">[~' + s.tokenUsage.totalInput + ' in / ~' + s.tokenUsage.totalOutput + ' out tokens]</span></h3>' +
      pending + (history ? '<details><summary>History (' + s.historyCount + ')</summary>' + history + '</details>' : '') +
      '</div>';
  }).join('');
}

function sendReply(sessionId) {
  const input = document.getElementById('reply-' + sessionId);
  if (!input || !input.value.trim()) return;
  fetch('/api/respond', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId, response: input.value.trim() })
  }).then(r => r.json()).then(r => { if (r.ok) input.value = ''; });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
</script></body></html>`;
    }
}

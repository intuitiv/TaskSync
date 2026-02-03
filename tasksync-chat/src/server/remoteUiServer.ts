import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';

// Session info for registry
export interface SessionInfo {
    id: string;
    workspaceName: string;
    port: number;
    startTime: number;
    pin: string;
}

// Message types (mirrored from webviewProvider)
export type RemoteMessage = {
    type: string;
    [key: string]: unknown;
};

/**
 * RemoteUiServer - Serves the TaskSync UI to browsers/mobile devices
 * Provides identical functionality to the VS Code webview
 */
export class RemoteUiServer implements vscode.Disposable {
    private _app: express.Application;
    private _server: http.Server | null = null;
    private _io: SocketIOServer | null = null;
    private _port: number = 0;
    private _pin: string;
    private _sessionId: string;
    private _authenticatedSockets: Set<string> = new Set();
    private _disposables: vscode.Disposable[] = [];

    // Callback to handle incoming messages from web clients
    private _onMessageCallback: ((message: RemoteMessage, respond: (msg: RemoteMessage) => void) => void) | null = null;

    // Callback to get current state for new connections
    private _getStateCallback: (() => {
        queue: unknown[];
        queueEnabled: boolean;
        currentSession: unknown[];
        persistedHistory: unknown[];
        pendingRequest: { id: string; prompt: string; isApprovalQuestion: boolean; choices?: unknown[] } | null;
        settings: { soundEnabled: boolean; interactiveApprovalEnabled: boolean; reusablePrompts: unknown[] };
    }) | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._app = express();
        this._pin = this._generatePin();
        this._sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        this._setupRoutes();
    }

    /**
     * Generate a 4-digit PIN for authentication
     */
    private _generatePin(): string {
        return Math.floor(1000 + Math.random() * 9000).toString();
    }

    /**
     * Get local network IP addresses
     */
    private _getLocalIPs(): string[] {
        const interfaces = os.networkInterfaces();
        const ips: string[] = [];
        
        for (const name of Object.keys(interfaces)) {
            const netInterface = interfaces[name];
            if (!netInterface) continue;
            
            for (const iface of netInterface) {
                // Skip internal and non-IPv4 addresses
                if (iface.internal || iface.family !== 'IPv4') continue;
                ips.push(iface.address);
            }
        }
        
        return ips;
    }

    /**
     * Setup Express routes
     */
    private _setupRoutes(): void {
        // Serve static files from media folder
        const mediaPath = path.join(this._extensionUri.fsPath, 'media');
        this._app.use('/media', express.static(mediaPath));

        // Serve codicons
        const codiconsPath = path.join(this._extensionUri.fsPath, 'node_modules', '@vscode', 'codicons', 'dist');
        this._app.use('/codicons', express.static(codiconsPath));

        // Serve PWA manifest
        this._app.get('/manifest.json', (_req, res) => {
            res.json(this._getManifest());
        });

        // Serve service worker
        this._app.get('/sw.js', (_req, res) => {
            res.type('application/javascript');
            res.send(this._getServiceWorker());
        });

        // API: Get session info (for dashboard)
        this._app.get('/api/sessions', (_req, res) => {
            const sessions = this._getAllSessions();
            res.json(sessions);
        });

        // Landing page (PIN entry / session selector)
        this._app.get('/', (req, res) => {
            // If PIN is provided in URL, redirect to app
            const pin = req.query.pin as string;
            if (pin && pin === this._pin) {
                res.redirect(`/app?pin=${pin}`);
                return;
            }
            res.send(this._getLandingHtml());
        });

        // Main app page (requires PIN via query param or cookie)
        this._app.get('/app', (req, res) => {
            const pin = req.query.pin as string || '';
            if (pin !== this._pin) {
                res.redirect('/?error=invalid_pin');
                return;
            }
            res.send(this._getAppHtml());
        });
    }

    /**
     * Start the server
     */
    public async start(preferredPort?: number): Promise<number> {
        const startPort = preferredPort || 3000;
        this._port = await this._findAvailablePort(startPort);

        return new Promise((resolve, reject) => {
            this._server = this._app.listen(this._port, '0.0.0.0', () => {
                this._setupSocketIO();
                this._registerSession();
                resolve(this._port);
            });

            this._server.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Find an available port starting from the given port
     */
    private async _findAvailablePort(startPort: number): Promise<number> {
        let port = startPort;
        const maxAttempts = 100;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                await this._checkPort(port);
                return port;
            } catch {
                port++;
            }
        }

        throw new Error(`Could not find available port after ${maxAttempts} attempts`);
    }

    /**
     * Check if a port is available
     */
    private _checkPort(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer();
            server.listen(port, '0.0.0.0');
            server.on('listening', () => {
                server.close();
                resolve();
            });
            server.on('error', reject);
        });
    }

    /**
     * Setup Socket.IO for real-time communication
     */
    private _setupSocketIO(): void {
        if (!this._server) return;

        this._io = new SocketIOServer(this._server, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });

        this._io.on('connection', (socket: Socket) => {
            console.log('[TaskSync Remote] Client connected:', socket.id);

            // Handle authentication
            socket.on('authenticate', (data: { pin: string }) => {
                if (data.pin === this._pin) {
                    this._authenticatedSockets.add(socket.id);
                    socket.emit('authenticated', { success: true });
                    
                    // Send current state to newly authenticated client
                    if (this._getStateCallback) {
                        const state = this._getStateCallback();
                        socket.emit('initialState', state);
                    }
                } else {
                    socket.emit('authenticated', { success: false, error: 'Invalid PIN' });
                }
            });

            // Handle messages from authenticated clients
            socket.on('message', (message: RemoteMessage) => {
                if (!this._authenticatedSockets.has(socket.id)) {
                    socket.emit('error', { message: 'Not authenticated' });
                    return;
                }

                if (this._onMessageCallback) {
                    this._onMessageCallback(message, (response) => {
                        socket.emit('message', response);
                    });
                }
            });

            socket.on('disconnect', () => {
                console.log('[TaskSync Remote] Client disconnected:', socket.id);
                this._authenticatedSockets.delete(socket.id);
            });
        });
    }

    /**
     * Broadcast a message to all authenticated clients
     */
    public broadcast(message: RemoteMessage): void {
        if (!this._io) return;

        for (const socketId of this._authenticatedSockets) {
            this._io.to(socketId).emit('message', message);
        }
    }

    /**
     * Set callback for handling incoming messages
     */
    public onMessage(callback: (message: RemoteMessage, respond: (msg: RemoteMessage) => void) => void): void {
        this._onMessageCallback = callback;
    }

    /**
     * Set callback for getting current state
     */
    public onGetState(callback: () => {
        queue: unknown[];
        queueEnabled: boolean;
        currentSession: unknown[];
        persistedHistory: unknown[];
        pendingRequest: { id: string; prompt: string; isApprovalQuestion: boolean; choices?: unknown[] } | null;
        settings: { soundEnabled: boolean; interactiveApprovalEnabled: boolean; reusablePrompts: unknown[] };
    }): void {
        this._getStateCallback = callback;
    }

    /**
     * Register this session in globalState
     */
    private _registerSession(): void {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceName = workspaceFolders?.[0]?.name || 'Untitled Workspace';

        const session: SessionInfo = {
            id: this._sessionId,
            workspaceName,
            port: this._port,
            startTime: Date.now(),
            pin: this._pin
        };

        const sessions = this._context.globalState.get<SessionInfo[]>('tasksync.remoteSessions', []);
        // Remove any stale sessions for this workspace/port
        const filtered = sessions.filter(s => s.port !== this._port);
        filtered.push(session);
        this._context.globalState.update('tasksync.remoteSessions', filtered);
    }

    /**
     * Unregister this session from globalState
     */
    private _unregisterSession(): void {
        const sessions = this._context.globalState.get<SessionInfo[]>('tasksync.remoteSessions', []);
        const filtered = sessions.filter(s => s.id !== this._sessionId);
        this._context.globalState.update('tasksync.remoteSessions', filtered);
    }

    /**
     * Get all registered sessions
     */
    private _getAllSessions(): SessionInfo[] {
        return this._context.globalState.get<SessionInfo[]>('tasksync.remoteSessions', []);
    }

    /**
     * Get connection info for display
     */
    public getConnectionInfo(): { urls: string[]; pin: string; port: number } {
        const ips = this._getLocalIPs();
        const urls = [
            `http://localhost:${this._port}`,
            ...ips.map(ip => `http://${ip}:${this._port}`)
        ];

        return {
            urls,
            pin: this._pin,
            port: this._port
        };
    }

    /**
     * Generate PWA manifest
     */
    private _getManifest(): object {
        return {
            name: 'TaskSync Remote',
            short_name: 'TaskSync',
            description: 'Control your VS Code TaskSync from anywhere',
            start_url: '/app',
            display: 'standalone',
            background_color: '#1e1e1e',
            theme_color: '#007acc',
            icons: [
                {
                    src: '/media/Tasksync-logo.png',
                    sizes: '192x192',
                    type: 'image/png'
                },
                {
                    src: '/media/Tasksync-logo.png',
                    sizes: '512x512',
                    type: 'image/png'
                }
            ]
        };
    }

    /**
     * Generate service worker for offline support
     */
    private _getServiceWorker(): string {
        return `
const CACHE_NAME = 'tasksync-remote-v1';
const urlsToCache = [
    '/app',
    '/media/main.css',
    '/media/webview.js',
    '/media/shim.js',
    '/codicons/codicon.css',
    '/codicons/codicon.ttf'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
`;
    }

    /**
     * Generate landing page HTML (PIN entry + session list)
     */
    private _getLandingHtml(): string {
        const sessions = this._getAllSessions();
        const currentSession = sessions.find(s => s.id === this._sessionId);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#1e1e1e">
    <link rel="manifest" href="/manifest.json">
    <title>TaskSync Remote</title>
    <!-- Inter Font -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link href="/codicons/codicon.css" rel="stylesheet">
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #1e1e1e;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: #cccccc;
        }
        
        .container {
            max-width: 400px;
            width: 100%;
        }
        
        .logo {
            text-align: center;
            margin-bottom: 40px;
        }
        
        .logo img {
            width: 64px;
            height: 64px;
            margin-bottom: 16px;
        }
        
        .logo h1 {
            font-size: 24px;
            font-weight: 600;
            color: #cccccc;
        }
        
        .logo p {
            color: #9d9d9d;
            margin-top: 8px;
            font-size: 14px;
        }
        
        .card {
            background: #252526;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 16px;
            border: 1px solid #414141;
        }
        
        .card h2 {
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            color: #cccccc;
        }
        
        .pin-input-container {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
            justify-content: center;
        }
        
        .pin-digit {
            width: 52px;
            height: 52px;
            background: #3c3c3c;
            border: 1px solid #414141;
            border-radius: 6px;
            font-size: 20px;
            font-weight: 600;
            text-align: center;
            color: #cccccc;
            transition: all 0.2s;
        }
        
        .pin-digit:focus {
            outline: none;
            border-color: #007fd4;
            background: #094771;
        }
        
        .btn {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .btn-primary {
            background: #0e639c;
            color: white;
        }
        
        .btn-primary:hover {
            background: #1177bb;
        }
        
        .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .error {
            color: #f48771;
            font-size: 13px;
            margin-top: 12px;
            text-align: center;
        }
        
        .session-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .session-item {
            display: flex;
            align-items: center;
            padding: 12px;
            background: #2d2d2d;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            border: 1px solid transparent;
        }
        
        .session-item:hover {
            background: #2a2d2e;
            border-color: #414141;
        }
        
        .session-item.current {
            border-color: #007fd4;
            background: #094771;
        }
        
        .session-icon {
            width: 36px;
            height: 36px;
            background: #3a3d41;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-right: 12px;
            color: #c5c5c5;
        }
        
        .session-info {
            flex: 1;
        }
        
        .session-name {
            font-weight: 500;
            margin-bottom: 2px;
            font-size: 14px;
        }
        
        .session-port {
            font-size: 12px;
            color: #9d9d9d;
        }
        
        .session-badge {
            font-size: 11px;
            padding: 3px 8px;
            background: #0e639c;
            color: white;
            border-radius: 4px;
            font-weight: 500;
        }
        
        .help-text {
            text-align: center;
            color: #9d9d9d;
            font-size: 12px;
            margin-top: 24px;
        }
        
        .help-text code {
            background: rgba(255, 255, 255, 0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <img src="/media/Tasksync-logo.png" alt="TaskSync">
            <h1>TaskSync Remote</h1>
            <p>Control VS Code from anywhere</p>
        </div>
        
        <div class="card">
            <h2><span class="codicon codicon-key"></span> Enter PIN</h2>
            <form id="pin-form">
                <div class="pin-input-container">
                    <input type="tel" class="pin-digit" maxlength="1" inputmode="numeric" pattern="[0-9]" autofocus>
                    <input type="tel" class="pin-digit" maxlength="1" inputmode="numeric" pattern="[0-9]">
                    <input type="tel" class="pin-digit" maxlength="1" inputmode="numeric" pattern="[0-9]">
                    <input type="tel" class="pin-digit" maxlength="1" inputmode="numeric" pattern="[0-9]">
                </div>
                <button type="submit" class="btn btn-primary" id="connect-btn" disabled>
                    <span class="codicon codicon-plug"></span> Connect
                </button>
            </form>
            <div class="error" id="error" style="display: none;"></div>
        </div>
        
        ${sessions.length > 0 ? `
        <div class="card">
            <h2><span class="codicon codicon-server"></span> Active Sessions</h2>
            <div class="session-list">
                ${sessions.map(s => `
                    <div class="session-item ${s.id === this._sessionId ? 'current' : ''}" 
                         data-port="${s.port}" 
                         onclick="selectSession(${s.port})">
                        <div class="session-icon">
                            <span class="codicon codicon-folder"></span>
                        </div>
                        <div class="session-info">
                            <div class="session-name">${this._escapeHtml(s.workspaceName)}</div>
                            <div class="session-port">Port ${s.port}</div>
                        </div>
                        ${s.id === this._sessionId ? '<span class="session-badge">Current</span>' : ''}
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
        
        <p class="help-text">
            Find the PIN in VS Code's Output panel → <code>TaskSync Remote</code>
        </p>
    </div>
    
    <script>
        const inputs = document.querySelectorAll('.pin-digit');
        const form = document.getElementById('pin-form');
        const connectBtn = document.getElementById('connect-btn');
        const errorDiv = document.getElementById('error');
        
        // Check URL for error
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('error') === 'invalid_pin') {
            errorDiv.textContent = 'Invalid PIN. Please try again.';
            errorDiv.style.display = 'block';
        }
        
        // PIN input handling
        inputs.forEach((input, index) => {
            input.addEventListener('input', (e) => {
                const value = e.target.value;
                if (value.length === 1) {
                    if (index < inputs.length - 1) {
                        inputs[index + 1].focus();
                    }
                }
                checkPin();
            });
            
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value && index > 0) {
                    inputs[index - 1].focus();
                }
            });
            
            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const paste = (e.clipboardData || window.clipboardData).getData('text');
                const digits = paste.replace(/\\D/g, '').slice(0, 4);
                digits.split('').forEach((digit, i) => {
                    if (inputs[i]) inputs[i].value = digit;
                });
                if (digits.length === 4) inputs[3].focus();
                checkPin();
            });
        });
        
        function checkPin() {
            const pin = Array.from(inputs).map(i => i.value).join('');
            connectBtn.disabled = pin.length !== 4;
        }
        
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const pin = Array.from(inputs).map(i => i.value).join('');
            window.location.href = '/app?pin=' + pin;
        });
        
        function selectSession(port) {
            if (port !== ${this._port}) {
                const currentUrl = new URL(window.location.href);
                currentUrl.port = port;
                window.location.href = currentUrl.origin + '/';
            }
        }
    </script>
</body>
</html>`;
    }

    /**
     * Escape HTML for safe rendering
     */
    private _escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Generate the main app HTML (identical to VS Code webview)
     */
    private _getAppHtml(): string {
        // Read the webview.js content
        const webviewJsPath = path.join(this._extensionUri.fsPath, 'media', 'webview.js');
        const mainCssPath = path.join(this._extensionUri.fsPath, 'media', 'main.css');
        
        let webviewJs = '';
        let mainCss = '';
        
        try {
            webviewJs = fs.readFileSync(webviewJsPath, 'utf8');
            mainCss = fs.readFileSync(mainCssPath, 'utf8');
        } catch (err) {
            console.error('[TaskSync Remote] Failed to read media files:', err);
        }

        // CSS variable fallbacks for browser (VS Code provides these in webview)
        const cssVariableFallbacks = `
        :root {
            /* Font */
            --vscode-font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            --vscode-font-size: 14px;
            --vscode-font-weight: 400;
            
            /* Colors - Dark theme */
            --vscode-foreground: #cccccc;
            --vscode-descriptionForeground: #9d9d9d;
            --vscode-errorForeground: #f48771;
            --vscode-focusBorder: #007fd4;
            
            /* Backgrounds */
            --vscode-sideBar-background: #1e1e1e;
            --vscode-editor-background: #1e1e1e;
            --vscode-input-background: #3c3c3c;
            --vscode-input-foreground: #cccccc;
            --vscode-input-border: #3c3c3c;
            --vscode-input-placeholderForeground: #8c8c8c;
            --vscode-dropdown-background: #3c3c3c;
            --vscode-dropdown-border: #3c3c3c;
            --vscode-dropdown-foreground: #cccccc;
            
            /* Buttons */
            --vscode-button-background: #0e639c;
            --vscode-button-foreground: #ffffff;
            --vscode-button-hoverBackground: #1177bb;
            --vscode-button-secondaryBackground: #3a3d41;
            --vscode-button-secondaryForeground: #ffffff;
            --vscode-button-secondaryHoverBackground: #45494e;
            
            /* Lists */
            --vscode-list-activeSelectionBackground: #094771;
            --vscode-list-activeSelectionForeground: #ffffff;
            --vscode-list-hoverBackground: #2a2d2e;
            --vscode-list-focusOutline: #007fd4;
            
            /* Scrollbar */
            --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
            --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
            --vscode-scrollbarSlider-activeBackground: rgba(191, 191, 191, 0.4);
            
            /* Badges */
            --vscode-badge-background: #4d4d4d;
            --vscode-badge-foreground: #ffffff;
            
            /* Text Links */
            --vscode-textLink-foreground: #3794ff;
            --vscode-textLink-activeForeground: #3794ff;
            
            /* Icons */
            --vscode-icon-foreground: #c5c5c5;
            
            /* Borders */
            --vscode-panel-border: #414141;
            --vscode-widget-border: #414141;
            --vscode-contrastBorder: transparent;
            
            /* Editor widgets */
            --vscode-editorWidget-background: #252526;
            --vscode-editorWidget-foreground: #cccccc;
            --vscode-editorWidget-border: #454545;
            
            /* Checkbox */
            --vscode-checkbox-background: #3c3c3c;
            --vscode-checkbox-border: #3c3c3c;
            --vscode-checkbox-foreground: #cccccc;
            
            /* Settings */
            --vscode-settings-checkboxBackground: #3c3c3c;
            --vscode-settings-checkboxBorder: #3c3c3c;
            --vscode-settings-checkboxForeground: #cccccc;
            
            /* Keybinding */
            --vscode-keybindingLabel-background: rgba(128, 128, 128, 0.17);
            --vscode-keybindingLabel-foreground: #cccccc;
            --vscode-keybindingLabel-border: rgba(51, 51, 51, 0.6);
            --vscode-keybindingLabel-bottomBorder: rgba(68, 68, 68, 0.6);
            
            /* Welcome page */
            --vscode-welcomePage-tileBackground: #2d2d2d;
            --vscode-welcomePage-tileBorder: #414141;
            --vscode-welcomePage-progress-foreground: #0e639c;
            
            /* Text colors */
            --vscode-textPreformat-foreground: #d7ba7d;
            --vscode-textBlockQuote-background: #2a2d2e;
            --vscode-textBlockQuote-border: #007acc;
            --vscode-textCodeBlock-background: #2d2d2d;
        }
        `;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#1e1e1e">
    <link rel="manifest" href="/manifest.json">
    <title>TaskSync Remote</title>
    <!-- Inter Font -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link href="/codicons/codicon.css" rel="stylesheet">
    <style>
        /* VS Code CSS variable fallbacks for browser */
        ${cssVariableFallbacks}
        
        body {
            height: 100vh;
            height: 100dvh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            margin: 0;
            padding: 0;
            background-color: var(--vscode-editor-background);
        }

        .main-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            height: 100%;
            position: relative;
        }

        .chat-container {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding-bottom: 20px;
        }

        .input-area-container {
            flex-shrink: 0;
            background-color: var(--vscode-editor-background);
            border-top: 1px solid var(--vscode-widget-border);
            z-index: 10;
        }

        /* Auto-hide scrollbar but keep functionality */
        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }
        
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 5px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
        }

        /* Main CSS from extension */
        ${mainCss}
        
        /* Mobile-specific enhancements */
        @media (max-width: 768px) {
            body {
                padding-bottom: env(safe-area-inset-bottom) !important;
            }
            
            .input-area-container {
                padding-bottom: calc(8px + env(safe-area-inset-bottom)) !important;
            }
        }
        
        /* Connection status indicator */
        .connection-status {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            padding: 8px 16px;
            text-align: center;
            font-size: 12px;
            font-weight: 500;
            z-index: 9999;
            transition: transform 0.3s ease;
        }
        
        .connection-status.connected {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            color: white;
            transform: translateY(-100%);
        }
        
        .connection-status.connecting {
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: white;
        }
        
        .connection-status.disconnected {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
        }
        
        .connection-status.show {
            transform: translateY(0) !important;
        }
        
        /* PWA install prompt */
        .install-prompt {
            position: fixed;
            bottom: 80px;
            left: 16px;
            right: 16px;
            background: linear-gradient(135deg, #3b82f6, #8b5cf6);
            color: white;
            padding: 16px;
            border-radius: 12px;
            display: none;
            align-items: center;
            gap: 12px;
            z-index: 9998;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        
        .install-prompt.show {
            display: flex;
        }
        
        .install-prompt-text {
            flex: 1;
        }
        
        .install-prompt-title {
            font-weight: 600;
            margin-bottom: 4px;
        }
        
        .install-prompt-desc {
            font-size: 13px;
            opacity: 0.9;
        }
        
        .install-prompt-btn {
            padding: 8px 16px;
            background: white;
            color: #3b82f6;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
        }
        
        .install-prompt-close {
            background: transparent;
            border: none;
            color: white;
            opacity: 0.7;
            cursor: pointer;
            padding: 4px;
        }
        
        /* Remote header bar */
        .remote-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 100;
        }
        
        .remote-header-title {
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }
        
        .remote-header-actions {
            display: flex;
            gap: 4px;
        }
        
        .remote-header-btn {
            background: transparent;
            border: none;
            color: var(--vscode-icon-foreground);
            padding: 4px 6px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .remote-header-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }
    </style>
    <audio id="notification-sound" preload="auto" src="/media/notification.wav"></audio>
</head>
<body>
    <!-- Connection Status -->
    <div class="connection-status connecting show" id="connection-status">
        <span class="codicon codicon-loading codicon-modifier-spin"></span> Connecting...
    </div>
    
    <!-- PWA Install Prompt -->
    <div class="install-prompt" id="install-prompt">
        <div class="install-prompt-text">
            <div class="install-prompt-title">Install TaskSync</div>
            <div class="install-prompt-desc">Add to home screen for the best experience</div>
        </div>
        <button class="install-prompt-btn" id="install-btn">Install</button>
        <button class="install-prompt-close" id="install-close">&times;</button>
    </div>
    
    <!-- Remote Header (like VS Code view title bar) -->
    <div class="remote-header">
        <div class="remote-header-left">
            <span class="remote-header-title">TaskSync</span>
        </div>
        <div class="remote-header-actions">
            <button class="remote-header-btn" id="remote-logout-btn" title="Logout">
                <span class="codicon codicon-sign-out"></span>
            </button>
        </div>
    </div>

    <div class="main-container">
        <!-- Chat Container -->
        <div class="chat-container" id="chat-container">
            <!-- Welcome Section - Let's build -->
            <div class="welcome-section" id="welcome-section">
                <div class="welcome-icon">
                    <img src="/media/TS-logo.svg" alt="TaskSync Logo" width="48" height="48" class="welcome-logo">
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
                </div>
            </div>

            <!-- Tool Call History Area -->
            <div class="tool-history-area" id="tool-history-area"></div>

            <!-- Pending Tool Call Message -->
            <div class="pending-message hidden" id="pending-message"></div>
        </div>

        <!-- Combined Input Wrapper (Queue + Input) -->
        <div class="input-area-container" id="input-area-container">
            <!-- File Autocomplete Dropdown -->
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
            <!-- Prompt Queue Section -->
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
            <!-- Attachment Chips -->
            <div class="chips-container hidden" id="chips-container"></div>
            <div class="input-row">
                <div class="input-highlighter-wrapper">
                    <div class="input-highlighter" id="input-highlighter" aria-hidden="true"></div>
                    <textarea id="chat-input" placeholder="Reply to tool call. (use # for files, / for prompts)" rows="1" aria-label="Message input"></textarea>
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
                    <button id="send-btn" title="Send message" aria-label="Send message">
                        <span class="codicon codicon-arrow-up"></span>
                    </button>
                </div>
            </div>
        </div>
        </div>
        </div>
    </div>

    <!-- Mode Selection Dropdown -->
    <div class="mode-dropdown hidden" id="mode-dropdown">
        <div class="mode-option" data-mode="queue">
            <span class="codicon codicon-layers"></span>
            <div class="mode-option-info">
                <span class="mode-option-title">Queue Mode</span>
                <span class="mode-option-desc">Add to queue for batch processing</span>
            </div>
        </div>
        <div class="mode-option" data-mode="normal">
            <span class="codicon codicon-comment-discussion"></span>
            <div class="mode-option-info">
                <span class="mode-option-title">Normal Mode</span>
                <span class="mode-option-desc">Respond directly to current request</span>
            </div>
        </div>
    </div>

    <!-- Shim for VS Code API - MUST come before webview.js -->
    <script>
        // Configuration
        const PIN = new URLSearchParams(window.location.search).get('pin') || '';
        let socket = null;
        let isConnected = false;
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 10;
        
        // Mock VS Code API state
        let vscodeState = {};
        
        // Message queue for when socket is not ready
        const messageQueue = [];
        
        // VS Code API Mock - MUST be defined before webview.js loads
        window.acquireVsCodeApi = function() {
            return {
                postMessage: function(message) {
                    console.log('[TaskSync Remote] postMessage:', message.type);
                    if (isConnected && socket) {
                        socket.emit('message', message);
                    } else {
                        messageQueue.push(message);
                    }
                },
                getState: function() {
                    return vscodeState;
                },
                setState: function(state) {
                    vscodeState = state;
                    try {
                        localStorage.setItem('tasksync_state', JSON.stringify(state));
                    } catch (e) {}
                }
            };
        };
        
        // Restore state from localStorage
        try {
            const saved = localStorage.getItem('tasksync_state');
            if (saved) vscodeState = JSON.parse(saved);
        } catch (e) {}
        
        // Connection status UI
        const statusEl = document.getElementById('connection-status');
        
        function updateConnectionStatus(status, message) {
            statusEl.className = 'connection-status ' + status;
            statusEl.innerHTML = message;
            
            if (status === 'connected') {
                setTimeout(() => statusEl.classList.remove('show'), 2000);
            } else {
                statusEl.classList.add('show');
            }
        }
        
        // Socket.io connection
        function connectSocket() {
            // Load Socket.io dynamically
            if (typeof io === 'undefined') {
                const script = document.createElement('script');
                script.src = '/socket.io/socket.io.js';
                script.onload = initSocket;
                script.onerror = () => {
                    console.error('[TaskSync] Failed to load socket.io');
                    updateConnectionStatus('disconnected', '<span class="codicon codicon-error"></span> Failed to load');
                };
                document.head.appendChild(script);
            } else {
                initSocket();
            }
        }
        
        function initSocket() {
            socket = io({
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: maxReconnectAttempts,
                reconnectionDelay: 1000
            });
            
            socket.on('connect', () => {
                console.log('[TaskSync] Socket connected');
                updateConnectionStatus('connecting', '<span class="codicon codicon-key"></span> Authenticating...');
                socket.emit('authenticate', { pin: PIN });
            });
            
            socket.on('authenticated', (data) => {
                if (data.success) {
                    isConnected = true;
                    reconnectAttempts = 0;
                    updateConnectionStatus('connected', '<span class="codicon codicon-check"></span> Connected');
                    
                    // Flush message queue
                    while (messageQueue.length > 0) {
                        socket.emit('message', messageQueue.shift());
                    }
                } else {
                    updateConnectionStatus('disconnected', '<span class="codicon codicon-error"></span> Invalid PIN');
                    setTimeout(() => {
                        window.location.href = '/?error=invalid_pin';
                    }, 2000);
                }
            });
            
            socket.on('initialState', (state) => {
                console.log('[TaskSync] Received initial state');
                
                // Apply initial state to UI
                if (window.dispatchVSCodeMessage) {
                    if (state.queue !== undefined) {
                        window.dispatchVSCodeMessage({ type: 'updateQueue', queue: state.queue, enabled: state.queueEnabled });
                    }
                    if (state.currentSession) {
                        window.dispatchVSCodeMessage({ type: 'updateCurrentSession', history: state.currentSession });
                    }
                    if (state.persistedHistory) {
                        window.dispatchVSCodeMessage({ type: 'updatePersistedHistory', history: state.persistedHistory });
                    }
                    if (state.settings) {
                        window.dispatchVSCodeMessage({ type: 'updateSettings', ...state.settings });
                    }
                    if (state.pendingRequest) {
                        window.dispatchVSCodeMessage({ 
                            type: 'toolCallPending', 
                            id: state.pendingRequest.id,
                            prompt: state.pendingRequest.prompt,
                            isApprovalQuestion: state.pendingRequest.isApprovalQuestion,
                            choices: state.pendingRequest.choices
                        });
                    }
                }
            });
            
            socket.on('message', (message) => {
                console.log('[TaskSync] Received message:', message.type);
                if (window.dispatchVSCodeMessage) {
                    window.dispatchVSCodeMessage(message);
                }
            });
            
            socket.on('disconnect', () => {
                isConnected = false;
                updateConnectionStatus('disconnected', '<span class="codicon codicon-debug-disconnect"></span> Disconnected. Reconnecting...');
            });
            
            socket.on('connect_error', () => {
                reconnectAttempts++;
                if (reconnectAttempts >= maxReconnectAttempts) {
                    updateConnectionStatus('disconnected', '<span class="codicon codicon-error"></span> Connection failed. <a href="/" style="color:white;text-decoration:underline;">Retry</a>');
                }
            });
        }
        
        // PWA Install handling
        let deferredPrompt = null;
        
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            document.getElementById('install-prompt').classList.add('show');
        });
        
        document.getElementById('install-btn')?.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log('[TaskSync] Install outcome:', outcome);
                deferredPrompt = null;
                document.getElementById('install-prompt').classList.remove('show');
            }
        });
        
        document.getElementById('install-close')?.addEventListener('click', () => {
            document.getElementById('install-prompt').classList.remove('show');
        });
        
        // Remote header button handlers
        document.getElementById('remote-logout-btn')?.addEventListener('click', () => {
            // Disconnect socket and redirect to home without PIN
            if (socket) socket.disconnect();
            window.location.href = '/';
        });
        
        // Register service worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(err => {
                console.log('[TaskSync] SW registration failed:', err);
            });
        }
        
        // Start connection
        connectSocket();
    </script>
    
    <!-- Main webview.js - loaded AFTER shim -->
    <script>
        ${webviewJs}
    </script>
</body>
</html>`;
    }

    /**
     * Stop the server
     */
    public stop(): void {
        this._unregisterSession();

        if (this._io) {
            this._io.close();
            this._io = null;
        }

        if (this._server) {
            this._server.close();
            this._server = null;
        }

        this._authenticatedSockets.clear();
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        this.stop();
        this._disposables.forEach(d => d.dispose());
    }
}

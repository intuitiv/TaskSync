import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskSyncWebviewProvider } from './webview/webviewProvider';
import { registerTools } from './tools';
import { McpServerManager } from './mcp/mcpServer';
import { ContextManager } from './context';
import { RemoteUiServer, RemoteMessage } from './server/remoteUiServer';

let mcpServer: McpServerManager | undefined;
let webviewProvider: TaskSyncWebviewProvider | undefined;
let contextManager: ContextManager | undefined;
let remoteServer: RemoteUiServer | undefined;
let remoteOutputChannel: vscode.OutputChannel | undefined;

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
            // Check if tasksync-plus is registered
            if (config.mcpServers?.['tasksync-plus']) {
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

export function activate(context: vscode.ExtensionContext) {
    // Initialize context manager for #terminal, #problems features
    contextManager = new ContextManager();
    context.subscriptions.push({ dispose: () => contextManager?.dispose() });

    const provider = new TaskSyncWebviewProvider(context.extensionUri, context, contextManager);
    webviewProvider = provider;

    // Register the provider and add it to disposables for proper cleanup
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TaskSyncWebviewProvider.viewType, provider),
        provider // Provider implements Disposable for cleanup
    );

    // Register VS Code LM Tools (always available for Copilot)
    registerTools(context, provider);

    // Initialize MCP server manager (but don't start yet)
    mcpServer = new McpServerManager(provider);

    // Check if MCP should auto-start based on settings and external client configs
    // Deferred to avoid blocking activation with file I/O
    const config = vscode.workspace.getConfiguration('tasksync');
    const mcpEnabled = config.get<boolean>('mcpEnabled', false);
    const autoStartIfClients = config.get<boolean>('mcpAutoStartIfClients', true);

    // Start MCP server only if:
    // 1. Explicitly enabled in settings, OR
    // 2. Auto-start is enabled AND external clients are configured
    // Note: Check is deferred to avoid blocking extension activation with file I/O
    if (mcpEnabled) {
        // Explicitly enabled - start immediately without checking external clients
        mcpServer.start();
    } else if (autoStartIfClients) {
        // Defer the external client check to avoid blocking activation
        hasExternalMcpClientsAsync().then(hasClients => {
            if (hasClients && mcpServer) {
                mcpServer.start();
            }
        }).catch(err => {
            console.error('[TaskSync] Failed to check external MCP clients:', err);
        });
    }

    // Start MCP server command
    const startMcpCmd = vscode.commands.registerCommand('tasksync.startMcp', async () => {
        if (mcpServer && !mcpServer.isRunning()) {
            await mcpServer.start();
            vscode.window.showInformationMessage('TaskSync MCP Server started');
        } else if (mcpServer?.isRunning()) {
            vscode.window.showInformationMessage('TaskSync MCP Server is already running');
        }
    });

    // Restart MCP server command
    const restartMcpCmd = vscode.commands.registerCommand('tasksync.restartMcp', async () => {
        if (mcpServer) {
            await mcpServer.restart();
        }
    });

    // Show MCP configuration command
    const showMcpConfigCmd = vscode.commands.registerCommand('tasksync.showMcpConfig', async () => {
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
            const uri = vscode.Uri.file(cfg.path);
            await vscode.commands.executeCommand('vscode.open', uri);
        }
    });

    // Open history modal command (triggered from view title bar)
    const openHistoryCmd = vscode.commands.registerCommand('tasksync.openHistory', () => {
        provider.openHistoryModal();
    });

    // Clear current session command (triggered from view title bar)
    const clearSessionCmd = vscode.commands.registerCommand('tasksync.clearCurrentSession', async () => {
        const result = await vscode.window.showWarningMessage(
            'Clear all tool calls from current session?',
            { modal: true },
            'Clear'
        );
        if (result === 'Clear') {
            provider.clearCurrentSession();
        }
    });

    // Open settings modal command (triggered from view title bar)
    const openSettingsCmd = vscode.commands.registerCommand('tasksync.openSettings', () => {
        provider.openSettingsModal();
    });

    context.subscriptions.push(startMcpCmd, restartMcpCmd, showMcpConfigCmd, openHistoryCmd, clearSessionCmd, openSettingsCmd);

    // ================== Remote UI Server ==================
    
    // Initialize Remote UI Server for web/mobile access
    remoteServer = new RemoteUiServer(context.extensionUri, context);
    context.subscriptions.push(remoteServer);
    
    // Create output channel for remote server info
    remoteOutputChannel = vscode.window.createOutputChannel('TaskSync Remote');
    context.subscriptions.push(remoteOutputChannel);

    // Wire up remote server with webview provider
    remoteServer.onGetState(() => provider.getStateForRemote());
    remoteServer.onMessage((message: RemoteMessage, respond) => {
        // Forward message to webview provider
        provider.handleRemoteMessage(message as any);
    });
    
    // Set broadcast callback so webview provider can push updates to remote clients
    provider.setRemoteBroadcastCallback((message) => {
        remoteServer?.broadcast(message as RemoteMessage);
    });

    // Check if remote server should auto-start
    const remoteEnabled = config.get<boolean>('remoteEnabled', false);
    const remotePort = config.get<number>('remotePort', 3000);
    
    if (remoteEnabled) {
        startRemoteServer(remotePort);
    }

    // Initialize context for remote server state (icon toggle)
    vscode.commands.executeCommand('setContext', 'tasksync.remoteServerRunning', false);

    // Start Remote Server command
    const startRemoteCmd = vscode.commands.registerCommand('tasksync.startRemote', async () => {
        await startRemoteServer(remotePort);
    });

    // Stop Remote Server command  
    const stopRemoteCmd = vscode.commands.registerCommand('tasksync.stopRemote', () => {
        if (remoteServer) {
            remoteServer.stop();
            vscode.commands.executeCommand('setContext', 'tasksync.remoteServerRunning', false);
            vscode.window.showInformationMessage('TaskSync Remote Server stopped');
        }
    });

    // Show Remote URL command
    const showRemoteUrlCmd = vscode.commands.registerCommand('tasksync.showRemoteUrl', () => {
        if (remoteServer) {
            const info = remoteServer.getConnectionInfo();
            if (info.port > 0) {
                showRemoteConnectionInfo(info);
            } else {
                vscode.window.showWarningMessage('TaskSync Remote Server is not running. Run "TaskSync: Start Remote Server" first.');
            }
        }
    });

    // Toggle Remote Server command (for the title bar button - START)
    const toggleRemoteStartCmd = vscode.commands.registerCommand('tasksync.toggleRemoteStart', async () => {
        await startRemoteServer(remotePort);
    });

    // Toggle Remote Server command (for the title bar button - STOP/OPTIONS)
    const toggleRemoteStopCmd = vscode.commands.registerCommand('tasksync.toggleRemoteStop', async () => {
        if (remoteServer) {
            const info = remoteServer.getConnectionInfo();
            if (info.port > 0) {
                // Server is running - show options
                const action = await vscode.window.showQuickPick([
                    { label: '$(copy) Copy URL with PIN', description: 'Copy ready-to-use URL for mobile', action: 'copy' },
                    { label: '$(key) Show PIN', description: info.pin, action: 'pin' },
                    { label: '$(link-external) Show All URLs', description: 'View all connection options', action: 'urls' },
                    { label: '$(debug-disconnect) Stop Server', description: 'Stop the remote server', action: 'stop' }
                ], {
                    placeHolder: `Remote Server running on port ${info.port}`
                });
                
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
                    vscode.commands.executeCommand('setContext', 'tasksync.remoteServerRunning', false);
                    vscode.window.showInformationMessage('TaskSync Remote Server stopped');
                }
            }
        }
    });

    // Keep old toggle command for backward compatibility
    const toggleRemoteCmd = vscode.commands.registerCommand('tasksync.toggleRemote', async () => {
        if (remoteServer) {
            const info = remoteServer.getConnectionInfo();
            if (info.port > 0) {
                await vscode.commands.executeCommand('tasksync.toggleRemoteStop');
            } else {
                await vscode.commands.executeCommand('tasksync.toggleRemoteStart');
            }
        }
    });

    context.subscriptions.push(startRemoteCmd, stopRemoteCmd, showRemoteUrlCmd, toggleRemoteStartCmd, toggleRemoteStopCmd, toggleRemoteCmd);
}

/**
 * Start the remote UI server
 */
async function startRemoteServer(preferredPort: number): Promise<void> {
    if (!remoteServer) return;
    
    try {
        const port = await remoteServer.start(preferredPort);
        const info = remoteServer.getConnectionInfo();
        
        // Update context for icon toggle
        vscode.commands.executeCommand('setContext', 'tasksync.remoteServerRunning', true);
        
        // Show in output channel
        remoteOutputChannel?.clear();
        remoteOutputChannel?.appendLine('='.repeat(50));
        remoteOutputChannel?.appendLine('  TaskSync Remote Server Started');
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
            `TaskSync Remote running on port ${port}. PIN: ${info.pin}`,
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
        placeHolder: 'TaskSync Remote Connection Info'
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
}

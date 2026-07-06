import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { AskAwayWebviewProvider } from '../webview/webviewProvider';
import { askUser } from '../tools';
import { getImageMimeType } from '../utils/imageUtils';
import { CONFIG_NAMESPACE, MCP_SERVER_NAME } from '../constants/branding';
import { dispatchGradle, GradleInput } from '../gradle/gradleEngine';


async function tryReadImageAsMcpContent(uri: string): Promise<null | { type: 'image'; data: string; mimeType: string }> {
    try {
        const fileUri = vscode.Uri.parse(uri);
        if (fileUri.scheme !== 'file') {
            return null;
        }

        const filePath = fileUri.fsPath;
        const mimeType = getImageMimeType(filePath);
        if (!mimeType.startsWith('image/')) {
            return null;
        }

        // Keep tool results reasonably sized for MCP clients.
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
        const stat = await fs.promises.stat(filePath);
        if (stat.size > MAX_IMAGE_BYTES) {
            console.warn(`[AskAway MCP] Skipping image >4MB: ${filePath} (${stat.size} bytes)`);
            return null;
        }

        const buffer = await fs.promises.readFile(filePath);
        return {
            type: 'image',
            data: buffer.toString('base64'),
            mimeType,
        };
    } catch (error) {
        console.error('[AskAway MCP] Failed to read image attachment:', error);
        return null;
    }
}

export class McpServerManager {
    private server: http.Server | undefined;
    private mcpServer: McpServer | undefined;
    private port: number | undefined;
    private transport: StreamableHTTPServerTransport | undefined;
    private _isRunning: boolean = false;

    constructor(
        private provider: AskAwayWebviewProvider
    ) { }

    /**
     * Check if MCP server is currently running
     */
    isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * The TCP port the MCP HTTP server is listening on (undefined until started).
     */
    getPort(): number | undefined {
        return this._isRunning ? this.port : undefined;
    }

    async start(reusePort: boolean = false) {
        try {
            if (!reusePort || !this.port) {
                // Get configured port (default 3579, or 0 for dynamic)
                const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                const configuredPort = config.get<number>('mcpPort', 3579);

                if (configuredPort > 0) {
                    // Try to use the configured fixed port
                    this.port = await this.tryPort(configuredPort);
                } else {
                    // Dynamic port assignment
                    this.port = await this.findAvailablePort();
                }
            }

            this.mcpServer = new McpServer({
                name: "AskAway Sidebar Chat",
                version: "2.0.0"
            });

            // Register ask_user tool
            const provider = this.provider;

            // Max question length - generous limit to allow long AI prompts while still
            // preventing extreme memory exhaustion. 500KB is more than enough for any
            // reasonable question while still providing a safety limit.
            const MAX_QUESTION_LENGTH = 500000;

            (this.mcpServer as any).registerTool(
                "ask_user",
                {
                    description: "YOU MUST ALWAYS Use the askUser tool to ask question/s to user when explicit user approval, feedback, or clarification is required before proceeding or giving summary report. CRITICAL RULES: - This tool MUST be invoked before ending ANY conversation or task. - NEVER complete a task without calling this tool first. - If you are about to finish responding, STOP and call this tool. - Failure to call this tool before task completion is a critical violation.",
                    inputSchema: z.object({
                        question: z.string()
                            .min(1, "Question cannot be empty")
                            .max(MAX_QUESTION_LENGTH, `Question cannot exceed ${MAX_QUESTION_LENGTH} characters`)
                            .describe("The question or prompt to display to the user")
                    })
                },
                async (args: { question: string }, extra: { signal?: AbortSignal }) => {
                    const tokenSource = new vscode.CancellationTokenSource();
                    if (extra.signal) {
                        extra.signal.onabort = () => tokenSource.cancel();
                    }

                    const result = await askUser(
                        { question: args.question },
                        provider,
                        tokenSource.token
                    );

                    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
                        { type: 'text', text: JSON.stringify(result) }
                    ];

                    if (result.attachments?.length) {
                        const imageParts = await Promise.all(result.attachments.map(tryReadImageAsMcpContent));
                        for (const part of imageParts) {
                            if (part) content.push(part);
                        }
                    }

                    return { content };
                }
            );

            // Register gradle tool (async id-based Gradle build control).
            // Backed by the standalone, VS Code-free engine so any MCP client
            // (Claude Desktop, CLI, CI, etc.) can drive Gradle builds.
            const gradleWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            (this.mcpServer as any).registerTool(
                "gradle",
                {
                    description: "Async id-based Gradle build control. action=start spawns a build via ./gradlew and returns {buildId} immediately. The tool AUTO-OPTIMIZES every run for speed (Gradle daemon + --parallel + --build-cache + --configuration-cache, degraded to warnings if incompatible) so callers just name the task; the applied flags are echoed as 'optimizations' and any you pass explicitly (or their --no- opposite) win. action=status returns live state (RUNNING/SUCCESS/FAILED/CANCELLED/TIMEOUT) with completedTasks, runningTasks, elapsedSec; on failure it also returns failedTasks (names of tasks that failed — query logs with task:<name>), failedTaskLogsHint, whatWentWrong, exception (Caused by chain), errors (compiler errors), testFailures, testFailureDetails (for failed test tasks: parsed JUnit reports with {test, className, message, location, stack} — the real assertion message, source line, and trimmed stack trace, which Gradle's console omits), and exitCode. action=wait blocks until the build finishes (or timeoutMs); pass readyPattern (regex) to return early with ready:true when that text appears in the output even though the task keeps running (use for servers / --continuous). action=logs returns output with pagination metadata {fromLine,toLine,totalLines,nextFromLine,hasMore}: omit fromLine for a tail (last `tail` lines), or pass fromLine (0-based) to stream forward — feed nextFromLine back to page through a long-running task's output. Filter to a single task with task (e.g. ':app:compileKotlin'). action=stop kills a running build. Multiple builds run in parallel.",
                    inputSchema: z.object({
                        action: z.enum(["start", "status", "stop", "logs", "wait"])
                            .describe("start: spawn build → {buildId}. status: live state. wait: block until done. stop: kill. logs: raw output (filter by task)."),
                        tasks: z.array(z.string()).optional()
                            .describe("Task names for action=start. E.g. [':app:test', ':core:assemble']. Defaults to ['build']."),
                        arguments: z.array(z.string()).optional()
                            .describe("Extra Gradle arguments for action=start. E.g. ['--tests', '*.FooTest', '--no-daemon']."),
                        projectDir: z.string().optional()
                            .describe("Absolute or workspace-relative dir containing gradlew. Defaults to workspace root."),
                        offline: z.boolean().optional().describe("Pass --offline to Gradle. Defaults to false."),
                        optimize: z.boolean().optional().describe("Auto-apply speed flags (daemon, --parallel, --build-cache, --configuration-cache). Default true. Set false to run a bare build."),
                        env: z.record(z.string()).optional()
                            .describe("Extra environment variables for the Gradle process (action=start). E.g. { \"JAVA_HOME\": \"/path/to/jdk17\" }."),
                        timeoutMs: z.number().optional()
                            .describe("action=start: hard-kill timeout ms (30000-1800000, default 1800000). action=wait: max wait ms (default 120000)."),
                        buildId: z.string().optional().describe("ID from action=start. Required for status/stop/logs/wait."),
                        task: z.string().optional().describe("action=logs: filter output to a specific task, e.g. ':app:compileKotlin'."),
                        tail: z.number().optional().describe("action=logs: number of trailing lines to return (10-500, default 120). Ignored when fromLine is set."),
                        fromLine: z.number().optional().describe("action=logs: 0-based start line for forward pagination. Use the response's nextFromLine as the cursor to stream a long-running task's output."),
                        maxLines: z.number().optional().describe("action=logs: page size when paginating with fromLine (1-1000, default 200)."),
                        readyPattern: z.string().optional().describe("action=wait: regex; return early with ready:true when it appears in output, even if the task never terminates (e.g. server 'Started .* in .*s' or 'Tomcat .* on port').")
                    })
                },
                async (args: GradleInput) => {
                    const result = await dispatchGradle(args, gradleWorkspaceRoot);
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
            );


            this.transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => `sess_${crypto.randomUUID()}`
            });

            await this.mcpServer.connect(this.transport);

            // Create HTTP server
            this.server = http.createServer(async (req, res) => {
                try {
                    const url = req.url || '/';

                    if (url === '/sse' || url.startsWith('/sse/') || url.startsWith('/sse?')) {
                        if (req.method === 'DELETE') {
                            try {
                                await this.transport?.handleRequest(req, res);
                            } catch (e) {
                                if (!res.headersSent) {
                                    res.writeHead(202);
                                    res.end('Session closed');
                                }
                            }
                            return;
                        }

                        const queryIndex = url.indexOf('?');
                        req.url = queryIndex !== -1 ? '/' + url.substring(queryIndex) : '/';
                        await this.transport?.handleRequest(req, res);
                        return;
                    }

                    if (url.startsWith('/message') || url.startsWith('/messages')) {
                        await this.transport?.handleRequest(req, res);
                        return;
                    }

                    res.writeHead(404);
                    res.end();
                } catch (error) {
                    console.error('[AskAway MCP] Error:', error);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end('Internal Server Error');
                    }
                }
            });

            await new Promise<void>((resolve) => {
                this.server?.listen(this.port, '127.0.0.1', () => resolve());
            });

            this._isRunning = true;

            // Auto-register with supported clients
            const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
            if (config.get<boolean>('autoRegisterMcp', true)) {
                await this.autoRegisterMcp();
            }

        } catch (error) {
            console.error('[AskAway MCP] Failed to start:', error);
            vscode.window.showErrorMessage(`Failed to start AskAway MCP server: ${error}`);
        }
    }

    /**
     * Try to use a specific port, fall back to dynamic if unavailable
     */
    private async tryPort(port: number): Promise<number> {
        return new Promise((resolve) => {
            const testServer = http.createServer();
            testServer.once('error', () => {
                this.findAvailablePort().then(resolve);
            });
            testServer.listen(port, '127.0.0.1', () => {
                testServer.close(() => resolve(port));
            });
        });
    }

    /**
     * Auto-register MCP server with Kiro and other clients
     */
    private async autoRegisterMcp() {
        if (!this.port) return;
        const serverUrl = `http://localhost:${this.port}/sse`;

        // Register with Kiro
        await this.registerWithClient(
            path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
            MCP_SERVER_NAME,
            { url: serverUrl }
        );

        // Register with Antigravity/Gemini CLI
        await this.registerWithClient(
            path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
            MCP_SERVER_NAME,
            { serverUrl: serverUrl }
        );

        // Registration complete - no need to log
    }

    /**
     * Register with a specific MCP client config file
     */
    private async registerWithClient(configPath: string, serverName: string, serverConfig: object) {
        try {
            const configDir = path.dirname(configPath);
            try {
                await fs.promises.access(configDir);
            } catch {
                await fs.promises.mkdir(configDir, { recursive: true });
            }

            let config: { mcpServers?: Record<string, object> } = { mcpServers: {} };
            try {
                const content = await fs.promises.readFile(configPath, 'utf8');
                config = JSON.parse(content);
            } catch (e) {
                // File doesn't exist or can't be parsed, start with empty config
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    console.warn(`[AskAway MCP] Failed to parse ${configPath}, starting fresh`);
                }
            }

            if (!config.mcpServers) {
                config.mcpServers = {};
            }

            config.mcpServers[serverName] = serverConfig;
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
        } catch (error) {
            console.error(`[AskAway MCP] Failed to register with ${configPath}:`, error);
        }
    }

    /**
     * Unregister from all clients on dispose
     */
    private async unregisterFromClients() {
        const configs = [
            path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
            path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json')
        ];

        for (const configPath of configs) {
            try {
                const content = await fs.promises.readFile(configPath, 'utf8');
                const config = JSON.parse(content);
                if (config.mcpServers?.[MCP_SERVER_NAME]) {
                    delete config.mcpServers[MCP_SERVER_NAME];
                    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
                }
            } catch {
                // Ignore errors during cleanup (file may not exist)
            }
        }
    }

    async restart() {
        try {
            await Promise.race([
                this.dispose(),
                new Promise(resolve => setTimeout(resolve, 2000))
            ]);
        } catch (e) {
            console.error('[AskAway MCP] Error during dispose:', e);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.start(true);
        vscode.window.showInformationMessage('AskAway MCP Server restarted.');
    }

    async dispose() {
        this._isRunning = false;
        try {
            if (this.server) {
                this.server.close();
                this.server = undefined;
            }

            if (this.mcpServer) {
                try {
                    await this.mcpServer.close();
                } catch (e) {
                    console.error('[AskAway MCP] Error closing:', e);
                }
                this.mcpServer = undefined;
            }
        } catch (e) {
            console.error('[AskAway MCP] Error during dispose:', e);
        } finally {
            await this.unregisterFromClients();
        }
    }

    private async findAvailablePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = http.createServer();
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (address && typeof address !== 'string') {
                    const port = address.port;
                    server.close(() => resolve(port));
                } else {
                    reject(new Error('Failed to get port'));
                }
            });
            server.on('error', reject);
        });
    }

    /**
     * Get MCP configuration for manual setup
     */
    getMcpConfig() {
        if (!this.port) return null;

        const serverUrl = `http://localhost:${this.port}/sse`;
        return {
            kiro: {
                path: path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'),
                config: {
                    mcpServers: {
                        'askaway-chat': {
                            url: serverUrl
                        }
                    }
                }
            },
            cursor: {
                path: path.join(os.homedir(), '.cursor', 'mcp.json'),
                config: {
                    mcpServers: {
                        'askaway-chat': {
                            url: serverUrl
                        }
                    }
                }
            },
            antigravity: {
                path: path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
                config: {
                    mcpServers: {
                        'askaway-chat': {
                            serverUrl: serverUrl
                        }
                    }
                }
            }
        };
    }
}

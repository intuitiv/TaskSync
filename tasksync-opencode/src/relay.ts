#!/usr/bin/env node
/**
 * AskAway stdio relay — spawned by OpenCode as an MCP server.
 * Connects to the central AskAway server via WebSocket,
 * provides `ask_user` and `get_feedback` tools over MCP stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';

const SERVER_URL = process.env.ASKAWAY_SERVER || 'ws://127.0.0.1:4350';
const SESSION_NAME = process.env.ASKAWAY_SESSION_NAME || process.cwd().split('/').pop() || 'OpenCode';

let ws: WebSocket | null = null;
let sessionId: string | null = null;
let pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();
let requestCounter = 0;

function connectToServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        const url = `${SERVER_URL}/relay?name=${encodeURIComponent(SESSION_NAME)}`;
        ws = new WebSocket(url);

        ws.on('open', () => {
            console.error(`[AskAway Relay] Connected to server at ${SERVER_URL}`);
        });

        ws.on('message', (data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === 'session-created') {
                    sessionId = msg.sessionId;
                    console.error(`[AskAway Relay] Session: ${msg.name} (${sessionId})`);
                    resolve();
                    return;
                }

                if (msg.type === 'response') {
                    const pending = pendingRequests.get(msg.requestId);
                    if (pending) {
                        pendingRequests.delete(msg.requestId);
                        pending.resolve({
                            response: msg.response,
                            attachments: msg.attachments || [],
                        });
                    }
                }
            } catch (e) {
                console.error('[AskAway Relay] Invalid message:', e);
            }
        });

        ws.on('close', () => {
            console.error('[AskAway Relay] Disconnected from server');
            // Reject all pending requests
            for (const [, pending] of pendingRequests) {
                pending.reject(new Error('Server disconnected'));
            }
            pendingRequests.clear();
            ws = null;
            sessionId = null;

            // Attempt reconnect after 3s
            setTimeout(() => {
                console.error('[AskAway Relay] Attempting reconnect...');
                connectToServer().catch(() => { });
            }, 3000);
        });

        ws.on('error', (err) => {
            console.error('[AskAway Relay] WebSocket error:', err.message);
            reject(err);
        });
    });
}

function askServer(question: string): Promise<{ response: string; attachments: string[] }> {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('Not connected to AskAway server. Start it with: npx askaway-mcp'));
            return;
        }

        const requestId = `req_${++requestCounter}_${Date.now()}`;
        pendingRequests.set(requestId, { resolve, reject });

        ws.send(JSON.stringify({
            type: 'ask_user',
            requestId,
            question,
        }));
    });
}

async function main(): Promise<void> {
    // Connect to central server
    try {
        await connectToServer();
    } catch {
        console.error('[AskAway Relay] Could not connect to server. Starting in offline mode — questions will wait.');
    }

    // Create MCP server
    const mcpServer = new McpServer({
        name: 'AskAway',
        version: '0.1.0',
    });

    // Register ask_user tool
    mcpServer.tool(
        'ask_user',
        'Ask the user a question and wait for their response. The question will appear on the AskAway web dashboard and optionally Telegram. CRITICAL: You MUST call this tool before ending any conversation or task. This tool may take several minutes to return as it waits for human input.',
        {
            question: z.string().min(1).max(500000).describe('The question to ask the user'),
        },
        async (args, extra) => {
            try {
                // Send progress notifications to keep MCP connection alive
                const progressToken = extra?._meta?.progressToken;
                let progressInterval: NodeJS.Timeout | undefined;
                if (progressToken && mcpServer.server) {
                    let tick = 0;
                    progressInterval = setInterval(async () => {
                        tick++;
                        try {
                            await mcpServer.server!.notification({
                                method: 'notifications/progress',
                                params: {
                                    progressToken,
                                    progress: tick,
                                    total: 0,  // indeterminate
                                    message: 'Waiting for user response...',
                                },
                            });
                        } catch { /* ignore */ }
                    }, 10000); // every 10s
                }

                const result = await askServer(args.question);

                if (progressInterval) clearInterval(progressInterval);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                response: result.response,
                                attachments: result.attachments,
                                queued: false,
                            }),
                        },
                    ],
                };
            } catch (err: any) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                response: '',
                                error: err.message || 'Failed to reach AskAway server',
                                queued: false,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Register get_feedback (alias for polling pattern)
    mcpServer.tool(
        'get_feedback',
        'Poll for user feedback. Same as ask_user but signals you are waiting for input rather than asking a new question. This tool may take several minutes to return as it waits for human input.',
        {
            question: z.string().min(1).max(500000).describe('The status update or question to show while waiting'),
        },
        async (args, extra) => {
            try {
                // Send progress notifications to keep MCP connection alive
                const progressToken = extra?._meta?.progressToken;
                let progressInterval: NodeJS.Timeout | undefined;
                if (progressToken && mcpServer.server) {
                    let tick = 0;
                    progressInterval = setInterval(async () => {
                        tick++;
                        try {
                            await mcpServer.server!.notification({
                                method: 'notifications/progress',
                                params: {
                                    progressToken,
                                    progress: tick,
                                    total: 0,
                                    message: 'Waiting for user response...',
                                },
                            });
                        } catch { /* ignore */ }
                    }, 10000);
                }

                const result = await askServer(args.question);

                if (progressInterval) clearInterval(progressInterval);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                response: result.response,
                                attachments: result.attachments,
                                queued: false,
                            }),
                        },
                    ],
                };
            } catch (err: any) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                response: '',
                                error: err.message || 'Failed to reach AskAway server',
                                queued: false,
                            }),
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    // Start stdio transport
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error('[AskAway Relay] MCP server ready (stdio transport)');
}

main().catch((err) => {
    console.error('[AskAway Relay] Fatal error:', err);
    process.exit(1);
});

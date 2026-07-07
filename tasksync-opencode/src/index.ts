#!/usr/bin/env node
/**
 * AskAway — Central Server
 *
 * Usage:
 *   npx askaway-mcp              # Start on default port 4350
 *   npx askaway-mcp --port 8080  # Start on custom port
 *
 * Then configure OpenCode MCP:
 *   { "mcpServers": { "askaway": { "command": "npx", "args": ["askaway-relay"] } } }
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CentralServer } from './server.js';

// Load .env file if present (no external dependency)
try {
    const envPath = resolve(process.cwd(), '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
} catch {
    // No .env file — that's fine
}

const args = process.argv.slice(2);
let port = 4350;

for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            console.error('Invalid port number');
            process.exit(1);
        }
        i++;
    }
    if (args[i] === '--help' || args[i] === '-h') {
        console.log(`AskAway — MCP Server with Telegram & Web Dashboard

Usage:
  askaway-mcp [options]

Options:
  -p, --port <port>   Port to listen on (default: 4350)
  -h, --help          Show this help

After starting, configure your OpenCode MCP:
  {
    "mcpServers": {
      "askaway": {
        "command": "npx",
        "args": ["askaway-relay"]
      }
    }
  }

Then open http://127.0.0.1:<port> for the web dashboard.
`);
        process.exit(0);
    }
}

const server = new CentralServer();

server.start(port).then((actualPort) => {
    console.log(`\nReady. Open http://127.0.0.1:${actualPort} in your browser.\n`);
}).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Try a different port with --port <port>`);
    } else {
        console.error('Failed to start server:', err);
    }
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[TaskSync] Shutting down...');
    server.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    server.stop();
    process.exit(0);
});

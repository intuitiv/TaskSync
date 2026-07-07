.PHONY: build start relay install clean

# Load secrets from .env (never committed)
-include .env
export ASKAWAY_BOT_TOKEN
export ASKAWAY_CHAT_ID

build:
	npm run build

install:
	npm install

start: build
	@echo "Starting AskAway MCP server on port 4350..."
	@echo "Dashboard: http://127.0.0.1:4350"
	node dist/index.js

relay: build
	node dist/relay.js

clean:
	rm -rf dist

# First time setup
setup: install build
	@echo ""
	@echo "✅ AskAway MCP ready!"
	@echo ""
	@echo "1. Run 'make start' to launch the server"
	@echo "2. Configure OpenCode MCP to use the relay:"
	@echo '   { "mcpServers": { "askaway": { "command": "make", "args": ["relay"] } } }'
	@echo "3. Open http://127.0.0.1:4350 for the dashboard"

# I Built Remote Mobile Access for My Favorite VS Code Extension — Here's How

*Control your AI coding sessions from your phone. Because great ideas don't wait for you to get back to your desk.*

---

## The Problem

I've been using [TaskSync](https://github.com/user/tasksync-chat) for a while now — it's a VS Code extension that lets you manage AI tool calls with a queue system. You can batch your responses, approve requests, and generally stay in control of what your AI coding assistant is doing.

But there was one problem: **I had to be at my desk.**

AI coding assistants can take a while to work through complex tasks. You kick off a refactoring job, go grab a coffee, and come back to find it's been waiting for your approval for 10 minutes. Or worse — you're on the couch, your laptop is in the other room, and you just want to quickly approve that file creation.

## The Solution

I decided to add remote access to TaskSync. The goal was simple:

> **Access the full TaskSync UI from any browser, especially mobile.**

Not a dumbed-down mobile app. Not a notification system. The *actual* TaskSync interface, running on my phone.

![TaskSync on Mobile](./screenshots/mobile-hero.png)
*The full TaskSync experience, in your pocket*

## What I Built

### 1. An Embedded Web Server

The extension now includes an Express.js server that starts on demand. When you click the remote button (📡) in the TaskSync panel, it:

1. Spins up an HTTP server on an available port
2. Generates a 4-digit PIN for security
3. Serves the TaskSync UI to any browser

```typescript
// Simplified server setup
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/app', (req, res) => {
    if (req.query.pin !== this._pin) {
        res.redirect('/?error=invalid_pin');
        return;
    }
    res.send(this._getAppHtml());
});
```

### 2. Real-time Sync with Socket.io

The web UI needs to stay perfectly in sync with VS Code. When a tool call comes in, it should appear on your phone instantly. When you approve something on mobile, VS Code should respond immediately.

Socket.io made this easy:

```typescript
socket.on('message', (message) => {
    // Forward to VS Code webview provider
    webviewProvider.handleRemoteMessage(message);
});

// Broadcast updates to all connected clients
webviewProvider.setRemoteBroadcastCallback((message) => {
    io.emit('message', message);
});
```

### 3. PIN Authentication

Security matters. Even on a local network, you don't want anyone stumbling onto your AI session. The 4-digit PIN system is simple but effective:

- New PIN generated each time you start the server
- Required for initial connection
- Session-based (you stay authenticated)

![PIN Entry Screen](./screenshots/pin-screen.png)
*Clean, mobile-friendly PIN entry*

### 4. Session Registry

Here's a feature I'm particularly proud of: **Active Sessions**.

If you have VS Code open on multiple projects, each one can run its own TaskSync remote server. The landing page shows all active sessions:

![Active Sessions](./screenshots/active-sessions.png)
*Switch between workspaces with one tap*

This is stored in VS Code's global state, so it persists across sessions and even survives VS Code restarts (as long as the servers are running).

### 5. CSS Variable Fallbacks

The trickiest part? Making the VS Code webview CSS work in a regular browser.

VS Code injects CSS variables like `--vscode-foreground` and `--vscode-sideBar-background`. Browsers don't have these. So I had to create a complete fallback theme:

```css
:root {
    --vscode-font-family: 'Inter', -apple-system, sans-serif;
    --vscode-foreground: #cccccc;
    --vscode-sideBar-background: #1e1e1e;
    --vscode-button-background: #0e639c;
    /* ... 60+ more variables */
}
```

The result? The mobile UI looks almost identical to VS Code's dark theme.

## The User Experience

### Starting the Server

Click the broadcast icon in the TaskSync panel title bar:

![Toggle Button](./screenshots/toggle-button.png)

You'll get a QuickPick menu with options:
- Copy URL with PIN (for sharing to your phone)
- Show PIN
- View all connection URLs
- Stop server

### Connecting from Mobile

1. Open the URL on your phone
2. Enter the 4-digit PIN
3. You're in!

The UI is fully responsive. Cards, buttons, input areas — everything scales properly for touch.

### Real-World Usage

I've been using this for a week now, and it's changed how I work:

- **Morning coffee**: Approve overnight AI tasks from the kitchen
- **Lunch break**: Queue up prompts for the afternoon while eating
- **On the couch**: Monitor progress without getting up
- **Multiple projects**: Switch between workspaces without touching VS Code

## Technical Decisions

### Why Embed the Server in the Extension?

I considered a few approaches:

1. **Separate app**: Too much friction. Users would need to install something else.
2. **Cloud relay**: Privacy concerns, added complexity, potential latency.
3. **Embedded server**: Zero setup, works offline, instant sync.

The embedded approach won. It's self-contained, requires no external dependencies, and Just Works™.

### Why Not Use VS Code's Remote Development?

VS Code Remote is great for accessing your full IDE remotely. But it requires:
- Port forwarding or tunneling
- Running a full VS Code instance
- Decent bandwidth

TaskSync Remote is lighter:
- Works on any local network
- Minimal bandwidth (just text/JSON)
- Optimized for mobile

### Why Socket.io?

I needed WebSocket support with fallbacks. Socket.io handles:
- Automatic reconnection
- Fallback to polling if WebSocket fails
- Room/namespace support
- Built-in heartbeat

## Challenges & Solutions

### Challenge: esbuild Bundling

Socket.io doesn't bundle well with esbuild. The WebSocket engine (`ws`) gets mangled. Solution: mark it as external.

```javascript
// esbuild.js
external: [
    'vscode',
    'socket.io',
    'engine.io',
    'ws',
]
```

### Challenge: Mobile Layout

The input area was overflowing on mobile. Fixed with proper flexbox:

```css
body {
    height: 100dvh; /* Dynamic viewport height */
    display: flex;
    flex-direction: column;
}

.main-container {
    flex: 1;
    overflow: hidden;
}

.input-area-container {
    flex-shrink: 0; /* Never shrink */
}
```

### Challenge: File Autocomplete

The `#file` autocomplete wasn't working on mobile because results were only sent to the VS Code webview. Fixed by broadcasting to all clients:

```typescript
// Before
this._view?.webview.postMessage({ type: 'fileSearchResults', ... });

// After
this._broadcast({ type: 'fileSearchResults', ... });
```

## What's Next?

I'd love to add:

1. **Push notifications**: Get alerted when AI needs approval
2. **Offline queue**: Queue prompts even without connection
3. **Voice input**: Dictate responses on mobile
4. **Tablet layout**: Better use of larger screens

## Try It Yourself

If you're using TaskSync, you can try this today:

1. Update to the latest version
2. Click the broadcast icon (📡) in the TaskSync panel
3. Open the URL on your phone
4. Enter the PIN

That's it. Full TaskSync access from anywhere on your network.

---

## Contributing

This feature started as a weekend hack, but it's become essential to my workflow. If you have ideas for improvements:

- Open an issue on GitHub
- Submit a PR
- Share your use cases!

The code is in [src/server/remoteUiServer.ts](./src/server/remoteUiServer.ts) if you want to dive in.

---

*Happy coding — from your desk, your couch, or wherever you happen to be.* 🚀

---

**Tags**: #vscode #extension #typescript #mobile #remote-access #ai-coding #socket-io #pwa

**Published**: [Your Name] | [Date]

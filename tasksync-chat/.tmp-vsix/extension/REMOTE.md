# AskAway Remote - Web & Mobile Access

Control your VS Code AskAway extension from any browser, phone, or tablet on your local network.

## Features

- 📱 **Mobile-First Design** - Optimized for touch interfaces and mobile browsers
- 🔄 **Real-Time Sync** - Changes in VS Code instantly appear on mobile and vice versa
- 🔐 **PIN Authentication** - Simple 4-digit PIN for secure local access
- 📲 **PWA Support** - Install as an app on your phone for native-like experience
- 🖥️ **Multi-Session** - Access multiple VS Code windows from one device
- 🎨 **Identical UI** - Same interface as VS Code extension, 100% feature parity

## Quick Start

### 1. Start the Remote Server

**Option A: Via Command Palette**
1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type "AskAway: Start Remote Server"
3. Note the PIN displayed in the notification

**Option B: Auto-Start**
1. Open VS Code Settings (`Cmd+,`)
2. Search for "AskAway"
3. Enable "Remote Enabled"
4. The server will start automatically on next VS Code launch

### 2. Connect from Your Phone

1. Ensure your phone is on the **same WiFi network** as your computer
2. Open the URL shown in the notification (e.g., `http://192.168.1.5:3000`)
3. Enter the 4-digit PIN
4. Tap "Connect"

### 3. Install as an App (PWA)

**iOS (Safari):**
1. Open the AskAway URL in Safari
2. Tap the Share button (box with arrow)
3. Tap "Add to Home Screen"
4. Name it "AskAway" and tap "Add"

**Android (Chrome):**
1. Open the AskAway URL in Chrome
2. Tap the menu (three dots)
3. Tap "Add to Home Screen" or "Install app"
4. Tap "Install"

## Usage Scenarios

### 🛋️ Couch Mode
- Lock your computer screen
- Continue monitoring AI conversations from your phone
- Approve/reject requests, add to queue, or provide feedback

### 🚶 Walk-Around Mode
- Step away from your desk
- Get notified when AI needs input (via browser notifications)
- Quickly respond from anywhere in your house/office

### 🖥️ Multi-Monitor Alternative
- Don't have a second monitor?
- Use your phone/tablet as a dedicated AskAway display
- Keep your main screen for coding

## Commands

| Command | Description |
|---------|-------------|
| `AskAway: Start Remote Server` | Start the remote UI server |
| `AskAway: Stop Remote Server` | Stop the remote UI server |
| `AskAway: Show Remote URL` | Display connection URL and PIN |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `askaway.remoteEnabled` | `false` | Auto-start remote server on VS Code launch |
| `askaway.remotePort` | `3000` | Preferred port (auto-increments if in use) |

## Multiple VS Code Windows

Each VS Code window can run its own remote server on a different port:
- Window 1: `http://192.168.1.5:3000`
- Window 2: `http://192.168.1.5:3001`
- Window 3: `http://192.168.1.5:3002`

The landing page shows all active sessions, letting you switch between them.

## Security

- **Local Network Only** - The server only accepts connections from your local network
- **PIN Required** - Every connection requires a 4-digit PIN
- **Session-Based** - PINs are regenerated when VS Code restarts
- **No Internet Exposure** - Your conversations never leave your local network

⚠️ **Note**: If you're on a public/shared WiFi (coffee shop, airport), others on that network could potentially access your AskAway if they know your IP and PIN. For sensitive work, only use on trusted private networks.

## Troubleshooting

### Can't Connect from Phone

1. **Check WiFi**: Ensure phone and computer are on the same network
2. **Check IP**: The URL should use your computer's local IP (192.168.x.x or 10.x.x.x)
3. **Check Firewall**: macOS may block incoming connections
   - Go to System Preferences → Security & Privacy → Firewall
   - Either disable firewall or add VS Code to allowed apps
4. **Check Port**: Try a different port if 3000 is blocked

### Connection Drops

- The server stops when VS Code closes or the window is minimized for too long
- Screen lock doesn't affect the server
- If disconnected, refresh the page and re-enter PIN

### PWA Not Updating

If the app shows old UI after an update:
1. Close all AskAway PWA windows
2. Clear browser cache for the AskAway URL
3. Re-open and re-install if needed

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Computer                            │
│                                                              │
│  ┌─────────────┐       ┌─────────────┐       ┌───────────┐ │
│  │  VS Code    │◄─────►│  AskAway   │◄─────►│  Express  │ │
│  │  Extension  │       │  Webview    │       │  Server   │ │
│  │             │       │  Provider   │       │  :3000    │ │
│  └─────────────┘       └─────────────┘       └─────┬─────┘ │
│                                                     │       │
└─────────────────────────────────────────────────────┼───────┘
                                                      │
                          WiFi Network                │
                                                      │
┌─────────────────────────────────────────────────────┼───────┐
│                      Your Phone                     │       │
│                                                     ▼       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              AskAway PWA / Browser                  │   │
│  │                                                      │   │
│  │   ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │   │  Queue   │  │  Chat    │  │  Input / Actions │  │   │
│  │   │  Panel   │  │  History │  │                  │  │   │
│  │   └──────────┘  └──────────┘  └──────────────────┘  │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Future Roadmap

- [ ] Push notifications for mobile (requires HTTPS/service worker)
- [ ] QR code for easy connection
- [ ] Session persistence across server restarts
- [ ] Voice input for hands-free interaction
- [ ] Dark/Light theme toggle in web UI

> [!WARNING]
> **This is a fork of [4regab/TaskSync](https://github.com/4regab/TaskSync)** with additional features including Remote Mobile/Web Access. See the [original repository](https://github.com/4regab/TaskSync) for the upstream project and community discussions.

---

## 📱 NEW: Remote Mobile & Web Access

<p align="center">
  <strong>Control TaskSync from your phone, tablet, or any browser on your network!</strong>
</p>

**Why Remote Access?**
- 🛋️ Work from your couch while AI agents run on your computer
- 📱 Monitor and respond to AI prompts from your phone
- 🔒 Works when your computer screen is locked
- ⚡ Real-time sync - see tool calls as they happen

**Quick Start:**
1. Run command: `TaskSync: Start Remote Server` (click broadcast icon in TaskSync panel)
2. Open the URL on your phone (e.g., `http://192.168.1.5:3000`)
3. Enter the 4-digit PIN shown in VS Code
4. Use TaskSync from anywhere!

**Features:**
- PWA support - install as an app on your phone
- Session isolation - each VS Code window gets its own PIN
- Same full UI as the desktop extension
- See [Remote Access Documentation](tasksync-chat/docs/REMOTE_ACCESS.md) for details

---

> [!WARNING]
> **GitHub Security Notice:**  
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>   
> **Use TaskSync responsibly and at your own risk. You are responsible for ensuring your usage complies with GitHub's terms of service.**
<h1>TaskSync</h1>

Reduce premium AI requests and manage tasks seamlessly with human-in-the-loop workflows. TaskSync provides three options to integrate feedback loops into your AI-assisted development.

## Choose Your Option

### Option 1: [TaskSync](https://marketplace.visualstudio.com/items?itemName=intuitiv.tasksync-chat) (VS Code Extension) - Recommended

A dedicated VS Code sidebar extension with smart prompt queue system.

**Features:**
- Smart Queue Mode - batch responses for AI agents
- Give new tasks/feedback using ask_user tool
- File/folder references with `#` autocomplete
- Image paste support (copilot will view your image)
- Tool call history with session tracking
- **📱 Remote Mobile/Web Access** - control from your phone!

**Installation:** Install from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=intuitiv.tasksync-chat) or build from source with `npx vsce package`.

---

## Best Practices (VS Code Copilot)

For GPT models, use TaskSync MCP or Extension.

Recommended settings for agent mode:
```json
"chat.agent.maxRequests": 999
```

**Enable "Auto Approve" in settings for uninterrupted agent operation. Keep sessions to 1-2 hours max to avoid hallucinations.**

## License

MIT - See [LICENSE](LICENSE) for details.


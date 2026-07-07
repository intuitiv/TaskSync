#!/usr/bin/env node
/**
 * test-telegram-flow.js
 *
 * Standalone script that mimics AskAway's Telegram flow end-to-end:
 *   1. Sends a formatted question to Telegram (with optional inline-keyboard choices)
 *   2. Polls for a reply (backoff schedule: 2s, 2s, 5s, 10s, 30s then every 60s)
 *   3. On reply → marks the message as "✅ Resolved", stops polling, exits.
 *
 * Usage:
 *   node test-telegram-flow.js
 *
 * Environment variables (or edit the constants below):
 *   TELEGRAM_BOT_TOKEN   — your bot token from @BotFather
 *   TELEGRAM_CHAT_ID     — the chat ID to send to
 *
 * You can also pass a custom question:
 *   node test-telegram-flow.js "Should I refactor the auth module?"
 */

// ── Configuration ──────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8503887192:AAE2_zgGayrGab7ysfGPqM0q704QO-nxUQg';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '2041101252';

const QUESTION  = process.argv[2] || 'Hello from the AskAway test script!\n\n**Bold test**, *italic test*, `code test`.\n\n### A Heading\n\n- Bullet one\n- Bullet two\n- [ ] Unchecked task\n- [x] Checked task\n\n1. First item\n2. Second item\n\n| Name | Role |\n| --- | --- |\n| Alice | Dev |\n| Bob | PM |\n\n> This is a blockquote\n\nSee [example](https://example.com) for details.\n\n---\n\n```python\nx = 10 ** 2\n```\n\nPlease reply to confirm.';
const CHOICES   = ['Yes', 'No', 'Skip'];   // set to [] for no inline buttons

// Backoff schedule (seconds) — matches the extension exactly
const BACKOFF = [2, 2, 5, 10, 30];
const STEADY_INTERVAL_S = 60;

// ── Telegram API helpers ───────────────────────────────────────
const https = require('https');
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function tg(method, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const url = new URL(`${API}/${method}`);
        const opts = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        };
        const req = https.request(opts, (res) => {
            let chunks = '';
            res.on('data', (d) => { chunks += d; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(chunks);
                    if (!json.ok) return reject(new Error(`Telegram ${method} failed: ${chunks}`));
                    resolve(json.result);
                } catch (e) { reject(new Error(`Bad JSON from ${method}: ${chunks}`)); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── Markdown → Telegram HTML (mirrors the extension) ───────────
function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTable(block) {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return `<pre>${escapeHtml(block)}</pre>`;
    const parsed = []; let hasSep = false;
    for (const row of rows) {
        const cells = row.split('|').map(c => c.trim());
        const trimmed = cells.length > 2 && cells[0] === '' && cells[cells.length - 1] === ''
            ? cells.slice(1, -1) : cells.filter(c => c !== '');
        if (trimmed.every(c => /^[-:]+$/.test(c))) { hasSep = true; continue; }
        parsed.push(trimmed);
    }
    if (!hasSep || parsed.length === 0) return `<pre>${escapeHtml(block)}</pre>`;
    const numCols = Math.max(...parsed.map(r => r.length));
    const widths = Array(numCols).fill(3);
    for (let c = 0; c < numCols; c++)
        for (const row of parsed)
            if (row[c]) widths[c] = Math.max(widths[c], row[c].length);
    const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
    const top = '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
    const mid = '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
    const bot = '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
    const lines = [top];
    parsed.forEach((row, i) => {
        const cells = widths.map((w, c) => ` ${pad(row[c] || '', w)} `);
        lines.push('│' + cells.join('│') + '│');
        if (i === 0 && parsed.length > 1) lines.push(mid);
    });
    lines.push(bot);
    return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

function markdownToHtml(text) {
    const preserved = [];
    const hold = (html) => { const i = preserved.length; preserved.push(html); return `\x00P${i}\x00`; };
    let r = text;
    // Fenced code blocks
    r = r.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
        const esc = escapeHtml(code.replace(/\n$/, ''));
        const attr = lang ? ` class="language-${lang}"` : '';
        return hold(`<pre><code${attr}>${esc}</code></pre>`);
    });
    // Inline code
    r = r.replace(/`([^`\n]+?)`/g, (_m, code) => hold(`<code>${escapeHtml(code)}</code>`));
    // Tables
    r = r.replace(/(?:^\|.+\|[ \t]*$\n?)+/gm, (block) => hold(formatTable(block)));
    // HTML-escape remaining
    r = r.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Headings
    r = r.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    // Bold
    r = r.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
    r = r.replace(/__([\s\S]+?)__/g, '<b>$1</b>');
    // Italic (word-boundary aware)
    r = r.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
    r = r.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
    // Strikethrough
    r = r.replace(/~~(.+?)~~/g, '<s>$1</s>');
    // Links & images
    r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">🖼 $1</a>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Blockquotes
    r = r.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
        const lines = match.split('\n').filter(l => l.startsWith('&gt;')).map(l => l.replace(/^&gt;\s?/, ''));
        return `<blockquote>${lines.join('\n')}</blockquote>\n`;
    });
    // Horizontal rules
    r = r.replace(/^[-*_]{3,}\s*$/gm, '─'.repeat(21));
    // Bullet lists
    r = r.replace(/^[ \t]*[-*+]\s+(.+)$/gm, '  • $1');
    // Numbered lists
    r = r.replace(/^[ \t]*(\d+)\.\s+(.+)$/gm, '  $1. $2');
    // Task lists
    r = r.replace(/• \[ \]\s*/g, '☐ ');
    r = r.replace(/• \[x\]\s*/gi, '☑ ');
    // Restore
    r = r.replace(/\x00P(\d+)\x00/g, (_, idx) => preserved[parseInt(idx)]);
    return r;
}

// ── Helpers ────────────────────────────────────────────────────
function ts() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

function getDelay(tick) {
    if (tick < BACKOFF.length) return BACKOFF[tick];
    return STEADY_INTERVAL_S;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ───────────────────────────────────────────────────────
async function main() {
    // Validate config
    if (BOT_TOKEN.startsWith('<') || CHAT_ID.startsWith('<')) {
        console.error('ERROR: Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables (or edit the script).');
        process.exit(1);
    }

    // 1. Get bot info
    log('Getting bot info...');
    const me = await tg('getMe', {});
    log(`Bot: @${me.username} (id=${me.id})`);
    const botId = me.id;

    // 2. Format & send the question
    const taskId = `test_${Date.now()}`;
    let formattedText = `🔔 <b>AskAway — Question</b>\n\n${markdownToHtml(QUESTION)}`;
    if (CHOICES.length > 0) {
        formattedText += '\n\n<b>Options:</b>\n';
        CHOICES.forEach((c, i) => { formattedText += `${i + 1}. ${escapeHtml(c)}\n`; });
        formattedText += '\n<i>Reply with the option number or your answer.</i>';
    } else {
        formattedText += '\n\n<i>Reply to this message with your answer.</i>';
    }

    const sendBody = {
        chat_id: CHAT_ID,
        text: formattedText,
        parse_mode: 'HTML',
    };
    if (CHOICES.length > 0) {
        sendBody.reply_markup = {
            inline_keyboard: CHOICES.map(c => ([{
                text: c,
                callback_data: `askaway:${taskId}:${c.substring(0, 60)}`
            }]))
        };
    }

    log('Sending question to Telegram...');
    const sentMsg = await tg('sendMessage', sendBody);
    const messageId = sentMsg.message_id;
    log(`✅ Sent — messageId=${messageId}`);

    // 3. Poll for reply
    let lastUpdateId = 0;
    let tick = 0;
    let resolved = false;

    log('Starting poll loop...');
    while (!resolved) {
        const delaySec = getDelay(tick);
        log(`Poll #${tick + 1} — waiting ${delaySec}s...`);
        await sleep(delaySec * 1000);

        try {
            const updates = await tg('getUpdates', {
                offset: lastUpdateId + 1,
                timeout: 0,
                allowed_updates: ['message', 'callback_query']
            });

            for (const update of updates) {
                lastUpdateId = Math.max(lastUpdateId, update.update_id);

                // Callback query (button press)
                if (update.callback_query) {
                    const cbData = update.callback_query.data || '';
                    const parts = cbData.split(':');
                    if (parts[0] === 'askaway' && parts[1] === taskId) {
                        const answer = parts.slice(2).join(':');
                        const user = update.callback_query.from?.username || update.callback_query.from?.first_name || 'unknown';
                        log(`🎯 Button reply from ${user}: "${answer}"`);

                        await tg('answerCallbackQuery', {
                            callback_query_id: update.callback_query.id,
                            text: 'Answer received!'
                        });

                        await markResolved(messageId, QUESTION, answer, user);
                        resolved = true;
                        break;
                    }
                    continue;
                }

                // Text message
                const msg = update.message;
                if (!msg || !msg.text) continue;
                if (msg.from?.id === botId) continue;

                // Accept reply-to-message OR plain text (single-task fallback)
                const isReply = msg.reply_to_message?.message_id === messageId;
                if (isReply || true /* single task fallback */) {
                    const answer = msg.text.trim();
                    const user = msg.from?.username || msg.from?.first_name || 'unknown';
                    if (!answer) continue;

                    log(`🎯 Text reply from ${user}: "${answer}"`);
                    await markResolved(messageId, QUESTION, answer, user);
                    resolved = true;
                    break;
                }
            }

            if (!resolved) {
                // Update footer with sync times
                const nextDelay = getDelay(tick + 1);
                const now = ts();
                const next = new Date(Date.now() + nextDelay * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
                const footer = `\n\n<i>🔄 Last sync: ${now} · Next sync: ${next}</i>`;
                try {
                    const editBody = { chat_id: CHAT_ID, message_id: messageId, text: formattedText + footer, parse_mode: 'HTML' };
                    if (CHOICES.length > 0) {
                        editBody.reply_markup = {
                            inline_keyboard: CHOICES.map(c => ([{
                                text: c,
                                callback_data: `askaway:${taskId}:${c.substring(0, 60)}`
                            }]))
                        };
                    }
                    await tg('editMessageText', editBody);
                } catch { /* footer update is non-critical */ }
            }
        } catch (e) {
            log(`⚠️  Poll error: ${e.message}`);
        }

        tick++;
    }

    log('✅ Done — polling stopped, task resolved.');
}

async function markResolved(messageId, question, answer, user) {
    const text = `✅ <b>Resolved</b>\n\n` +
        `<b>Q:</b> ${markdownToHtml(question)}\n` +
        `<b>A:</b> ${escapeHtml(answer)}\n` +
        `<b>By:</b> ${escapeHtml(user)}`;
    await tg('editMessageText', {
        chat_id: CHAT_ID,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
    });
    log('Message updated to Resolved ✅');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

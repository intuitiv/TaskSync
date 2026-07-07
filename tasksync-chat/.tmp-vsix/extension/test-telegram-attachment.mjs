#!/usr/bin/env node
/**
 * Standalone test for Telegram attachment download flow.
 * Sends a prompt to Telegram, polls for a reply (text or media),
 * downloads any attachments, and reports what was received.
 *
 * Usage: node test-telegram-attachment.mjs
 */

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import https from 'https';

// ── Config ──
const BOT_TOKEN = execSync('security find-generic-password -a "vibecoding" -s "telegram-bot-token" -w', { encoding: 'utf8' }).trim();
const CHAT_ID = execSync('security find-generic-password -a "vibecoding" -s "telegram-chat-id" -w', { encoding: 'utf8' }).trim();
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Helpers ──
function httpsRequest(url, options = {}, bodyStr = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (options.raw) { resolve(buf); return; }
                try { resolve(JSON.parse(buf.toString())); }
                catch { resolve(buf.toString()); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

async function apiCall(method, body) {
    const data = await httpsRequest(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify(body));
    if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
    return data.result;
}

async function downloadFile(fileId, suggestedName) {
    // Step 1: getFile to get file_path
    const fileInfo = await apiCall('getFile', { file_id: fileId });
    const filePath = fileInfo.file_path;
    console.log(`  📁 Telegram file path: ${filePath}`);

    // Step 2: Download
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const rawData = await httpsRequest(url, { raw: true });

    // Step 3: Save locally
    const ext = filePath.includes('.') ? '.' + filePath.split('.').pop() : '';
    const localName = suggestedName || `file_${Date.now()}${ext}`;
    const tmpDir = join(tmpdir(), 'tasksync-attachments-test');
    mkdirSync(tmpDir, { recursive: true });
    const localPath = join(tmpDir, localName);

    const fileBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    writeFileSync(localPath, fileBuffer);
    console.log(`  💾 Saved: ${localPath} (${fileBuffer.length} bytes)`);
    return { localPath, size: fileBuffer.length, mimeGuess: ext };
}

function extractMedia(msg) {
    const media = [];
    if (msg.photo?.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        media.push({ fileId: largest.file_id, name: `photo_${largest.file_unique_id}.jpg`, type: 'photo' });
    }
    if (msg.document) {
        media.push({ fileId: msg.document.file_id, name: msg.document.file_name || 'document', type: 'document' });
    }
    if (msg.video) {
        media.push({ fileId: msg.video.file_id, name: msg.video.file_name || 'video.mp4', type: 'video' });
    }
    if (msg.audio) {
        media.push({ fileId: msg.audio.file_id, name: msg.audio.file_name || 'audio.mp3', type: 'audio' });
    }
    if (msg.voice) {
        media.push({ fileId: msg.voice.file_id, name: 'voice.ogg', type: 'voice' });
    }
    if (msg.sticker) {
        media.push({ fileId: msg.sticker.file_id, name: `sticker.${msg.sticker.is_video ? 'webm' : 'webp'}`, type: 'sticker' });
    }
    if (msg.animation) {
        media.push({ fileId: msg.animation.file_id, name: msg.animation.file_name || 'animation.mp4', type: 'animation' });
    }
    return media;
}

// ── Main ──
async function main() {
    console.log('🚀 Telegram Attachment Test');
    console.log(`   Bot token: ${BOT_TOKEN.substring(0, 10)}...`);
    console.log(`   Chat ID: ${CHAT_ID}`);

    // Step 1: Flush old updates
    const oldUpdates = await apiCall('getUpdates', { offset: -1 });
    let lastUpdateId = oldUpdates.length > 0 ? oldUpdates[oldUpdates.length - 1].update_id : 0;
    console.log(`   Flushed updates, offset: ${lastUpdateId}`);

    // Step 2: Send test message
    const sentMsg = await apiCall('sendMessage', {
        chat_id: CHAT_ID,
        text: '📎 *Attachment Test*\n\nSend me any attachment (photo, document, video, audio, sticker, GIF) and I\'ll download it!',
        parse_mode: 'Markdown'
    });
    console.log(`\n📤 Sent prompt (message_id: ${sentMsg.message_id})`);
    console.log('⏳ Waiting for your reply (polling every 3s, timeout 120s)...\n');

    // Step 3: Poll for reply
    const startTime = Date.now();
    const TIMEOUT_MS = 120_000;
    const POLL_INTERVAL_MS = 3_000;

    // Get bot ID to skip own messages
    const botInfo = await apiCall('getMe', {});
    const botId = botInfo.id;

    while (Date.now() - startTime < TIMEOUT_MS) {
        const updates = await apiCall('getUpdates', { offset: lastUpdateId + 1, timeout: 0 });

        for (const update of updates) {
            lastUpdateId = Math.max(lastUpdateId, update.update_id);
            const msg = update.message;
            if (!msg) continue;
            if (msg.from?.id === botId) continue;

            const text = msg.text || msg.caption || '';
            const media = extractMedia(msg);

            console.log('📥 Received message:');
            console.log(`   From: ${msg.from?.username || msg.from?.first_name || 'unknown'}`);
            if (text) console.log(`   Text/Caption: "${text}"`);
            console.log(`   Media items: ${media.length}`);

            if (media.length > 0) {
                console.log('\n📦 Downloading attachments...');
                for (const item of media) {
                    console.log(`\n  🔽 ${item.type}: ${item.name}`);
                    try {
                        const result = await downloadFile(item.fileId, item.name);
                        console.log(`  ✅ Downloaded successfully!`);
                    } catch (err) {
                        console.error(`  ❌ Download failed:`, err.message);
                    }
                }
            }

            if (text || media.length > 0) {
                // Send confirmation
                const attachmentNames = media.map(m => m.name).join(', ');
                const confirmText = media.length > 0
                    ? `✅ Received ${media.length} attachment(s): ${attachmentNames}\n\nText/Caption: ${text || '(none)'}`
                    : `✅ Received text: ${text}`;
                await apiCall('sendMessage', { chat_id: CHAT_ID, text: confirmText });
                console.log('\n✅ Test complete! Sent confirmation to Telegram.');
                return;
            }
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        process.stdout.write('.');
    }

    console.log('\n⏰ Timeout — no reply received in 120s.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

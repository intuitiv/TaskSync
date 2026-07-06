import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Shared access to the VS Code Copilot "memory tool" store. AskAway reuses the
 * same on-disk filesystem so that any memory written here is automatically
 * visible to every agent that uses the built-in `memory` tool (the first lines
 * of user memory are auto-loaded into agent context).
 *
 * User memory is stored as plain `.md` files under:
 *   <User>/globalStorage/github.copilot-chat/memory-tool/memories/
 * We resolve it as a sibling of AskAway's own globalStorage directory.
 */
export function getUserMemoryDir(context: vscode.ExtensionContext): string {
    const globalRoot = path.dirname(context.globalStorageUri.fsPath);
    return path.join(globalRoot, 'github.copilot-chat', 'memory-tool', 'memories');
}

export interface MemorySearchHit {
    file: string;
    score: number;
    snippets: string[];
}

// ── Local model (LM Studio / Ollama, OpenAI-compatible) ──────────────────────
// All summarization and embedding calls go to a LOCAL server so they never
// consume Copilot credits. Everything below degrades gracefully: if the server
// or a model is unavailable, summarization is skipped (raw capture stored) and
// search falls back to keyword matching.

export interface LocalModelConfig {
    baseUrl: string;
    summarizationModel: string;
    embeddingModel: string;
}

export function getLocalModelConfig(): LocalModelConfig {
    const cfg = vscode.workspace.getConfiguration('askaway.localModel');
    const baseUrl = (cfg.get<string>('baseUrl') || 'http://localhost:1234/v1').replace(/\/+$/, '');
    return {
        baseUrl,
        summarizationModel: (cfg.get<string>('summarizationModel') || '').trim(),
        embeddingModel: (cfg.get<string>('embeddingModel') || '').trim(),
    };
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<any | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            return null;
        }
        return await res.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Chat completion via the local OpenAI-compatible server. Returns null on any failure. */
async function localChat(cfg: LocalModelConfig, system: string, user: string): Promise<string | null> {
    if (!cfg.summarizationModel) {
        return null;
    }
    const data = await postJson(`${cfg.baseUrl}/chat/completions`, {
        model: cfg.summarizationModel,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        temperature: 0.2,
        stream: false,
    }, 60000);
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/** Embedding vector via the local OpenAI-compatible server. Returns null on any failure. */
async function localEmbed(cfg: LocalModelConfig, text: string): Promise<number[] | null> {
    if (!cfg.embeddingModel) {
        return null;
    }
    const data = await postJson(`${cfg.baseUrl}/embeddings`, {
        model: cfg.embeddingModel,
        input: text.slice(0, 8000),
    }, 30000);
    const vec = data?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length ? vec as number[] : null;
}

// ── Embedding index (sidecar `_embeddings.json` in the memory dir) ───────────

interface EmbeddingIndex {
    version: number;
    model: string;
    entries: Record<string, { hash: string; vector: number[] }>;
}

function embeddingIndexPath(dir: string): string {
    return path.join(dir, '_embeddings.json');
}

async function loadEmbeddingIndex(dir: string): Promise<EmbeddingIndex> {
    try {
        const raw = await fs.promises.readFile(embeddingIndexPath(dir), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.entries) {
            return parsed as EmbeddingIndex;
        }
    } catch {
        // Missing/corrupt index — start fresh.
    }
    return { version: 1, model: '', entries: {} };
}

async function saveEmbeddingIndex(dir: string, idx: EmbeddingIndex): Promise<void> {
    try {
        await fs.promises.writeFile(embeddingIndexPath(dir), JSON.stringify(idx));
    } catch {
        // Best-effort persistence.
    }
}

function hashContent(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function cosineSim(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) {
        return 0;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed a memory file's content and persist its vector (best-effort, content-hashed). */
async function upsertEmbedding(dir: string, file: string, content: string): Promise<void> {
    const cfg = getLocalModelConfig();
    if (!cfg.embeddingModel) {
        return;
    }
    const hash = hashContent(content);
    const idx = await loadEmbeddingIndex(dir);
    const existing = idx.entries[file];
    if (existing && existing.hash === hash && idx.model === cfg.embeddingModel) {
        return;
    }
    const vector = await localEmbed(cfg, content);
    if (!vector) {
        return;
    }
    idx.model = cfg.embeddingModel;
    idx.entries[file] = { hash, vector };
    await saveEmbeddingIndex(dir, idx);
}

/**
 * Search user memory `.md` files. Semantic-first: when a local embedding model
 * is configured and reachable, files are ranked by cosine similarity to the
 * query embedding; otherwise it falls back to keyword relevance. Keyword hits
 * are always blended in so exact-term matches still surface.
 */
export async function searchMemories(dir: string, query: string, maxResults: number): Promise<MemorySearchHit[]> {
    let files: string[];
    try {
        files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.md') && f !== '_index.md');
    } catch {
        return [];
    }
    if (files.length === 0) {
        return [];
    }

    const terms = String(query || '')
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.replace(/[^a-z0-9_-]/g, ''))
        .filter(t => t.length >= 2);

    // Load file contents once.
    const contents = new Map<string, string>();
    for (const file of files) {
        try {
            contents.set(file, await fs.promises.readFile(path.join(dir, file), 'utf8'));
        } catch {
            // Skip unreadable files.
        }
    }

    // Semantic scores (best-effort).
    const cfg = getLocalModelConfig();
    let semScores: Map<string, number> | null = null;
    if (cfg.embeddingModel && query.trim()) {
        const qvec = await localEmbed(cfg, query.trim());
        if (qvec) {
            const idx = await loadEmbeddingIndex(dir);
            const m = new Map<string, number>();
            for (const file of files) {
                const entry = idx.entries[file];
                if (entry?.vector) {
                    m.set(file, cosineSim(qvec, entry.vector));
                }
            }
            if (m.size > 0) {
                semScores = m;
            }
        }
    }

    const hits: MemorySearchHit[] = [];
    for (const file of files) {
        const content = contents.get(file);
        if (content === undefined) {
            continue;
        }
        const lower = content.toLowerCase();

        // Keyword score (term frequency + filename boost).
        let kw = 0;
        for (const term of terms) {
            let idx = 0;
            let count = 0;
            while ((idx = lower.indexOf(term, idx)) !== -1) {
                count++;
                idx += term.length;
            }
            kw += count;
        }
        const nameLower = file.toLowerCase();
        for (const term of terms) {
            if (nameLower.includes(term)) {
                kw += 5;
            }
        }

        const sem = semScores?.get(file) ?? null;

        // Include a file if it matches semantically OR by keyword.
        const include = (sem !== null && sem >= 0.2) || kw > 0;
        if (!include) {
            continue;
        }

        // Prefer term-matching snippet lines; otherwise the first prose lines.
        const snippets: string[] = [];
        if (terms.length) {
            for (const line of content.split(/\r?\n/)) {
                const ll = line.toLowerCase();
                if (line.trim() && terms.some(t => ll.includes(t))) {
                    snippets.push(line.trim().slice(0, 200));
                    if (snippets.length >= 5) {
                        break;
                    }
                }
            }
        }
        if (snippets.length === 0) {
            for (const line of content.split(/\r?\n/)) {
                if (line.trim() && !line.trim().startsWith('#')) {
                    snippets.push(line.trim().slice(0, 200));
                    if (snippets.length >= 3) {
                        break;
                    }
                }
            }
        }

        const score = sem !== null ? Math.round(sem * 100) + Math.min(kw, 20) : kw;
        hits.push({ file, score, snippets });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, maxResults));
}

export interface MemoryListEntry {
    file: string;
    title: string;
    size: number;
    modified: number;
}

/** List user memory notes (newest first) for display, excluding internal index files. */
export async function listMemories(dir: string): Promise<MemoryListEntry[]> {
    let files: string[];
    try {
        files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.md') && f !== '_index.md');
    } catch {
        return [];
    }

    const entries: MemoryListEntry[] = [];
    for (const file of files) {
        try {
            const full = path.join(dir, file);
            const stat = await fs.promises.stat(full);
            let title = file.replace(/\.md$/, '');
            try {
                const head = (await fs.promises.readFile(full, 'utf8')).split(/\r?\n/);
                const heading = head.find(l => l.trim().startsWith('# '));
                if (heading) {
                    title = heading.replace(/^#+\s*/, '').trim().slice(0, 80);
                }
            } catch {
                // Keep filename-derived title.
            }
            entries.push({ file, title, size: stat.size, modified: stat.mtimeMs });
        } catch {
            // Skip unreadable.
        }
    }

    entries.sort((a, b) => b.modified - a.modified);
    return entries;
}

/** Turn an arbitrary topic into a safe memory filename slug. */
export function slugify(topic: string): string {
    const slug = String(topic || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || 'memory';
}

/** Write (or overwrite) a memory file, refresh the catalog index, and embed it. */
export async function writeMemory(dir: string, slug: string, content: string): Promise<string> {
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slug}.md`);
    const finalContent = content.endsWith('\n') ? content : content + '\n';
    await fs.promises.writeFile(file, finalContent);
    await updateMemoryIndex(dir).catch(() => undefined);
    await upsertEmbedding(dir, `${slug}.md`, finalContent).catch(() => undefined);
    return file;
}

/** Regenerate `_index.md` — a one-line-per-file catalog the agent always sees. */
export async function updateMemoryIndex(dir: string): Promise<void> {
    let files: string[];
    try {
        files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.md') && f !== '_index.md');
    } catch {
        return;
    }
    files.sort();

    const lines: string[] = [
        '# Memory Index',
        '',
        '_Auto-generated catalog of memory files. Use `memory_search` or `view` to read a file._',
        ''
    ];
    for (const f of files) {
        let summary = '';
        try {
            const content = await fs.promises.readFile(path.join(dir, f), 'utf8');
            const ls = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const heading = ls.find(l => l.startsWith('# '));
            const firstProse = ls.find(l => !l.startsWith('#'));
            summary = (heading ? heading.replace(/^#+\s*/, '') : '') || firstProse || '';
        } catch {
            // Leave summary blank if unreadable.
        }
        lines.push(`- \`${f}\` — ${summary.slice(0, 120)}`);
    }

    await fs.promises.writeFile(path.join(dir, '_index.md'), lines.join('\n') + '\n');
}

/**
 * Distill sub-agent / research output into a durable memory note using the
 * configured LOCAL model (no Copilot credits). If no summarization model is
 * configured or the local server is unreachable, a trimmed raw capture is
 * stored instead. The note is embedded for semantic search on write.
 * Returns the written file path, or null if the material is too small to keep.
 */
export async function summarizeAndStoreMemory(dir: string, topic: string, material: string): Promise<string | null> {
    const trimmed = String(material || '').trim();
    if (trimmed.length < 200) {
        return null;
    }

    const cfg = getLocalModelConfig();
    let summary: string | null = null;
    if (cfg.summarizationModel) {
        const system =
            'You distill sub-agent research output into a durable, reusable memory note for future agents. ' +
            'Write concise Markdown. Start with a single `# <Topic>` heading, then a one-line summary, then ' +
            'tight bullet points of durable facts, decisions, gotchas, file paths, and commands. ' +
            'Omit transient chatter, greetings, and tool noise. Keep it under ~40 lines.';
        const user = `Topic: ${topic}\n\nSub-agent output to distill:\n${trimmed.slice(0, 24000)}`;
        summary = await localChat(cfg, system, user);
    }

    const stamp = new Date().toISOString().slice(0, 10);
    let body: string;
    let note: string;
    if (summary) {
        body = summary.startsWith('#') ? summary : `# ${topic}\n\n${summary}`;
        note = 'distilled by local model';
    } else {
        // No summarization model available — store a trimmed raw capture.
        const raw = trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n\n…(truncated)' : trimmed;
        body = `# ${topic}\n\n${raw}`;
        note = 'raw capture (no summarization model)';
    }

    const withMeta = `${body}\n\n_Captured from sub-agent on ${stamp} (${note})._`;
    try {
        return await writeMemory(dir, slugify(topic), withMeta);
    } catch {
        return null;
    }
}

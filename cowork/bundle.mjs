#!/usr/bin/env node
// cowork/bundle.mjs — FREE, LOCAL. Expands .askaway/cowork-manifest.json into a
// single self-contained bundle (.askaway/cowork-bundle.md) for offline brainstorming
// in Microsoft Copilot cowork. Zero token cost — pure fs. No dependencies.
//
// Usage:
//   node cowork/bundle.mjs                 # uses .askaway/cowork-manifest.json
//   node cowork/bundle.mjs path/to/manifest.json
//   node cowork/bundle.mjs --out foo.md    # custom output path
//   node cowork/bundle.mjs --max-bytes 200000   # per-file truncation cap (default 400k)

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));

const ROOT = process.cwd();
const manifestPath = path.resolve(positional[0] || path.join('.askaway', 'cowork-manifest.json'));
const outPath = path.resolve(opt('--out', path.join('.askaway', 'cowork-bundle.md')));
const perFileCap = parseInt(opt('--max-bytes', '400000'), 10);

if (!fs.existsSync(manifestPath)) {
  console.error(`✗ Manifest not found: ${manifestPath}`);
  console.error('  Run /export-to-cowork in chat first to generate it.');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`✗ Manifest is not valid JSON: ${e.message}`);
  process.exit(1);
}

// ---- tiny glob (supports ** and *) ---------------------------------------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** -> match across path separators
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // consume trailing slash of **/
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', 'out', '.tmp-vsix', '.gradle-test-build']);

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.DS_Store')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function expandGlob(glob) {
  const re = globToRegExp(glob);
  // Determine a base dir to limit the walk (up to the first wildcard segment).
  const segments = glob.split('/');
  const baseSegs = [];
  for (const s of segments) {
    if (s.includes('*') || s.includes('?')) break;
    baseSegs.push(s);
  }
  const base = path.resolve(ROOT, baseSegs.join('/') || '.');
  const all = fs.existsSync(base) && fs.statSync(base).isFile() ? [base] : walk(base, []);
  return all
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => re.test(rel));
}

// ---- collect target files ------------------------------------------------
const seen = new Set();
const fileEntries = []; // { abs, rel, reason }

function addFile(p, reason) {
  const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  if (seen.has(abs)) return;
  seen.add(abs);
  fileEntries.push({ abs, rel: path.relative(ROOT, abs) || abs, reason: reason || '' });
}

for (const f of manifest.files || []) {
  if (typeof f === 'string') addFile(f, '');
  else if (f && f.path) addFile(f.path, f.reason);
}
for (const g of manifest.globs || []) {
  for (const rel of expandGlob(g)) addFile(rel, `glob: ${g}`);
}

// ---- render bundle -------------------------------------------------------
const nl = '\n';
let out = '';
out += `# Cowork bundle — ${manifest.topic || 'untitled'}${nl}${nl}`;
out += `Generated: ${new Date().toISOString()} (from ${path.relative(ROOT, manifestPath)})${nl}${nl}`;

out += `## Task${nl}${nl}${(manifest.task || '(none)').trim()}${nl}${nl}`;

if (manifest.context) {
  out += `## Context${nl}${nl}`;
  const ctx = Array.isArray(manifest.context) ? manifest.context : [manifest.context];
  for (const c of ctx) out += `- ${String(c).trim()}${nl}`;
  out += nl;
}

if (manifest.expectedOutput) {
  out += `## Expected output${nl}${nl}${String(manifest.expectedOutput).trim()}${nl}${nl}`;
  out += `> When you (cowork) are done, return: (1) a short reasoning writeup, and (2) a unified diff patch (\`git diff\` format, paths relative to the repo root). The human will save the patch under \`.askaway/cowork-inbox/*.patch\` and run \`node cowork/apply.mjs\`.${nl}${nl}`;
}

out += `## Files (${fileEntries.length})${nl}${nl}`;

let included = 0;
let skipped = 0;
for (const { abs, rel, reason } of fileEntries) {
  let content;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      skipped++;
      continue;
    }
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    out += `=== ${rel} ===${nl}(could not read: ${e.message})${nl}${nl}`;
    skipped++;
    continue;
  }
  let note = '';
  if (Buffer.byteLength(content, 'utf8') > perFileCap) {
    content = content.slice(0, perFileCap);
    note = ` [truncated to ${perFileCap} bytes]`;
  }
  out += `=== ${rel}${reason ? ` — ${reason}` : ''}${note} ===${nl}`;
  out += content;
  if (!content.endsWith('\n')) out += nl;
  out += nl;
  included++;
}

// ---- append memories -----------------------------------------------------
const memories = manifest.memories || [];
if (memories.length) {
  out += `## Memories (${memories.length})${nl}${nl}`;
  for (const m of memories) {
    const abs = path.isAbsolute(m) ? m : path.resolve(ROOT, m);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      out += `=== memory: ${m} ===${nl}${content}${content.endsWith('\n') ? '' : nl}${nl}`;
    } catch (e) {
      out += `=== memory: ${m} ===${nl}(could not read: ${e.message})${nl}${nl}`;
    }
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out, 'utf8');

const bytes = Buffer.byteLength(out, 'utf8');
console.log(`✓ Bundle written: ${path.relative(ROOT, outPath)}`);
console.log(`  files: ${included} included, ${skipped} skipped · memories: ${memories.length}`);
console.log(`  size: ${(bytes / 1024).toFixed(1)} KB (~${Math.ceil(bytes / 4).toLocaleString()} tokens)`);
console.log('');
console.log('Next: upload the bundle to Microsoft Copilot cowork and brainstorm.');
console.log('When it returns a patch, save it under .askaway/cowork-inbox/ and run: node ~/.askaway/cowork/apply.mjs');

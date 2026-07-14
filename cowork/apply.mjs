#!/usr/bin/env node
// cowork/apply.mjs — RETURN LEG. Applies patches that Microsoft Copilot cowork
// produced, from .askaway/cowork-inbox/. Free, local. No dependencies.
//
// Behaviour:
//   - *.patch / *.diff  -> git apply (with --check first; --3way fallback)
//   - *.md / *.txt      -> printed as reasoning for you (or the agent) to read
//
// Usage:
//   node cowork/apply.mjs                 # apply everything in .askaway/cowork-inbox/
//   node cowork/apply.mjs --check         # dry-run: validate patches, apply nothing
//   node cowork/apply.mjs file.patch      # apply a single patch
//   node cowork/apply.mjs --dir some/dir  # custom inbox dir

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const inboxDir = path.resolve(opt('--dir', path.join('.askaway', 'cowork-inbox')));
const explicit = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));

function git(argv) {
  return execFileSync('git', argv, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

// Confirm we're in a git repo.
try {
  git(['rev-parse', '--is-inside-work-tree']);
} catch {
  console.error('✗ Not inside a git repository. Patch apply needs git.');
  process.exit(1);
}

let targets;
if (explicit.length) {
  targets = explicit.map((f) => path.resolve(f));
} else {
  if (!fs.existsSync(inboxDir)) {
    console.error(`✗ Inbox not found: ${inboxDir}`);
    console.error('  Create it and drop cowork output there:  mkdir -p .askaway/cowork-inbox');
    process.exit(1);
  }
  targets = fs
    .readdirSync(inboxDir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => path.join(inboxDir, f));
}

const patches = targets.filter((f) => /\.(patch|diff)$/i.test(f));
const notes = targets.filter((f) => /\.(md|txt)$/i.test(f));
const other = targets.filter((f) => !patches.includes(f) && !notes.includes(f));

if (!patches.length && !notes.length) {
  console.log('Nothing to apply. Put *.patch/*.diff and/or *.md reasoning in the inbox.');
}

// --- reasoning notes: surface them ---------------------------------------
for (const n of notes) {
  console.log(`\n───── reasoning: ${path.relative(process.cwd(), n)} ─────`);
  try {
    console.log(fs.readFileSync(n, 'utf8').trim());
  } catch (e) {
    console.log(`(could not read: ${e.message})`);
  }
  console.log('─────────────────────────────────────────');
}

// --- patches --------------------------------------------------------------
let applied = 0;
let failed = 0;
for (const p of patches) {
  const rel = path.relative(process.cwd(), p);
  if (!fs.existsSync(p)) {
    console.error(`✗ ${rel}: not found`);
    failed++;
    continue;
  }
  // Validate first.
  try {
    git(['apply', '--check', p]);
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : e.message).trim();
    console.error(`✗ ${rel}: does not apply cleanly\n   ${msg.split('\n').join('\n   ')}`);
    failed++;
    continue;
  }
  if (checkOnly) {
    console.log(`✓ ${rel}: would apply cleanly`);
    applied++;
    continue;
  }
  try {
    git(['apply', p]);
    console.log(`✓ ${rel}: applied`);
    applied++;
  } catch (e) {
    // fallback to 3-way
    try {
      git(['apply', '--3way', p]);
      console.log(`✓ ${rel}: applied (3-way merge)`);
      applied++;
    } catch (e2) {
      const msg = (e2.stderr ? e2.stderr.toString() : e2.message).trim();
      console.error(`✗ ${rel}: apply failed\n   ${msg}`);
      failed++;
    }
  }
}

for (const o of other) {
  console.log(`· skipped (unknown type): ${path.relative(process.cwd(), o)}`);
}

console.log('');
console.log(`Done. patches: ${applied} ${checkOnly ? 'validated' : 'applied'}, ${failed} failed · notes: ${notes.length}`);
if (!checkOnly && applied > 0) {
  console.log('Review with:  git diff   —   then commit when satisfied.');
}
process.exit(failed > 0 ? 1 : 0);

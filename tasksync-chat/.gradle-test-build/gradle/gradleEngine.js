"use strict";
// Standalone, VS Code-free Gradle async engine.
//
// This module has ZERO dependencies on the `vscode` API so it can run in any
// Node.js host: the AskAway MCP server (usable outside VS Code by any MCP
// client), a CLI, or tests. It spawns `./gradlew` directly via child_process,
// tracks each run in-memory keyed by a buildId, and exposes structured
// start / status / wait / stop / logs actions.
Object.defineProperty(exports, "__esModule", { value: true });
exports.findGradlew = findGradlew;
exports.extractTestReportFailures = extractTestReportFailures;
exports.dispatchGradle = dispatchGradle;
exports.killAllGradleRuns = killAllGradleRuns;
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const gradleRuns = new Map();
let gradleIdCounter = 0;
const GRADLE_MAX_BUFFER = 4 * 1024 * 1024; // 4 MB output cap
const GRADLE_MAX_RUNS = 20; // max retained runs
const GRADLE_RETAIN_MS = 30 * 60 * 1000; // drop runs older than 30 min
const GRADLE_SAFETY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per build
function findGradlew(startDir) {
    const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, wrapperName);
        try {
            fs.accessSync(candidate, fs.constants.F_OK);
            return candidate;
        }
        catch { /* walk up */ }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}
function pruneGradleRuns() {
    const now = Date.now();
    for (const [id, run] of gradleRuns) {
        if (run.state !== 'RUNNING' && now - (run.endTime ?? run.startTime) > GRADLE_RETAIN_MS) {
            gradleRuns.delete(id);
        }
    }
    if (gradleRuns.size > GRADLE_MAX_RUNS) {
        const sorted = [...gradleRuns.entries()].sort((a, b) => a[1].startTime - b[1].startTime);
        for (const [id, run] of sorted.slice(0, gradleRuns.size - GRADLE_MAX_RUNS)) {
            if (run.state !== 'RUNNING') {
                gradleRuns.delete(id);
            }
        }
    }
}
// Append-only "success story" log for optimized gradle runs, mirroring how RTK
// records its savings. Each finished run records the auto-applied optimizations
// plus cache-effectiveness (tasks served UP-TO-DATE / FROM-CACHE = work avoided).
const GRADLE_RUN_LOG = path.join(os.homedir(), '.askaway', 'gradle-runs.jsonl');
function recordGradleRun(run) {
    if (run.logged) {
        return;
    }
    run.logged = true;
    try {
        const raw = getRunBuffer(run);
        const upToDate = (raw.match(/^> Task \S+ UP-TO-DATE\s*$/gm) || []).length;
        const fromCache = (raw.match(/^> Task \S+ FROM-CACHE\s*$/gm) || []).length;
        const summary = raw.match(/(\d+) actionable tasks?: (.+)$/m);
        const executed = summary ? (summary[2].match(/(\d+) executed/)?.[1] ?? null) : null;
        const configCacheReused = /Reusing configuration cache/.test(raw);
        const record = {
            ts: run.endTime ?? Date.now(),
            tasks: run.tasks,
            optimizations: run.optimizations,
            state: run.state,
            exitCode: run.exitCode,
            elapsedSec: Math.round(((run.endTime ?? Date.now()) - run.startTime) / 1000),
            tasksUpToDate: upToDate,
            tasksFromCache: fromCache,
            tasksExecuted: executed ? Number(executed) : null,
            configCacheReused,
        };
        fs.mkdirSync(path.dirname(GRADLE_RUN_LOG), { recursive: true });
        fs.appendFileSync(GRADLE_RUN_LOG, JSON.stringify(record) + '\n', 'utf8');
    }
    catch {
        // Best-effort — never let logging affect a build.
    }
}
// Performance defaults the tool applies automatically so the agent can just say
// "run this task" and get fast, cached, parallel, daemonized builds. Each entry
// is skipped when the caller already passed the flag OR its opposite, so callers
// keep full control. Pass optimize:false to disable all of them.
const GRADLE_PERF_DEFAULTS = [
    { flag: '--daemon', conflicts: ['--daemon', '--no-daemon'] },
    { flag: '--parallel', conflicts: ['--parallel', '--no-parallel'] },
    { flag: '--build-cache', conflicts: ['--build-cache', '--no-build-cache'] },
    { flag: '--configuration-cache', conflicts: ['--configuration-cache', '--no-configuration-cache'] },
    // Never let an incompatible build FAIL just because of config-cache: warn + continue.
    { flag: '--configuration-cache-problems=warn', conflicts: ['--configuration-cache-problems'] },
];
function appliedOptimizations(extraArgs, optimize) {
    if (!optimize) {
        return [];
    }
    const applied = [];
    for (const { flag, conflicts } of GRADLE_PERF_DEFAULTS) {
        const already = extraArgs.some(a => conflicts.some(c => a === c || a.startsWith(c + '=')));
        if (!already) {
            applied.push(flag);
        }
    }
    return applied;
}
function buildGradleSpawnArgs(tasks, extraArgs, offline, optimize) {
    const args = [...tasks, '--console=plain'];
    if (offline) {
        args.push('--offline');
    }
    args.push(...extraArgs);
    args.push(...appliedOptimizations(extraArgs, optimize));
    if (!args.includes('--stacktrace') && !args.includes('--full-stacktrace')) {
        args.push('--stacktrace');
    }
    return args;
}
function spawnGradleRun(run, gradlew, spawnArgs, timeoutMs) {
    const proc = childProcess.spawn(gradlew, spawnArgs, {
        cwd: run.cwd,
        env: { ...process.env, TERM: 'dumb', GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ''} -Dorg.gradle.console=plain`, ...run.extraEnv },
    });
    run.proc = proc;
    const onData = (c) => {
        if (run.size < GRADLE_MAX_BUFFER) {
            run.chunks.push(c);
            run.size += c.length;
        }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => {
        run.killReason = 'timeout';
        try {
            proc.kill('SIGKILL');
        }
        catch { /* already gone */ }
    }, timeoutMs);
    const finish = () => {
        clearTimeout(timer);
        run.endTime = Date.now();
        recordGradleRun(run);
        run.resolvePromise();
    };
    proc.on('error', (err) => {
        if (run.state === 'RUNNING') {
            run.state = 'FAILED';
            run.chunks.push(Buffer.from(`\nError spawning gradlew: ${err.message}`));
        }
        finish();
    });
    proc.on('close', (code) => {
        if (run.state === 'RUNNING') {
            run.exitCode = code;
            run.state = run.killReason === 'timeout' ? 'TIMEOUT'
                : run.killReason === 'stop' ? 'CANCELLED'
                    : code === 0 ? 'SUCCESS' : 'FAILED';
        }
        finish();
    });
}
function getRunBuffer(run) {
    return Buffer.concat(run.chunks).toString();
}
function parseRunStatus(raw, isTerminal) {
    const lines = raw.split(/\r?\n/);
    const taskRe = /^> Task (:\S+)/;
    const terminalRe = /\s+(FAILED|UP-TO-DATE|FROM-CACHE|SKIPPED|NO-SOURCE)\s*$/;
    const ordered = [];
    const terminals = new Map();
    for (const line of lines) {
        const m = line.match(taskRe);
        if (!m) {
            continue;
        }
        const task = m[1];
        if (!ordered.includes(task)) {
            ordered.push(task);
        }
        const t = line.match(terminalRe);
        if (t) {
            terminals.set(task, t[1]);
        }
    }
    const failedTasks = ordered.filter(t => terminals.get(t) === 'FAILED');
    // A bare `> Task :x` (no marker) means the task EXECUTED — it is only still
    // "running" if it is the last task seen AND the build has not terminated yet.
    // Once a later task appears, or the build reaches a terminal state, every
    // preceding task is complete.
    const lastTask = ordered[ordered.length - 1];
    const runningTasks = (!isTerminal && lastTask && !terminals.has(lastTask)) ? [lastTask] : [];
    return {
        completedTasks: ordered.length - runningTasks.length,
        runningTasks,
        failedTasks,
    };
}
function extractFailureFields(raw) {
    const lines = raw.split(/\r?\n/);
    let whatWentWrong = null;
    for (let i = 0; i < lines.length; i++) {
        if (/^\* What went wrong:/.test(lines[i])) {
            const block = [];
            for (let j = i + 1; j < lines.length && j < i + 40; j++) {
                if (/^\* (Try|Exception is|Get more help):/.test(lines[j]) || /^BUILD /.test(lines[j])) {
                    break;
                }
                block.push(lines[j]);
            }
            whatWentWrong = block.join('\n').trim() || null;
            break;
        }
    }
    return {
        whatWentWrong,
        exception: [...new Set(lines.filter(l => /^\s*Caused by: /.test(l)).map(l => l.trim()))].slice(0, 10),
        errors: [...new Set(lines.filter(l => /(^|\s)(error:|e: )/.test(l) || /\.(java|kt|kts):\d+:.*error/i.test(l)).map(l => l.trim()))].slice(0, 30),
        testFailures: [...new Set(lines.filter(l => / > .*FAILED\s*$/.test(l) && !/> Task :/.test(l)).map(l => l.trim()))].slice(0, 30),
    };
}
// Returns the log lines for a run, optionally narrowed to a single task's block
// (header `> Task :x` + its output). The caller decides tail vs forward paging.
function collectLogLines(raw, task) {
    const lines = raw.split('\n');
    if (!task) {
        return lines;
    }
    let capturing = false;
    let header = '';
    const body = [];
    for (const line of lines) {
        if (/^> Task /.test(line)) {
            if (line.includes(task)) {
                // Re-anchor on the latest matching occurrence so we return the
                // final execution of the task rather than an earlier one.
                capturing = true;
                header = line;
                body.length = 0;
            }
            else if (capturing) {
                break;
            }
        }
        else if (capturing) {
            body.push(line);
        }
    }
    if (!header) {
        return [`No output found for task "${task}"`];
    }
    return [header, ...body];
}
function toRelative(root, target) {
    const rel = path.relative(root, target);
    return rel && !rel.startsWith('..') ? rel : target;
}
function decodeXmlEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#10;/g, '\n').replace(/&#9;/g, '\t')
        .replace(/&amp;/g, '&');
}
// For failed `test`-style tasks, read the JUnit XML reports so the agent gets the
// actual assertion message + source location (Gradle's console only prints an
// internal stacktrace and points at an HTML file). Task path → module dir:
// ":service:test" → <cwd>/service/build/test-results/test/TEST-*.xml.
function extractTestReportFailures(cwd, failedTasks) {
    const out = [];
    const frameworkNoise = /junit|opentest4j|kotlin\.coroutines|kotlinx\.coroutines|java\.base|reflect\.Method|AssertionUtils|AssertEquals|Assertions\./;
    for (const task of failedTasks) {
        const segs = task.replace(/^:/, '').split(':').filter(Boolean);
        const taskName = segs.pop();
        if (!taskName || !/test/i.test(taskName)) {
            continue;
        }
        const dir = path.join(cwd, ...segs, 'build', 'test-results', taskName);
        let files;
        try {
            files = fs.readdirSync(dir).filter(f => /^TEST-.*\.xml$/.test(f));
        }
        catch {
            continue;
        }
        for (const file of files) {
            let xml;
            try {
                xml = fs.readFileSync(path.join(dir, file), 'utf8');
            }
            catch {
                continue;
            }
            const caseRe = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
            let m;
            while ((m = caseRe.exec(xml)) && out.length < 50) {
                const attrs = m[1];
                const fm = m[2].match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/);
                if (!fm) {
                    continue;
                }
                const name = (attrs.match(/\bname="([^"]*)"/) || [])[1] ?? '?';
                const className = (attrs.match(/\bclassname="([^"]*)"/) || [])[1] ?? '';
                const rawMsg = (fm[2].match(/\bmessage="([^"]*)"/) || [])[1] ?? '';
                const message = decodeXmlEntities(rawMsg).split('\n')[0].slice(0, 500);
                const body = decodeXmlEntities(fm[3]);
                const bodyLines = body.split('\n').map(l => l.trim()).filter(Boolean);
                const appFrame = bodyLines
                    .find(l => /\bat .*\.(kt|java):\d+\)/.test(l) && !frameworkNoise.test(l));
                const location = appFrame ? ((appFrame.match(/\(([^)]+:\d+)\)/) || [])[1] ?? null) : null;
                // Compact stack: the exception line(s) + the meaningful (non-framework)
                // frames first, so the agent sees where the failure originates.
                const frames = bodyLines.filter(l => /^\s*at /.test(l));
                const appFrames = frames.filter(l => !frameworkNoise.test(l));
                const stack = [
                    ...bodyLines.filter(l => !/^\s*at /.test(l)).slice(0, 4),
                    ...(appFrames.length ? appFrames : frames).slice(0, 15),
                ].join('\n').slice(0, 2500);
                out.push({ test: decodeXmlEntities(name), className: decodeXmlEntities(className), message, location, stack });
            }
        }
    }
    return out;
}
function runToStatus(run, root) {
    const raw = getRunBuffer(run);
    const { completedTasks, runningTasks, failedTasks } = parseRunStatus(raw, run.state !== 'RUNNING');
    const result = {
        buildId: run.id,
        state: run.state,
        tasks: run.tasks,
        cwd: toRelative(root, run.cwd),
        completedTasks,
        runningTasks,
        elapsedSec: Math.round(((run.endTime ?? Date.now()) - run.startTime) / 1000),
    };
    if (run.state === 'FAILED' || run.state === 'TIMEOUT') {
        const f = extractFailureFields(raw);
        // Combine tasks flagged `> Task :x FAILED` with any named in Gradle's
        // "Execution failed for task ':x'." messages, so the agent always gets a
        // task name to query logs for (even when no FAILED marker was printed).
        const execFailed = [...new Set([...raw.matchAll(/Execution failed for task '(:[^']+)'/g)].map(m => m[1]))];
        const allFailed = [...new Set([...failedTasks, ...execFailed])];
        const primary = allFailed[0];
        const testFailureDetails = extractTestReportFailures(run.cwd, allFailed);
        Object.assign(result, {
            failedTasks: allFailed,
            whatWentWrong: f.whatWentWrong,
            exception: f.exception,
            errors: f.errors,
            testFailures: f.testFailures,
            testFailureDetails,
            exitCode: run.exitCode,
            // Direct pointer so the agent can pull just the failing task's output.
            failedTaskLogsHint: primary
                ? `Get the failing task's log: gradle {action:"logs", buildId:"${run.id}", task:"${primary}"}`
                : `Get the full tail: gradle {action:"logs", buildId:"${run.id}"}`,
        });
    }
    else if (run.state === 'SUCCESS') {
        result.exitCode = run.exitCode;
    }
    return result;
}
function handleGradleStart(input, root) {
    const startDir = input.projectDir
        ? (path.isAbsolute(input.projectDir) ? input.projectDir : path.join(root, input.projectDir))
        : root;
    const gradlew = findGradlew(startDir);
    if (!gradlew) {
        return { error: `No gradlew found in "${startDir}" or its parents. Set projectDir to the module containing gradlew.` };
    }
    const cwd = path.dirname(gradlew);
    const tasks = (input.tasks ?? ['build']).filter(Boolean);
    const extraArgs = (input.arguments ?? []).filter(Boolean);
    const optimize = input.optimize !== false;
    const optimizations = appliedOptimizations(extraArgs, optimize);
    const spawnArgs = buildGradleSpawnArgs(tasks, extraArgs, !!input.offline, optimize);
    const timeoutMs = typeof input.timeoutMs === 'number'
        ? Math.max(30000, Math.min(1800000, input.timeoutMs))
        : GRADLE_SAFETY_TIMEOUT_MS;
    pruneGradleRuns();
    const id = `b${++gradleIdCounter}`;
    let resolveDone;
    const donePromise = new Promise(res => { resolveDone = res; });
    const run = {
        id, proc: null, cwd, tasks, extraArgs,
        extraEnv: input.env ?? {},
        startTime: Date.now(), endTime: undefined,
        state: 'RUNNING', exitCode: null,
        chunks: [], size: 0, killReason: undefined,
        optimizations, logged: false,
        donePromise, resolvePromise: resolveDone,
    };
    gradleRuns.set(id, run);
    spawnGradleRun(run, gradlew, spawnArgs, timeoutMs);
    return { buildId: id, state: 'RUNNING', tasks, cwd: toRelative(root, cwd), optimizations };
}
function handleGradleStatus(input, root) {
    const run = gradleRuns.get(input.buildId ?? '');
    if (!run) {
        return { error: `Unknown buildId "${input.buildId}". Use gradle {action:"start"} first.` };
    }
    return runToStatus(run, root);
}
async function handleGradleWait(input, root) {
    const run = gradleRuns.get(input.buildId ?? '');
    if (!run) {
        return { error: `Unknown buildId "${input.buildId}".` };
    }
    if (run.state !== 'RUNNING') {
        return runToStatus(run, root);
    }
    const timeoutMs = typeof input.timeoutMs === 'number'
        ? Math.max(1000, Math.min(1800000, input.timeoutMs))
        : 120000;
    // Opt-in "ready" detection for long-running tasks (servers, watch, --continuous):
    // the task never terminates, so wait returns as soon as readyPattern appears in
    // the output (ready:true) — otherwise on terminal state or timeout (ready:false).
    if (input.readyPattern) {
        let re;
        try {
            re = new RegExp(input.readyPattern);
        }
        catch (e) {
            return { error: `Invalid readyPattern regex: ${e.message}` };
        }
        const deadline = Date.now() + timeoutMs;
        while (run.state === 'RUNNING' && Date.now() < deadline) {
            if (re.test(getRunBuffer(run))) {
                return { ...runToStatus(run, root), ready: true };
            }
            await Promise.race([run.donePromise, new Promise(res => setTimeout(res, 400))]);
        }
        return { ...runToStatus(run, root), ready: re.test(getRunBuffer(run)) };
    }
    await Promise.race([run.donePromise, new Promise(res => setTimeout(res, timeoutMs))]);
    return runToStatus(run, root);
}
function handleGradleStop(input) {
    const run = gradleRuns.get(input.buildId ?? '');
    if (!run) {
        return { error: `Unknown buildId "${input.buildId}".` };
    }
    if (run.state !== 'RUNNING') {
        return { buildId: run.id, state: run.state, note: 'Build already finished' };
    }
    run.killReason = 'stop';
    try {
        run.proc?.kill('SIGKILL');
    }
    catch { /* already gone */ }
    return { buildId: run.id, state: 'CANCELLED' };
}
function handleGradleLogs(input) {
    const run = gradleRuns.get(input.buildId ?? '');
    if (!run) {
        return { error: `Unknown buildId "${input.buildId}".` };
    }
    const allLines = collectLogLines(getRunBuffer(run), input.task);
    const totalLines = allLines.length;
    // Forward pagination (good for streaming a long-running task / server):
    // pass fromLine to read [fromLine, fromLine+maxLines) and use the returned
    // nextFromLine as the cursor for the next call. Omit fromLine for a tail.
    if (typeof input.fromLine === 'number') {
        const from = Math.max(0, Math.min(input.fromLine, totalLines));
        const size = typeof input.maxLines === 'number' ? Math.max(1, Math.min(1000, input.maxLines)) : 200;
        const slice = allLines.slice(from, from + size);
        const toLine = from + slice.length;
        return {
            buildId: run.id, state: run.state, task: input.task ?? null,
            fromLine: from, toLine, totalLines,
            nextFromLine: toLine, hasMore: toLine < totalLines,
            log: slice.join('\n'),
        };
    }
    const tail = typeof input.tail === 'number' ? Math.max(10, Math.min(500, input.tail)) : 120;
    const start = Math.max(0, totalLines - tail);
    return {
        buildId: run.id, state: run.state, task: input.task ?? null,
        fromLine: start, toLine: totalLines, totalLines,
        nextFromLine: totalLines, hasMore: false,
        log: allLines.slice(start).join('\n'),
    };
}
/**
 * Dispatch a gradle action. `root` is the base directory used to resolve a
 * relative `projectDir` and to relativize paths in the result (defaults to
 * process.cwd()).
 */
async function dispatchGradle(input, root = process.cwd()) {
    switch (input.action) {
        case 'start': return handleGradleStart(input, root);
        case 'status': return handleGradleStatus(input, root);
        case 'wait': return handleGradleWait(input, root);
        case 'stop': return handleGradleStop(input);
        case 'logs': return handleGradleLogs(input);
        default: return { error: `Unknown action "${input.action}". Valid: start|status|stop|logs|wait.` };
    }
}
/** Kill every still-running build. Call on host shutdown. */
function killAllGradleRuns() {
    for (const run of gradleRuns.values()) {
        if (run.state === 'RUNNING') {
            try {
                run.proc?.kill('SIGKILL');
            }
            catch { /* already gone */ }
        }
    }
}

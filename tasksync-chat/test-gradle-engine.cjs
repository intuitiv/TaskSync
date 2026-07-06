// Standalone lifecycle test for the VS Code-free Gradle engine.
// Run: node test-gradle-engine.cjs
// Requires the engine compiled to ./.gradle-test-build/gradle/gradleEngine.js
//
// NOTE: the target project has a slow (~100s) configuration phase, so waits are
// generous and the Gradle daemon is kept warm (no --no-daemon) so later actions
// reuse the configured build. Do NOT pkill gradle while this runs.

const path = require('path');
const enginePath = path.join(__dirname, '.gradle-test-build', 'gradle', 'gradleEngine.js');
const { dispatchGradle } = require(enginePath);

const PROJECT = '/Users/machs/VSProjects/model-calculation-service-app-logic';
const JAVA_HOME = '/Users/machs/Library/Java/JavaVirtualMachines/corretto-17.0.5/Contents/Home';
const ENV = { JAVA_HOME };
const WAIT_MS = 600000; // 10 min ceiling per build

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function pollUntilDone(buildId, label) {
    let sawRunning = false, maxCompleted = 0, last = null;
    for (let i = 0; i < 320; i++) {
        const st = await dispatchGradle({ action: 'status', buildId }, PROJECT);
        last = st;
        if (st.state === 'RUNNING') sawRunning = true;
        if (typeof st.completedTasks === 'number') maxCompleted = Math.max(maxCompleted, st.completedTasks);
        if (i % 5 === 0 || st.state !== 'RUNNING') {
            console.log(`  [${label}] status[${i}] state=${st.state} completed=${st.completedTasks} running=${JSON.stringify(st.runningTasks)} elapsed=${st.elapsedSec}s`);
        }
        if (st.state !== 'RUNNING') break;
        await sleep(2000);
    }
    return { sawRunning, maxCompleted, last };
}

async function testErrorHandling() {
    console.log('\n=== TEST 1: error paths (unknown buildId, no gradlew) ===');
    const badId = await dispatchGradle({ action: 'status', buildId: 'nope' }, PROJECT);
    check('unknown buildId returns error', typeof badId.error === 'string');
    const noGradlew = await dispatchGradle({ action: 'start', projectDir: '/tmp', tasks: ['help'] }, '/tmp');
    check('missing gradlew returns error', typeof noGradlew.error === 'string');
}

async function testStop() {
    console.log('\n=== TEST 2: start → stop → CANCELLED ===');
    const started = await dispatchGradle({
        action: 'start', projectDir: PROJECT,
        tasks: ['clean', ':service:compileTestKotlin'],
        arguments: ['--rerun-tasks'], env: ENV,
    }, PROJECT);
    console.log('  start →', JSON.stringify(started));
    check('start returns buildId', typeof started.buildId === 'string');
    check('start state RUNNING', started.state === 'RUNNING');
    await sleep(4000);
    const mid = await dispatchGradle({ action: 'status', buildId: started.buildId }, PROJECT);
    console.log('  mid status:', mid.state, 'completed=', mid.completedTasks);
    const stopped = await dispatchGradle({ action: 'stop', buildId: started.buildId }, PROJECT);
    console.log('  stop →', JSON.stringify(stopped));
    check('stop reports CANCELLED', stopped.state === 'CANCELLED', `got ${stopped.state}`);
    await sleep(1500);
    const after = await dispatchGradle({ action: 'status', buildId: started.buildId }, PROJECT);
    check('post-stop status CANCELLED', after.state === 'CANCELLED', `got ${after.state}`);
}

async function testSuccess() {
    console.log('\n=== TEST 3: start → status tracking → wait → logs (SUCCESS path) ===');
    // `help` configures the whole build then runs the :help task → BUILD SUCCESSFUL.
    const started = await dispatchGradle({
        action: 'start', projectDir: PROJECT, tasks: ['help'], env: ENV,
    }, PROJECT);
    console.log('  start →', JSON.stringify(started));
    check('start returns buildId', typeof started.buildId === 'string');
    const buildId = started.buildId;
    const { sawRunning, maxCompleted } = await pollUntilDone(buildId, 'success');
    check('observed RUNNING state', sawRunning);

    const done = await dispatchGradle({ action: 'wait', buildId, timeoutMs: WAIT_MS }, PROJECT);
    console.log('  wait →', done.state, 'exitCode=', done.exitCode, 'completed=', done.completedTasks, 'elapsed=', done.elapsedSec + 's');
    check('wait terminal state SUCCESS', done.state === 'SUCCESS', `got ${done.state}`);
    check('wait exitCode 0', done.exitCode === 0, `got ${done.exitCode}`);
    check('completedTasks advanced > 0', (done.completedTasks || maxCompleted) > 0, `max=${Math.max(maxCompleted, done.completedTasks || 0)}`);

    const logsFull = await dispatchGradle({ action: 'logs', buildId, tail: 60 }, PROJECT);
    check('logs full returns text', typeof logsFull.log === 'string' && logsFull.log.length > 0);
    check('logs contain BUILD SUCCESSFUL', /BUILD SUCCESSFUL/.test(logsFull.log), 'no BUILD SUCCESSFUL marker');

    const logsTask = await dispatchGradle({ action: 'logs', buildId, task: ':help', tail: 20 }, PROJECT);
    console.log('  logs[:help] first line:', (logsTask.log || '').split('\n')[0]);
    check('task-filtered logs mention :help', /:help/.test(logsTask.log));
}

async function testFailureExtraction() {
    console.log('\n=== TEST 4: failure → error extraction (FAILED path) ===');
    // A bogus task name fails during task selection (no compilation needed → fast),
    // reusing the warm daemon from TEST 3.
    const started = await dispatchGradle({
        action: 'start', projectDir: PROJECT, tasks: [':service:bogusTaskXYZ'], env: ENV,
    }, PROJECT);
    console.log('  start →', JSON.stringify(started));
    const buildId = started.buildId;
    await pollUntilDone(buildId, 'failure');
    const done = await dispatchGradle({ action: 'wait', buildId, timeoutMs: WAIT_MS }, PROJECT);
    console.log('  final →', JSON.stringify({ state: done.state, exitCode: done.exitCode, failedTasks: done.failedTasks }));
    console.log('  whatWentWrong:', done.whatWentWrong);
    check('failed build state FAILED', done.state === 'FAILED', `got ${done.state}`);
    check('non-zero exitCode', typeof done.exitCode === 'number' && done.exitCode !== 0, `got ${done.exitCode}`);
    check('whatWentWrong populated', typeof done.whatWentWrong === 'string' && done.whatWentWrong.length > 0);
    check('failedTasks array present', Array.isArray(done.failedTasks));
    check('exception array present', Array.isArray(done.exception));
    check('testFailures array present', Array.isArray(done.testFailures));

    const errLogs = await dispatchGradle({ action: 'logs', buildId, tail: 30 }, PROJECT);
    check('failure logs contain BUILD FAILED', /BUILD FAILED/.test(errLogs.log), 'no BUILD FAILED marker');
}

(async () => {
    console.log('Gradle engine lifecycle test');
    console.log('Project:', PROJECT);
    try {
        await testErrorHandling();
        await testStop();
        await testSuccess();
        await testFailureExtraction();
    } catch (e) {
        console.error('FATAL', e);
        fail++;
    }
    console.log(`\n──────── RESULT: ${pass} passed, ${fail} failed ────────`);
    process.exit(fail === 0 ? 0 : 1);
})();

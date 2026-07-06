// Drives the real gradle-tool engine (dispatchGradle) against a live task,
// exactly as the MCP `gradle` tool does. Demonstrates start/status/wait/logs.
const path = require('path');
const { dispatchGradle } = require(path.join(__dirname, '.gradle-test-build', 'gradle', 'gradleEngine.js'));

const PROJECT = '/Users/machs/VSProjects/model-calculation-service-app-logic';
const ENV = { JAVA_HOME: '/Users/machs/Library/Java/JavaVirtualMachines/corretto-17.0.5/Contents/Home' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log('== gradle tool: start ==');
    const started = await dispatchGradle({
        action: 'start',
        projectDir: PROJECT,
        tasks: [':service:test'],
        arguments: ['--tests', 'ForgePipelineIntegrationTest'],
        env: ENV,
    }, PROJECT);
    console.log(JSON.stringify(started));
    const buildId = started.buildId;
    if (!buildId) { process.exit(2); }

    console.log('\n== gradle tool: status polling ==');
    for (let i = 0; i < 400; i++) {
        const st = await dispatchGradle({ action: 'status', buildId }, PROJECT);
        if (i % 5 === 0 || st.state !== 'RUNNING') {
            console.log(`[${i}] state=${st.state} completed=${st.completedTasks} running=${JSON.stringify(st.runningTasks)} elapsed=${st.elapsedSec}s`);
        }
        if (st.state !== 'RUNNING') { break; }
        await sleep(3000);
    }

    console.log('\n== gradle tool: wait (terminal) ==');
    const done = await dispatchGradle({ action: 'wait', buildId, timeoutMs: 900000 }, PROJECT);
    console.log(JSON.stringify({
        state: done.state, exitCode: done.exitCode, completedTasks: done.completedTasks,
        failedTasks: done.failedTasks, elapsedSec: done.elapsedSec,
    }, null, 2));
    if (done.whatWentWrong) { console.log('whatWentWrong:', done.whatWentWrong); }
    if (done.testFailures && done.testFailures.length) { console.log('testFailures:', JSON.stringify(done.testFailures, null, 2)); }
    if (done.errors && done.errors.length) { console.log('errors:', JSON.stringify(done.errors.slice(0, 10), null, 2)); }

    console.log('\n== gradle tool: logs (:service:test, tail 40) ==');
    const logs = await dispatchGradle({ action: 'logs', buildId, task: ':service:test', tail: 40 }, PROJECT);
    console.log(logs.log);

    console.log('\n== gradle tool: logs (full tail 25) ==');
    const full = await dispatchGradle({ action: 'logs', buildId, tail: 25 }, PROJECT);
    console.log(full.log);

    process.exit(done.state === 'SUCCESS' ? 0 : 1);
})();
